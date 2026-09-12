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

test('prose around the JSON, a paused turn, and a talk-only reply are all survived', async () => {
  const {allocate, extractJson} = await import('../src/allocator.mjs');
  assert.deepEqual(extractJson('Sure. ```json\n{"a":1}\n``` that is all'), {a: 1});
  assert.equal(extractJson('I\'ll research these first.'), null);
  const config = {research: {maxSearchesPerCycle: 0}};
  const good = {holdings: [], candidates: [{symbol: 'GLW', verdict: 'WATCH'}]};
  // 1. pause_turn then the answer with a preamble
  let calls = 0;
  const f1 = async (u, init) => { calls++; const b = JSON.parse(init.body); if (calls === 1) return {ok: true, json: async () => ({stop_reason: 'pause_turn', content: [{type: 'text', text: 'Checking news.'}]})}; assert.equal(b.messages.length, 2, 'the paused content was sent back'); return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: 'Here is my view:\n' + JSON.stringify(good)}]})}; };
  const r1 = await allocate({portfolio: {}, candidates: [snap('GLW')]}, config, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f1});
  assert.equal(r1.candidates.find(c => c.symbol === 'GLW')?.verdict, 'WATCH');
  // 2. talk only, then the object on the re-ask
  calls = 0;
  const f2 = async (u, init) => { calls++; const b = JSON.parse(init.body); if (calls === 1) return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: "I'll research these names."}]})}; assert.match(b.messages.at(-1).content, /only the JSON object/); return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(good)}]})}; };
  const r2 = await allocate({portfolio: {}, candidates: [snap('GLW')]}, config, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f2});
  assert.equal(r2.candidates.find(c => c.symbol === 'GLW')?.verdict, 'WATCH');
  assert.equal(calls, 2);
});

test('the model never sees the book in dollars, only in percent', async () => {
  const {allocate, portfolioInPercent} = await import('../src/allocator.mjs');
  const p = {portfolioUsd: 145.9, cashUsd: 109.42, cashPercent: 75, positions: [{symbol: 'CLS', valueUsd: 36.48, weightPercent: 25, unrealizedPercent: 1.1, thesis: 'x'}], limits: {maxPositionPercent: 60, maxOrderPercent: 25}};
  const v = portfolioInPercent(p);
  assert.equal(JSON.stringify(v).includes('Usd'), false);
  assert.equal(v.cashPercent, 75); assert.equal(v.positions[0].weightPercent, 25);
  let body = null;
  const f = async (u, init) => { body = init.body; return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({holdings: [], candidates: [{symbol: 'GLW', verdict: 'WATCH'}]})}]})}; };
  await allocate({portfolio: p, holdings: [{symbol: 'CLS', weightPercent: 25, valueUsd: 36.48, unrealizedPercent: 1.1, thesis: 'x'}], candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  const b = JSON.parse(body);
  const text = b.messages[0].content;
  assert.ok(!/145\.9|109\.42|36\.48|portfolioUsd|cashUsd|valueUsd/.test(text), 'no dollar figure of the book in the prompt');
  assert.ok(/in percent of the whole/.test(text));
  assert.ok(/never told the size of the book in dollars/.test(b.system));
});

test('a dropped connection is retried once; a failed review is marked failed', async () => {
  const {allocate} = await import('../src/allocator.mjs');
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw new TypeError('fetch failed'); return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({holdings: [], candidates: [{symbol: 'GLW', verdict: 'WATCH'}]})}]})}; };
  const r = await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: flaky});
  assert.equal(calls, 2); assert.equal(r.failed, undefined); assert.equal(r.candidates[0].verdict, 'WATCH');
  calls = 0;
  const dead = async () => { calls++; throw new TypeError('fetch failed'); };
  const r2 = await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: dead});
  assert.equal(calls, 2); assert.equal(r2.failed, true); assert.match(r2.reason, /fetch failed/);
  calls = 0;
  const denied = async () => { calls++; return {ok: false, status: 401}; };
  const r3 = await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: denied});
  assert.equal(calls, 1, 'a 401 is not retried');
});

