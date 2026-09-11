import test from 'node:test';
import assert from 'node:assert/strict';
import {sizeBuy, portfolioView} from '../src/sizing.mjs';

const book = 1000;

test('a strong call can become most of the book, in steps', () => {
  // Target 60% of $1000 = $600. First cycle adds one step of 25% = $250.
  let held = 0;
  const s1 = sizeBuy({portfolioUsd: book, currentUsd: held, remainingUsd: 1000, targetWeightPercent: 60});
  assert.equal(s1.usd, 250); held += s1.usd;
  const s2 = sizeBuy({portfolioUsd: book, currentUsd: held, remainingUsd: 750, targetWeightPercent: 60});
  assert.equal(s2.usd, 250); held += s2.usd;
  const s3 = sizeBuy({portfolioUsd: book, currentUsd: held, remainingUsd: 500, targetWeightPercent: 60});
  assert.equal(s3.usd, 100, 'last step only closes the gap to the target'); held += s3.usd;
  const s4 = sizeBuy({portfolioUsd: book, currentUsd: held, remainingUsd: 400, targetWeightPercent: 60});
  assert.equal(s4.usd, 0); assert.match(s4.reason, /at or above target/);
});

test('the operator ceiling binds even when the model wants more', () => {
  const s = sizeBuy({portfolioUsd: book, currentUsd: 0, remainingUsd: 1000, targetWeightPercent: 95, sizing: {maxPositionPercent: 60, maxOrderPercent: 100}});
  assert.equal(s.targetPercent, 60);
  assert.equal(s.usd, 600);
});

test('no target from the model falls back to conviction, and null is not zero', () => {
  const none = sizeBuy({portfolioUsd: book, currentUsd: 0, remainingUsd: 1000, targetWeightPercent: null, conviction: 80});
  assert.equal(none.targetPercent, 48, '80% of the 60% ceiling');
  assert.ok(none.usd > 0);
  const zero = sizeBuy({portfolioUsd: book, currentUsd: 0, remainingUsd: 1000, targetWeightPercent: 0, conviction: 80});
  assert.equal(zero.usd, 0, 'an explicit zero is respected');
});

test('sizing scales with the book, not a fixed dollar amount', () => {
  const small = sizeBuy({portfolioUsd: 250, currentUsd: 0, remainingUsd: 250, targetWeightPercent: 40});
  const big = sizeBuy({portfolioUsd: 25000, currentUsd: 0, remainingUsd: 25000, targetWeightPercent: 40});
  assert.equal(small.usd, 62.5);
  assert.equal(big.usd, 6250);
});

test('a marginal idea stays small and a sub-minimum step is skipped', () => {
  const s = sizeBuy({portfolioUsd: book, currentUsd: 0, remainingUsd: 1000, targetWeightPercent: 5});
  assert.equal(s.usd, 50);
  const dust = sizeBuy({portfolioUsd: 40, currentUsd: 0, remainingUsd: 40, targetWeightPercent: 5});
  assert.equal(dust.usd, 0); assert.match(dust.reason, /minimum/);
});

test('an optional hard dollar cap still applies when set', () => {
  const s = sizeBuy({portfolioUsd: book, currentUsd: 0, remainingUsd: 1000, targetWeightPercent: 60, maxOrderUsd: 30});
  assert.equal(s.usd, 30);
});

test('the portfolio view gives the model weights, not just names', () => {
  const v = portfolioView({room: 400, held: {totalUsd: 600, rows: [
    {symbol: 'NVDA', valueUsd: 450, unrealizedPercent: 12.5, thesis: 'capex'},
    {symbol: 'TSLA', valueUsd: 150, unrealizedPercent: -3, thesis: 'deliveries'},
  ]}});
  assert.equal(v.portfolioUsd, 1000);
  assert.equal(v.cashPercent, 40);
  assert.equal(v.positions[0].symbol, 'NVDA');
  assert.equal(v.positions[0].weightPercent, 45);
  assert.equal(v.limits.maxPositionPercent, 60);
});
