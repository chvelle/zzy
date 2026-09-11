import test from 'node:test';
import assert from 'node:assert/strict';
import {bookState, planProfitSweep, deployable, DEFAULT_PROFIT} from '../src/profit.mjs';

const L = (...entries) => ({schemaVersion:1, entries});
const claim = (tradingUsd) => ({type:'fee-claim', tradingUsd, buybackUsd: tradingUsd});
const pnl = (amountUsd) => ({type:'realized-pnl', amountUsd});
const swept = (amountUsd) => ({type:'profit-sweep', amountUsd});

test('principal only grows from fee claims, never from profit', () => {
  const s = bookState(L(claim(500), pnl(300)));
  assert.equal(s.principalUsd, 500, 'profit must not inflate principal');
  assert.equal(s.realisedPnlUsd, 300);
  assert.equal(s.bookValueUsd, 800);
});

test('losses reduce the book but leave principal alone', () => {
  const s = bookState(L(claim(500), pnl(-120)));
  assert.equal(s.principalUsd, 500);
  assert.equal(s.bookValueUsd, 380);
  assert.equal(s.sweepableUsd, 0, 'nothing to sweep from a book under water');
});

test('compound mode never sweeps, however large the book gets', () => {
  const cfg = {profitPolicy:{mode:'compound'}};
  const s = bookState(L(claim(500), pnl(50000)), cfg);
  assert.equal(s.sweepableUsd, 0);
  assert.equal(planProfitSweep(L(claim(500), pnl(50000)), cfg), null);
});

test('buyback mode sweeps everything above principal', () => {
  const cfg = {profitPolicy:{mode:'buyback'}};
  const s = bookState(L(claim(500), pnl(300)), cfg);
  assert.equal(s.targetUsd, 500);
  assert.equal(s.sweepableUsd, 300);
  assert.equal(planProfitSweep(L(claim(500), pnl(300)), cfg).amountUsd, 300);
});

test('threshold mode compounds to the target, then sweeps the excess', () => {
  const cfg = {profitPolicy:{mode:'threshold', compoundUntilUsd:1000}};
  // under the target: nothing swept, the book keeps compounding
  assert.equal(bookState(L(claim(500), pnl(200)), cfg).sweepableUsd, 0);
  // over the target: only the excess goes
  const over = bookState(L(claim(500), pnl(700)), cfg);
  assert.equal(over.bookValueUsd, 1200);
  assert.equal(over.sweepableUsd, 200);
});

test('a high water mark stops the same profit being swept twice', () => {
  const cfg = {profitPolicy:{mode:'buyback', minSweepUsd:1}};
  // book goes to 800, sweeps 300, then round-trips 120 down and back up
  const led = L(claim(500), pnl(300), swept(300), pnl(-120), pnl(120));
  const s = bookState(led, cfg);
  assert.equal(s.bookValueUsd, 500, 'back at principal, not above it');
  assert.equal(s.sweepableUsd, 0, 'recovered ground is not new profit');
  assert.equal(planProfitSweep(led, cfg), null);
});

test('a sweep too small to be worth the gas is skipped', () => {
  const cfg = {profitPolicy:{mode:'buyback', minSweepUsd:25}};
  assert.equal(planProfitSweep(L(claim(500), pnl(10)), cfg), null);
  assert.ok(planProfitSweep(L(claim(500), pnl(40)), cfg));
});

test('a partial sweep share leaves the rest compounding', () => {
  const cfg = {profitPolicy:{mode:'buyback', sweepShareBps:5000, minSweepUsd:1}};
  const s = bookState(L(claim(500), pnl(400)), cfg);
  assert.equal(s.sweepableUsd, 200, 'half of the 400 profit');
});

test('the exposure ceiling still binds regardless of profit policy', () => {
  const cfg = {profitPolicy:{mode:'compound'}, policy:{maxTotalExposureUsd:250}};
  const d = deployable(L(claim(500), pnl(5000)), cfg);
  assert.equal(d.bookValueUsd, 5500);
  assert.equal(d.deployableUsd, 250, 'the hard ceiling is not raised by profit');
  assert.equal(d.cappedByPolicy, true);
});

test('progress through the compounding phase is reported for display', () => {
  const cfg = {profitPolicy:{mode:'threshold', compoundUntilUsd:1000}};
  assert.equal(bookState(L(claim(500), pnl(0)), cfg).progressPercent, 50);
  assert.equal(bookState(L(claim(500), pnl(500)), cfg).progressPercent, 100);
});

test('an unknown mode is rejected rather than silently defaulting', () => {
  assert.throws(() => planProfitSweep(L(claim(500)), {profitPolicy:{mode:'yolo'}}), /must be one of/);
});

test('the default is threshold, so the book compounds before it pays out', () => {
  assert.equal(DEFAULT_PROFIT.mode, 'threshold');
  assert.ok(DEFAULT_PROFIT.compoundUntilUsd > 0);
});
