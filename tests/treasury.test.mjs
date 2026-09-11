import test from 'node:test';
import assert from 'node:assert/strict';
import {assertZzyDisposalBlocked, ZzySellAttemptError, planFeeClaim, zzyHeldForever} from '../src/treasury.mjs';
import {deployable as tradingCapital} from '../src/profit.mjs';

const config = {
  policy: {maxTotalExposureUsd: 250},
  treasury: {zzyTokenAddress: '0xTESTTOKEN', buybackShareBps: 5000, tradingShareBps: 5000, ledgerPath: 'treasury/test-ledger.json'},
};

test('every $ZZY disposal action is permanently refused', () => {
  for (const action of ['SELL', 'sell', 'SWAP_OUT', 'TRANSFER_OUT', 'WITHDRAW', 'BURN', 'BRIDGE_OUT', 'APPROVE_SPEND']) {
    assert.throws(() => assertZzyDisposalBlocked(action), ZzySellAttemptError, `${action} should be blocked`);
  }
});

test('BUY is the one permitted $ZZY action', () => {
  assert.equal(assertZzyDisposalBlocked('BUY'), true);
});

test('the sell block cannot be disabled by config', () => {
  // Nothing in config is consulted by the invariant -- prove it by passing a
  // config that tries every plausible override name.
  const hostile = {treasury: {allowSell: true, sellEnabled: true, NEVER_SELL_ZZY: false, emergencyOverride: true}};
  assert.throws(() => assertZzyDisposalBlocked('SELL', hostile), ZzySellAttemptError);
});

test('a fee claim splits 50/50 and never rounds buyback upward', () => {
  const plan = planFeeClaim(100, config);
  assert.equal(plan.buyback.amountUsd, 50);
  assert.equal(plan.trading.amountUsd, 50);
  assert.equal(plan.buyback.action, 'BUY');
  assert.equal(plan.executed, false);
});

test('an odd claim gives the rounding remainder to trading, never to buyback', () => {
  const plan = planFeeClaim(0.03333333, config);
  assert.ok(plan.buyback.amountUsd <= 0.03333333 / 2);
  assert.equal(Number((plan.buyback.amountUsd + plan.trading.amountUsd).toFixed(8)), 0.03333333);
});

test('shares that do not sum to 10000 bps are a hard error, never silently normalized', () => {
  const bad = {...config, treasury: {...config.treasury, buybackShareBps: 5000, tradingShareBps: 4000}};
  assert.throws(() => planFeeClaim(100, bad), /must equal exactly 10000/);
});

test('a missing $ZZY token address refuses to plan a buyback', () => {
  const bad = {...config, treasury: {...config.treasury, zzyTokenAddress: null}};
  assert.throws(() => planFeeClaim(100, bad), /zzyTokenAddress is not configured/);
});

test('realized losses shrink deployable capital rather than being ignored', () => {
  const ledger = {entries: [
    {type: 'fee-claim', claimUsd: 100, buybackUsd: 50, tradingUsd: 50},
    {type: 'realized-pnl', amountUsd: -20},
  ]};
  const capital = tradingCapital(ledger, config);
  assert.equal(capital.principalUsd, 50);
  assert.equal(capital.realisedPnlUsd, -20);
  assert.equal(capital.deployableUsd, 30);
});

test('compounding profit is capped by policy.maxTotalExposureUsd, never unbounded', () => {
  const ledger = {entries: [
    {type: 'fee-claim', claimUsd: 1000, buybackUsd: 500, tradingUsd: 500},
    {type: 'realized-pnl', amountUsd: 5000},
  ]};
  const capital = tradingCapital(ledger, config);
  assert.equal(capital.bookValueUsd, 5500);
  assert.equal(capital.deployableUsd, 250, 'the policy ceiling must bind regardless of profits');
  assert.equal(capital.cappedByPolicy, true);
});

test('the $ZZY position reports as never sold and never sellable', () => {
  const ledger = {entries: [{type: 'fee-claim', claimUsd: 100, buybackUsd: 50, tradingUsd: 50}]};
  const held = zzyHeldForever(ledger);
  assert.equal(held.totalBoughtUsd, 50);
  assert.equal(held.everSold, false);
  assert.equal(held.sellPossible, false);
});
