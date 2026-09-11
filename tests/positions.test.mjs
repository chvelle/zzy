import test from 'node:test';
import assert from 'node:assert/strict';
import {recordBuy, recordSell, valuePositions, listPositions} from '../src/positions.mjs';

const store = () => ({schemaVersion: 1, positions: {}});
const at = new Date('2026-09-09T00:00:00Z');

test('a buy is recorded only against a settled transaction', () => {
  const s = store();
  assert.throws(() => recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 1, costUsd: 100, priceUsd: 100}), /txHash/);
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 1, costUsd: 100, priceUsd: 100, txHash: '0xa', thesis: 'capex', falsifier: 'guidance cut', at});
  assert.equal(listPositions(s).length, 1);
  assert.equal(s.positions.NVDA.thesis, 'capex');
});

test('adding to a position accumulates qty and basis, and keeps the newest thesis', () => {
  const s = store();
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 1, costUsd: 100, priceUsd: 100, txHash: '0xa', thesis: 'old', at});
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 1, costUsd: 120, priceUsd: 120, txHash: '0xb', thesis: 'new', at});
  assert.equal(s.positions.NVDA.qty, 2);
  assert.equal(s.positions.NVDA.costBasisUsd, 220);
  assert.equal(s.positions.NVDA.thesis, 'new');
  assert.equal(s.positions.NVDA.fills.length, 2);
});

test('a partial sell realises proportional P&L and leaves the rest', () => {
  const s = store();
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 2, costUsd: 200, priceUsd: 100, txHash: '0xa', at});
  const r = recordSell(s, {symbol: 'NVDA', qty: 1, proceedsUsd: 130, priceUsd: 130, txHash: '0xb', at});
  assert.equal(r.realizedUsd, 30, 'sold half the basis ($100) for $130');
  assert.equal(r.remainingQty, 1);
  assert.equal(s.positions.NVDA.costBasisUsd, 100, 'the remaining half keeps its basis');
  assert.equal(s.positions.NVDA.lastExitAt, at.toISOString());
});

test('a full sell closes the position and realises against the whole basis', () => {
  const s = store();
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 2, costUsd: 200, priceUsd: 100, txHash: '0xa', at});
  const r = recordSell(s, {symbol: 'NVDA', qty: 2, proceedsUsd: 180, priceUsd: 90, txHash: '0xb', at});
  assert.equal(r.realizedUsd, -20);
  assert.equal(listPositions(s).length, 0);
});

test('selling more than is held is refused', () => {
  const s = store();
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 1, costUsd: 100, priceUsd: 100, txHash: '0xa', at});
  assert.throws(() => recordSell(s, {symbol: 'NVDA', qty: 2, proceedsUsd: 300, priceUsd: 150, txHash: '0xb'}), /exceeds held/);
  assert.throws(() => recordSell(s, {symbol: 'AAPL', qty: 1, proceedsUsd: 1, priceUsd: 1, txHash: '0xb'}), /no open position/);
});

test('valuation marks to the latest price and totals exposure', () => {
  const s = store();
  recordBuy(s, {symbol: 'NVDA', address: '0x1', qty: 2, costUsd: 200, priceUsd: 100, txHash: '0xa', at});
  recordBuy(s, {symbol: 'AAPL', address: '0x2', qty: 1, costUsd: 250, priceUsd: 250, txHash: '0xb', at});
  const v = valuePositions(s, {NVDA: 110, AAPL: 240});
  assert.equal(v.totalUsd, 460);
  assert.equal(v.totalCostUsd, 450);
  const nvda = v.rows.find(r => r.symbol === 'NVDA');
  assert.equal(nvda.unrealizedUsd, 20);
  assert.ok(Math.abs(nvda.unrealizedPercent - 10) < 1e-9);
});
