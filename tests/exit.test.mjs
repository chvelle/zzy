import test from 'node:test';
import assert from 'node:assert/strict';
import {exitGuards, gainPercent, DEFAULT_EXIT} from '../src/exit.mjs';

const pos = (o = {}) => ({symbol:'NVDA', qty:10, costBasisUsd:1000, thesis:'capex cycle intact', falsifier:'guidance cut', ...o});

test('there is no fixed profit threshold in the defaults', () => {
  assert.ok(!('minGainPercent' in DEFAULT_EXIT), 'a fixed profit trigger should not exist');
  assert.ok(!('finalExitGainPercent' in DEFAULT_EXIT));
  assert.ok(!('triggerJitterPercent' in DEFAULT_EXIT));
});

test('an exit that would not clear its own fees is refused, whatever the allocator says', () => {
  // position worth $0.11 in total
  const r = exitGuards(pos({qty:0.1, costBasisUsd:0.10}), 1.1, {});
  assert.equal(r.action, 'HOLD');
  assert.equal(r.source, 'guard');
  assert.match(r.reason, /would not clear its own fees/);
});

test('the stop loss is deterministic and fires before any model is consulted', () => {
  const r = exitGuards(pos(), 70, {});
  assert.equal(r.action, 'CLOSE');
  assert.equal(r.source, 'guard');
  assert.equal(exitGuards(pos(), 70, {exitPolicy: {maxLossPercent: null}}), null, 'disabled, the allocator decides');
});

test('cooldown blocks a second exit on the same name', async () => {
  const now = new Date('2026-09-08T12:00:00Z');
  const r = exitGuards(pos({lastExitAt:'2026-09-08T11:55:00Z'}), 120, {}, {now});
  assert.equal(r.action, 'HOLD');
  assert.match(r.reason, /cooling down/);
});

test('gainPercent rejects positions it cannot value', () => {
  assert.throws(() => gainPercent({qty:0, costBasisUsd:100}, 10), /costBasisUsd and qty/);
  assert.throws(() => gainPercent({qty:1, costBasisUsd:100}, 0), /priceUsd must be positive/);
});
