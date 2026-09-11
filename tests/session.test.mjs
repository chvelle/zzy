import test from 'node:test';
import assert from 'node:assert/strict';
import {sessionAt} from '../src/session.mjs';
import {interestScore} from '../src/intel.mjs';

const et = (iso) => new Date(iso);   // ISO with explicit offset

test('session phases follow the NYSE clock in Eastern time', () => {
  assert.equal(sessionAt(et('2026-09-09T14:00:00-04:00')).phase, 'regular');     // Wed 2pm ET
  assert.equal(sessionAt(et('2026-09-09T20:50:00-04:00')).phase, 'closed');      // Wed 8:50pm ET, what the user saw
  assert.equal(sessionAt(et('2026-09-09T17:00:00-04:00')).phase, 'afterhours');
  assert.equal(sessionAt(et('2026-09-09T07:00:00-04:00')).phase, 'premarket');
  assert.equal(sessionAt(et('2026-09-12T12:00:00-04:00')).phase, 'closed');      // Saturday
  assert.equal(sessionAt(et('2026-09-12T12:00:00-04:00')).weekend, true);
});

test('hours to open are computed across the overnight gap and the weekend', () => {
  assert.ok(Math.abs(sessionAt(et('2026-09-09T20:50:00-04:00')).hoursToOpen - 12.7) < 0.1);
  assert.ok(sessionAt(et('2026-09-11T17:00:00-04:00')).hoursToOpen > 60, 'Friday evening waits for Monday');
  assert.equal(sessionAt(et('2026-09-09T14:00:00-04:00')).hoursToOpen, 0);
});

test('an off-hours filing gets a small bump for recency, nothing more', () => {
  const snap = {market: {priceMove5mPercent: 0.1, priceMove1hPercent: 0.1, priceMove24hPercent: 0.1, volume24hUsd: 1e6}};
  const open = interestScore(snap, {events: [{form: '8-K'}], session: {phase: 'regular'}});
  const closed = interestScore(snap, {events: [{form: '8-K'}], session: {phase: 'closed'}});
  assert.ok(closed.score > open.score);
  assert.ok(closed.score - open.score <= 5, 'the bump is small; the token has already priced the news');
  assert.ok(closed.reasons.some(r => /off-hours/.test(r)));
});

test('a pool discount to the reference is a positive signal, a premium is not', () => {
  const snap = {market: {priceMove5mPercent: 0, priceMove1hPercent: 0, priceMove24hPercent: 0, volume24hUsd: 0}};
  assert.ok(interestScore(snap, {poolPremiumPercent: -2}).score > 0, 'cheaper than reference is worth a look');
  assert.equal(interestScore(snap, {poolPremiumPercent: 2}).score, 0, 'dearer than reference earns nothing');
});