test('a reply with no text (searches ate the room) gets one re-ask without tools; if that fails too, the review is marked failed', async () => {
  const {allocate} = await import('../src/allocator.mjs');
  const good = {holdings: [], candidates: [{symbol: 'GLW', verdict: 'WATCH'}]};
  let calls = 0, bodies = [];
  const f = async (u, init) => { calls++; bodies.push(JSON.parse(init.body)); if (calls === 1) return {ok: true, json: async () => ({stop_reason: 'max_tokens', content: [{type: 'server_tool_use', id: 'x', name: 'web_search', input: {}}, {type: 'web_search_tool_result', tool_use_id: 'x', content: []}]})}; return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify(good)}]})}; };
  const r = await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 2}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  assert.equal(calls, 2); assert.equal(r.candidates[0].verdict, 'WATCH'); assert.equal(r.failed, undefined);
  assert.equal(bodies[1].tools, undefined, 're-ask has no tools'); assert.equal(bodies[0].max_tokens, 16000);
  assert.match(bodies[1].messages.at(-1).content, /only the JSON object/);
  calls = 0;
  const f2 = async () => { calls++; return {ok: true, json: async () => ({stop_reason: 'max_tokens', content: []})}; };
  const r2 = await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 2}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f2});
  assert.equal(r2.failed, true); assert.match(r2.reason, /no text \(stop_reason max_tokens/);
});

test('citation markup from web search never reaches the reasons', async () => {
  const {allocate, stripCites} = await import('../src/allocator.mjs');
  assert.equal(stripCites('real, with (cite index="5-0">Verizon proving Corning is integral</cite>. But'), 'real, with Verizon proving Corning is integral. But');
  assert.equal(stripCites('a <cite index="1-2">quoted bit</cite> here'), 'a quoted bit here');
  const f = async () => ({ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({summary: 'cash. (cite index="3-0">backlog rose</cite> fine', holdings: [], candidates: [{symbol: 'GLW', verdict: 'WATCH', rationale: 'x <cite index="9-9">y</cite> z', sources: ['https://a.b/<cite>']}]})}]})});
  const r = await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  assert.equal(r.summary, 'cash. backlog rose fine');
  assert.equal(r.candidates[0].rationale, 'x y z');
});

test('posture is a config knob that changes the system prompt', async () => {
  const {allocate, POSTURES} = await import('../src/allocator.mjs');
  const seen = [];
  const f = async (u, init) => { seen.push(JSON.parse(init.body).system); return {ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({holdings: [], candidates: [{symbol: 'GLW', verdict: 'WATCH'}]})}]})}; };
  for (const posture of ['patient', 'balanced', 'active']) await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0, posture}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  assert.ok(seen[0].includes('Posture: PATIENT')); assert.ok(seen[1].includes('Posture: BALANCED')); assert.ok(seen[2].includes('Posture: ACTIVE'));
  assert.ok(!seen[2].includes('{{POSTURE}}'));
  await allocate({portfolio: {}, candidates: [snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  assert.ok(seen[3].includes('Posture: BALANCED'), 'default is balanced');
  assert.ok(POSTURES.active.includes('forecast'));
});

test('an add to a name already held does not need a fresh downside case or source', async () => {
  const {allocate} = await import('../src/allocator.mjs');
  const f = async () => ({ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({holdings: [{symbol: 'CLS', action: 'HOLD', reason: 'intact'}], candidates: [{symbol: 'CLS', verdict: 'PREPARE', targetWeightPercent: 30, rationale: 'adding'}, {symbol: 'GLW', verdict: 'PREPARE', targetWeightPercent: 10, rationale: 'new, no case'}]})}]})});
  const r = await allocate({portfolio: {}, holdings: [{symbol: 'CLS', weightPercent: 20, thesis: 'x', falsifier: 'y'}], candidates: [snap('CLS'), snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  assert.equal(r.candidates.find(c => c.symbol === 'CLS').verdict, 'PREPARE');
  assert.equal(r.candidates.find(c => c.symbol === 'GLW').verdict, 'WATCH', 'a new name without a case is still downgraded');
});

test('a held name that is also a candidate is not marked omitted when it was reviewed as a holding', async () => {
  const {allocate} = await import('../src/allocator.mjs');
  const f = async () => ({ok: true, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: JSON.stringify({holdings: [{symbol: 'CLS', action: 'HOLD', reason: 'intact'}], candidates: [{symbol: 'GLW', verdict: 'WATCH', reason: 'spread'}]})}]})});
  const r = await allocate({portfolio: {}, holdings: [{symbol: 'CLS', weightPercent: 20}], candidates: [snap('CLS'), snap('GLW')]}, {research: {maxSearchesPerCycle: 0}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: f});
  assert.equal(r.candidates.find(c => c.symbol === 'CLS'), undefined, 'no duplicate verdict for the holding');
  assert.equal(r.holdings.find(h => h.symbol === 'CLS').action, 'HOLD');
  assert.equal(r.candidates.find(c => c.symbol === 'GLW').verdict, 'WATCH');
});
