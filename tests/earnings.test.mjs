import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fetchEarningsWindow, loadEarnings, earningsFor, inBlackout} from '../src/earnings.mjs';
import {reviewFingerprint, shouldReview, intervalFor} from '../src/review-gate.mjs';

const now = new Date('2026-09-09T14:00:00Z');   // a Wednesday
const nasdaq = (rowsByDate) => async (url) => {
  const d = new URL(url).searchParams.get('date');
  return {ok: true, json: async () => ({data: {rows: rowsByDate[d] ?? []}})};
};

test('the calendar is fetched for the window and keyed by symbol', async () => {
  const cal = await fetchEarningsWindow({now, days: 3, fetchImpl: nasdaq({
    '2026-09-10': [{symbol: 'ORCL', name: 'Oracle', time: 'time-after-hours', epsForecast: '$1.45'}],
    '2026-09-11': [{symbol: 'ADBE', name: 'Adobe', time: 'time-pre-market', epsForecast: ''}],
  })});
  assert.equal(cal.days, 3); assert.equal(cal.failures, 0);
  assert.deepEqual(cal.bySymbol.ORCL, {date: '2026-09-10', when: 'after-hours', epsForecast: 1.45});
  assert.equal(cal.bySymbol.ADBE.epsForecast, null);
});

test('a name reporting inside the blackout is refused for new buys, a holding is not', () => {
  const cal = {to: '2026-09-22', bySymbol: {ORCL: {date: '2026-09-10', when: 'after-hours'}, NVDA: {date: '2026-09-18', when: 'after-hours'}}};
  assert.match(inBlackout('ORCL', cal, {}, now), /inside the 1-day blackout/);
  assert.equal(inBlackout('NVDA', cal, {}, now), null, 'nine days out is fine');
  assert.match(inBlackout('NVDA', cal, {policy: {earningsBlackoutDays: 10}}, now), /blackout/);
  assert.equal(earningsFor('AAPL', cal, now).status, 'none-in-window');
  assert.equal(earningsFor('AAPL', null, now).status, 'unknown', 'no calendar is unknown, never "no report coming"');
  assert.equal(earningsFor('ORCL', cal, now).daysUntil, 1);
});

test('the calendar is cached on disk and not refetched while fresh', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-earn-'));
  try {
    const config = {earnings: {path: path.join(dir, 'e.json'), windowDays: 2}};
    let calls = 0;
    const fetchImpl = async (url) => { calls++; return nasdaq({'2026-09-09': [{symbol: 'X', time: 'time-pre-market'}]})(url); };
    const a = await loadEarnings(config, {now, fetchImpl});
    assert.equal(calls, 2, 'one request per day in the window');
    assert.ok(a.bySymbol.X);
    JSON.parse(await readFile(config.earnings.path, 'utf8'));
    const b = await loadEarnings(config, {now: new Date(now.getTime() + 3600_000), fetchImpl});
    assert.equal(calls, 2, 'served from disk an hour later');
    assert.equal(b.fetchedAt, a.fetchedAt);
    await loadEarnings(config, {now: new Date(now.getTime() + 13 * 3600_000), fetchImpl});
    assert.equal(calls, 4, 'refetched after refreshHours');
  } finally { await rm(dir, {recursive: true}); }
});

test('a calendar that will not load never becomes "no earnings"', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-earn-'));
  try {
    const config = {earnings: {path: path.join(dir, 'e.json'), windowDays: 2}};
    const cal = await loadEarnings(config, {now, fetchImpl: async () => { throw new Error('down'); }});
    assert.equal(cal, null);
    assert.equal(inBlackout('ORCL', cal, {}, now), null, 'unknown means no blackout, and the review is told "unknown"');
  } finally { await rm(dir, {recursive: true}); }
});

test('review cadence stretches outside regular hours', () => {
  assert.equal(intervalFor({phase: 'regular'}, {}), 300);
  assert.equal(intervalFor({phase: 'afterhours'}, {}), 900);
  assert.equal(intervalFor({phase: 'closed'}, {}), 3600);
  assert.equal(intervalFor({phase: 'closed'}, {research: {intervalSecondsClosed: 120}}), 120);
});

test('identical inputs do not buy a second model call; new information does', () => {
  const inputs = {shortlist: [{snapshot: {asset: {symbol: 'NVDA'}}, headlines: [{url: 'https://a/1'}], events: []}], holdings: [{symbol: 'TSLA', headlines: [], events: []}], notebook: [], portfolioCashUsd: 100};
  const fp = reviewFingerprint(inputs);
  const state = {lastReviewAt: '2026-09-09T13:00:00Z', lastFingerprint: fp, lastPrices: {TSLA: 100}};
  assert.equal(shouldReview({state, fingerprint: fp, holdingPrices: {TSLA: 101}}, {}).review, false, 'same inputs, 1% drift: skip');
  assert.equal(shouldReview({state, fingerprint: fp, holdingPrices: {TSLA: 97}}, {}).review, true, 'a 3% move is new information');
  const fp2 = reviewFingerprint({...inputs, shortlist: [{...inputs.shortlist[0], headlines: [{url: 'https://a/1'}, {url: 'https://a/2'}]}]});
  assert.notEqual(fp, fp2);
  assert.equal(shouldReview({state, fingerprint: fp2, holdingPrices: {TSLA: 100}}, {}).review, true, 'a new headline is new information');
  const fp3 = reviewFingerprint({...inputs, portfolioCashUsd: 160});
  assert.notEqual(fp, fp3, 'new cash from a fee claim is new information');
  assert.equal(reviewFingerprint({...inputs, portfolioCashUsd: 103}), fp, 'a few dollars of drift is not');
  assert.equal(shouldReview({state, fingerprint: fp, holdingPrices: {}, overridesPending: true}, {}).review, true);
  assert.equal(shouldReview({state, fingerprint: fp, holdingPrices: {}}, {research: {skipIfNothingNew: false}}).review, true);
});
