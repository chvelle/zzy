import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyStore, recordPrice, moveOverPercent, volatilityScore, series, latestPrice, poolPremiumPercent} from '../src/prices.mjs';
import {evaluateSnapshot} from '../src/policy.mjs';

const at = s => new Date(Date.UTC(2026,8,8,12,0,0) + s*1000);

test('a move needs history, and reports null rather than zero without it', () => {
  const st = emptyStore();
  recordPrice(st, 'NVDA', 100, at(0));
  assert.equal(moveOverPercent(st, 'NVDA', 300, at(0)), null, 'one sample cannot yield a move');
});

test('movement is measured against the sample at the requested age', () => {
  const st = emptyStore();
  recordPrice(st, 'NVDA', 100, at(0));
  recordPrice(st, 'NVDA', 103, at(300));
  const m = moveOverPercent(st, 'NVDA', 300, at(300));
  assert.ok(Math.abs(m - 3) < 1e-9, `expected +3%, got ${m}`);
});

test('a sharp move is now actually caught by the policy gate', () => {
  // This is the bug the price tracker fixes: the move was hardcoded to 0, so
  // this snapshot used to pass the gate no matter how far the price had run.
  const config = {
    assetScope:{allowedAssetClasses:['tokenized-stock'],blockedAssetClasses:['memecoin']},
    catalog:{requireVerified:false},
    policy:{maxSnapshotAgeSeconds:30,maxPriceMovePercent:3,maxOpenOrders:1,maxTotalExposureUsd:250},
  };
  const snap = (move) => ({
    source:'test', observedAt: at(0).toISOString(),
    asset:{symbol:'NVDA', assetClass:'tokenized-stock'},
    market:{priceUsd:100, pricePreviewUsd:100, priceMove5mPercent:move, volume24hUsd:1e6, volatilityScore:20},
    account:{buyingPowerUsd:500, currentExposureUsd:0, openOrders:0},
  });
  assert.ok(evaluateSnapshot(snap(9), config, at(0)).failures.includes('price-move-above-maximum'));
  assert.ok(evaluateSnapshot(snap(-9), config, at(0)).failures.includes('price-move-above-maximum'), 'a crash is a move too');
  assert.equal(evaluateSnapshot(snap(1), config, at(0)).accepted, true);
  // and an unknown move is a failure, not a pass
  assert.ok(evaluateSnapshot(snap(null), config, at(0)).failures.includes('price-history-unavailable'));
});

test('volatility is computed from the series, and is null until there is enough', () => {
  const st = emptyStore();
  for (let i = 0; i < 5; i++) recordPrice(st, 'A', 100, at(i*60));
  assert.equal(volatilityScore(st, 'A'), null, 'too few samples to judge');
  const calm = emptyStore(), wild = emptyStore();
  for (let i = 0; i < 30; i++) {
    recordPrice(calm, 'A', 100 + (i % 2) * 0.05, at(i*60));
    recordPrice(wild, 'A', 100 + (i % 2) * 6, at(i*60));
  }
  assert.ok(volatilityScore(wild, 'A') > volatilityScore(calm, 'A'), 'a jumpy series must score higher');
});

test('old samples are pruned and the newest price is retrievable', () => {
  const st = emptyStore();
  recordPrice(st, 'A', 100, at(0), {maxAgeHours: 1});
  recordPrice(st, 'A', 110, at(7200), {maxAgeHours: 1});   // 2h later
  assert.equal(st.symbols.A.length, 1, 'the stale sample should be dropped');
  assert.equal(latestPrice(st, 'A'), 110);
});

test('a non-positive price is refused rather than recorded', () => {
  assert.throws(() => recordPrice(emptyStore(), 'A', 0, at(0)), /non-positive/);
  assert.throws(() => recordPrice(emptyStore(), 'A', -5, at(0)), /non-positive/);
});

test('the series handed to the research layer is oldest first', () => {
  const st = emptyStore();
  recordPrice(st, 'A', 100, at(0)); recordPrice(st, 'A', 101, at(60)); recordPrice(st, 'A', 102, at(120));
  const s = series(st, 'A');
  assert.deepEqual(s.map(p => p.close), [100, 101, 102]);
});

test('pool premium compares what is paid against what it is quoted at', () => {
  assert.ok(Math.abs(poolPremiumPercent(103, 100) - 3) < 1e-9);
  assert.ok(poolPremiumPercent(97, 100) < 0, 'a discount reads negative');
  assert.equal(poolPremiumPercent(0, 100), null);
  assert.equal(poolPremiumPercent(100, 0), null);
});

test('a short history still yields a move, measured over what is actually there', async () => {
  const {moveDetail} = await import('../src/prices.mjs');
  const st = emptyStore();
  recordPrice(st, 'NVDA', 100, at(0));
  recordPrice(st, 'NVDA', 109, at(60));      // +9% in one minute, only 60s of history
  const d = moveDetail(st, 'NVDA', 300, at(60));
  assert.ok(Math.abs(d.percent - 9) < 1e-9, 'the move is reported, not thrown away');
  assert.equal(d.windowSeconds, 60);
  assert.equal(d.full, false, 'flagged as a shorter window than requested');
});

test('a violent move is caught on the second tick, not five minutes later', () => {
  const config = {
    assetScope:{allowedAssetClasses:['tokenized-stock'],blockedAssetClasses:['memecoin']},
    catalog:{requireVerified:false},
    policy:{maxSnapshotAgeSeconds:30,maxPriceMovePercent:3,maxOpenOrders:1,maxTotalExposureUsd:250},
  };
  const st = emptyStore();
  recordPrice(st, 'NVDA', 100, at(0));
  recordPrice(st, 'NVDA', 109, at(60));
  const snap = {
    source:'test', observedAt: at(60).toISOString(),
    asset:{symbol:'NVDA', assetClass:'tokenized-stock'},
    market:{priceUsd:109, pricePreviewUsd:109, priceMove5mPercent: moveOverPercent(st,'NVDA',300,at(60)), volume24hUsd:1e6, volatilityScore:20},
    account:{buyingPowerUsd:500, currentExposureUsd:0, openOrders:0},
  };
  assert.ok(evaluateSnapshot(snap, config, at(60)).failures.includes('price-move-above-maximum'));
});

test('a single sample is still unknown, not zero', async () => {
  const {moveDetail} = await import('../src/prices.mjs');
  const st = emptyStore();
  recordPrice(st, 'NVDA', 100, at(0));
  assert.equal(moveDetail(st, 'NVDA', 300, at(0)), null);
});
