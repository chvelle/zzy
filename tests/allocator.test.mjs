import test from 'node:test';
import assert from 'node:assert/strict';
import {allocate} from '../src/allocator.mjs';

const env = {ANTHROPIC_API_KEY: 'test'};
const snap = (symbol) => ({snapshot: {asset: {symbol, name: symbol}, market: {priceUsd: 100}, priceHistory: []}, decision: {confidence: 50}, headlines: [], events: []});
const reply = (obj) => async () => ({ok: true, json: async () => ({content: [{type: 'text', text: JSON.stringify(obj)}]})});
const portfolio = {portfolioUsd: 1000, cashUsd: 200, positions: [{symbol: 'NVDA', weightPercent: 80}], limits: {maxPositionPercent: 60, maxOrderPercent: 25}};
const holdings = [{symbol: 'NVDA', weightPercent: 80, valueUsd: 800, unrealizedPercent: 30, thesis: 'capex', falsifier: 'guidance cut', targetWeightPercent: 60}];

test('a holding can be closed to fund a named replacement, and both come back in one review', async () => {
  const r = await allocate({portfolio, holdings, candidates: [snap('TSLA')]}, {}, {env, fetchImpl: reply({
    holdings: [{symbol: 'NVDA', action: 'CLOSE', replacedBy: 'TSLA', thesisIntact: true, reason: 'Done what it was bought for; TSLA is the better use of the capital now.'}],
    candidates: [{symbol: 'TSLA', verdict: 'PREPARE', confidence: 85, targetWeightPercent: 55, rationale: 'x', downsideCase: 'y', falsifier: 'z', sources: ['https://sec.gov/a']}],
    summary: 'Rotated NVDA into TSLA.',
  })});
  assert.equal(r.holdings[0].action, 'CLOSE');
  assert.equal(r.holdings[0].replacedBy, 'TSLA');
  assert.equal(r.candidates[0].verdict, 'PREPARE');
  assert.equal(r.candidates[0].targetWeightPercent, 55);
  assert.equal(r.summary, 'Rotated NVDA into TSLA.');
});

test('a replacement that was never on the table is dropped, not trusted', async () => {
  const r = await allocate({portfolio, holdings, candidates: [snap('TSLA')]}, {}, {env, fetchImpl: reply({
    holdings: [{symbol: 'NVDA', action: 'CLOSE', replacedBy: 'GME', reason: 'x'}], candidates: [],
  })});
  assert.equal(r.holdings[0].action, 'CLOSE');
  assert.equal(r.holdings[0].replacedBy, null, 'GME was not shown, so it cannot be named');
});

test('a holding or candidate the model was not shown is ignored', async () => {
  const r = await allocate({portfolio, holdings, candidates: [snap('TSLA')]}, {}, {env, fetchImpl: reply({
    holdings: [{symbol: 'AAPL', action: 'CLOSE', reason: 'x'}, {symbol: 'NVDA', action: 'HOLD', reason: 'y'}],
    candidates: [{symbol: 'GME', verdict: 'PREPARE', confidence: 99, targetWeightPercent: 60, rationale: 'x', downsideCase: 'y', falsifier: 'z', sources: ['https://a']}],
  })});
  assert.deepEqual(r.holdings.map(h => h.symbol), ['NVDA']);
  assert.equal(r.candidates[0].symbol, 'TSLA');
  assert.equal(r.candidates[0].verdict, 'WATCH', 'omitted candidate fails closed');
});

test('every failure path holds and watches', async () => {
  const cases = [
    ['no key', {env: {}, fetchImpl: reply({holdings: [{symbol: 'NVDA', action: 'CLOSE'}]})}],
    ['http error', {env, fetchImpl: async () => ({ok: false, status: 500})}],
    ['garbage', {env, fetchImpl: async () => ({ok: true, json: async () => ({content: [{type: 'text', text: 'not json'}]})})}],
    ['throws', {env, fetchImpl: async () => { throw new Error('network'); }}],
    ['bad action', {env, fetchImpl: reply({holdings: [{symbol: 'NVDA', action: 'SELL_EVERYTHING'}], candidates: [{symbol: 'TSLA', verdict: 'BUY'}]})}],
  ];
  for (const [name, opts] of cases) {
    const r = await allocate({portfolio, holdings, candidates: [snap('TSLA')]}, {}, opts);
    assert.equal(r.holdings[0].action, 'HOLD', name);
    assert.equal(r.candidates[0].verdict, 'WATCH', name);
  }
});

test('a PREPARE with no falsifier or source is downgraded, whatever the confidence', async () => {
  const r = await allocate({portfolio, holdings: [], candidates: [snap('TSLA')]}, {}, {env, fetchImpl: reply({
    holdings: [], candidates: [{symbol: 'TSLA', verdict: 'PREPARE', confidence: 100, targetWeightPercent: 60, rationale: 'trust me'}],
  })});
  assert.equal(r.candidates[0].verdict, 'WATCH');
});

test('the prompt frames holdings against alternatives, not against their own P&L', async () => {
  let body;
  await allocate({portfolio, holdings, candidates: [snap('TSLA')]}, {}, {env, fetchImpl: async (url, init) => { body = JSON.parse(init.body); return {ok: true, json: async () => ({content: []})}; }});
  assert.match(body.system, /does it earn its place in this portfolio, against holding cash and against every other name/);
  assert.match(body.system, /not sold because it is up, or down, or because a headline was negative/);
  assert.match(body.system, /name the replacement/);
  const user = body.messages[0].content;
  assert.match(user, /"targetWeightAtEntry": 60/, 'the entry target rides along so a position at its target is not read as oversized');
  assert.match(user, /"alreadyHeld": false/);
});
