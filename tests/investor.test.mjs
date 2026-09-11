// The bot as a person with a paycheque, a notebook and a view of the tape.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {marketContext} from '../src/market.mjs';
import {applyNotes, notesFromReview, liveEntries, loadNotebook, saveNotebook} from '../src/notebook.mjs';
import {interestScore} from '../src/intel.mjs';
import {allocate} from '../src/allocator.mjs';
import {emptyStore, recordPrice} from '../src/prices.mjs';

test('market context is built from the benchmark tokens already in the catalog', () => {
  const now = new Date('2026-09-09T15:00:00Z');
  const store = emptyStore();
  const quotes = {};
  for (const [sym, then, nowPx] of [['SPY', 100, 98], ['QQQ', 100, 97], ['NVDA', 100, 96], ['AAPL', 100, 101], ['TSLA', 100, 110]]) {
    recordPrice(store, sym, then, new Date(now.getTime() - 86400_000 + 1000));
    recordPrice(store, sym, nowPx, now);
    quotes[sym] = {mid: nowPx, spreadPercent: 0.1, isTradingHalt: false};
  }
  const m = marketContext(quotes, store, now);
  assert.equal(m.benchmarks.find(b => b.symbol === 'SPY').move24hPercent, -2);
  assert.equal(m.breadth.names, 3, 'benchmarks are not counted as names');
  assert.equal(m.breadth.up24hPercent, 66.67);
  assert.equal(m.leaders24h[0].symbol, 'TSLA');
  assert.equal(m.laggards24h[0].symbol, 'NVDA');
  assert.match(m.note, /Compare any single-name move against the benchmarks/);
});

test('a WATCH with something to wait for goes into the notebook and comes back to the shortlist', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-nb-'));
  try {
    const config = {notebook: {path: path.join(dir, 'nb.json')}};
    const now = new Date('2026-09-09T12:00:00Z');
    const review = {
      candidates: [{symbol: 'AMD', verdict: 'WATCH', watchFor: 'MI400 launch in October; buy if it holds 150 into it.'},
                   {symbol: 'INTC', verdict: 'WATCH', watchFor: null},
                   {symbol: 'NVDA', verdict: 'PREPARE'}],
      holdings: [{symbol: 'TSLA', action: 'HOLD', note: 'Deliveries print next week decides it.'}],
    };
    let nb = applyNotes(await loadNotebook(config), notesFromReview(review), config, now);
    await saveNotebook(nb, config);
    nb = await loadNotebook(config);
    const live = liveEntries(nb, now);
    assert.deepEqual(live.map(e => e.symbol).sort(), ['AMD', 'TSLA']);
    assert.equal(live.find(e => e.symbol === 'AMD').kind, 'watch');
    assert.equal(live.find(e => e.symbol === 'TSLA').kind, 'holding');

    // the noted name now clears the interest threshold without moving
    const quiet = {market: {priceMove5mPercent: 0, priceMove1hPercent: 0, priceMove24hPercent: 0, volume24hUsd: 0}};
    assert.ok(interestScore(quiet, {}).score < 5, 'a quiet name is normally invisible');
    const s = interestScore(quiet, {noted: true});
    assert.ok(s.score >= 25); assert.ok(s.reasons.includes('in the notebook'));

    // a resolution clears it; expiry clears the rest
    nb = applyNotes(nb, notesFromReview({candidates: [{symbol: 'AMD', verdict: 'PREPARE'}], holdings: []}), config, now);
    assert.deepEqual(liveEntries(nb, now).map(e => e.symbol), ['TSLA']);
    assert.equal(liveEntries(nb, new Date(now.getTime() + 8 * 86400_000)).length, 0, 'notes expire');
  } finally { await rm(dir, {recursive: true}); }
});

test('the notebook is capped and the newest note on a name wins', () => {
  const config = {notebook: {maxEntries: 3}};
  let nb = {schemaVersion: 1, entries: []};
  const now = new Date();
  nb = applyNotes(nb, [1, 2, 3, 4, 5].map(i => ({symbol: 'S' + i, note: 'n' + i})), config, now);
  assert.equal(nb.entries.length, 3);
  nb = applyNotes(nb, [{symbol: 'S5', note: 'updated'}], config, new Date(now.getTime() + 1000));
  assert.equal(nb.entries.find(e => e.symbol === 'S5').note, 'updated');
  assert.equal(nb.entries.filter(e => e.symbol === 'S5').length, 1);
});

test('the review sees the market, the news on what it holds, and its own notebook', async () => {
  let body;
  const snap = (symbol) => ({snapshot: {asset: {symbol, name: symbol}, market: {priceUsd: 100}, priceHistory: []}, decision: {confidence: 50}, headlines: [], events: []});
  await allocate({
    portfolio: {portfolioUsd: 1000, cashUsd: 400, positions: [], limits: {}},
    holdings: [{symbol: 'TSLA', weightPercent: 60, thesis: 'deliveries', headlines: [{title: 'Tesla Q3 deliveries beat', source: 'Reuters', url: 'https://r.com/x'}], events: []}],
    candidates: [snap('AMD')],
    market: {benchmarks: [{symbol: 'SPY', move24hPercent: -1.2}], breadth: {up24hPercent: 31}},
    notebook: [{symbol: 'AMD', kind: 'watch', at: '2026-09-08T12:00:00Z', note: 'buy if it holds 150'}],
  }, {}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: async (url, init) => { body = JSON.parse(init.body); return {ok: true, json: async () => ({content: []})}; }});
  const user = body.messages[0].content;
  assert.match(user, /What the market did/);
  assert.match(user, /"up24hPercent": 31/);
  assert.match(user, /Tesla Q3 deliveries beat/, 'news on the holding reaches the review');
  assert.match(user, /buy if it holds 150/, 'the notebook reaches the review');
  assert.match(body.system, /every fee claim is a paycheque/);
  assert.match(body.system, /cash is not a problem to be solved by buying something/i);
  assert.match(body.system, /Subtract the market before reading the stock/);
});
