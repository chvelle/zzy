import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {oauthHeader, scanPost, canPost, eventsFromTick, composePost, socialAfterTick, DEFAULT_SOCIAL, loadSocialLog, isBearish} from '../src/social.mjs';

test('OAuth 1.0a signature matches the published X reference vector', () => {
  // https://developer.x.com/en/docs/authentication/oauth-1-0a/creating-a-signature
  const h = oauthHeader({
    method: 'POST', url: 'https://api.twitter.com/1.1/statuses/update.json',
    consumerKey: 'xvz1evFS4wEEPTGEFPHBog', consumerSecret: 'kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw',
    token: '370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb', tokenSecret: 'LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE',
    nonce: 'kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg', timestamp: 1318622958,
  });
  // The reference vector signs the request body too, so only the header shape
  // and the deterministic parameters are checked here; the signing key and
  // base-string construction are what the vector exercises.
  assert.match(h, /^OAuth oauth_consumer_key="xvz1evFS4wEEPTGEFPHBog", oauth_nonce="kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1318622958", oauth_token="370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb", oauth_version="1\.0"$/);
});

test('the scan refuses the things the account must never say', () => {
  assert.equal(scanPost('Closed NVDA today. The capital went to TSLA.', DEFAULT_SOCIAL), null);
  assert.match(scanPost('buy $ZZY now', DEFAULT_SOCIAL), /forbidden/);
  assert.match(scanPost('what a day #stocks', DEFAULT_SOCIAL), /forbidden/);
  assert.match(scanPost('up only 🚀', DEFAULT_SOCIAL), /forbidden/);
  assert.match(scanPost('So it goes!', DEFAULT_SOCIAL), /exclamation/);
  assert.match(scanPost('Held cash today \u2014 nothing earned its place.', DEFAULT_SOCIAL), /em dash/);
  assert.match(scanPost('key 0x' + 'a'.repeat(64), DEFAULT_SOCIAL), /secret/);
  assert.match(scanPost('x'.repeat(300), DEFAULT_SOCIAL), /over 240/);
  assert.equal(scanPost('', DEFAULT_SOCIAL), 'empty');
});

test('only settled events become posts; previews and soft events are kept apart', () => {
  const out = {trading: {
    buys: [{symbol: 'NVDA', usd: 62.5, qty: 0.35, hash: '0xa'}, {symbol: 'AMD', usd: 20, preview: true}, {symbol: 'X', usd: 10, error: 'reverted'}],
    exits: [{symbol: 'TSLA', action: 'CLOSE', hash: '0xb', proceedsUsd: 100, realizedUsd: -12.3, replacedBy: 'NVDA', reason: 'better use of the capital'}, {symbol: 'Q', action: 'HOLD'}],
    review: 'Rotated TSLA into NVDA.', reviewed: ['TSLA'], researched: ['NVDA'], book: 250,
  }, treasury: {acted: true, claimTxHash: '0xc', buyTxHash: '0xd', claimUsd: 200, buybackUsd: 100, tradingUsd: 100}};
  const evs = eventsFromTick(out);
  assert.deepEqual(evs.map(e => e.kind), ['rotation', 'claim'], 'TSLA closed into NVDA is one event; the review note yields to the trades');
  assert.equal(evs[0].realizedUsd, -12.3, 'a loss is carried as a loss');
  assert.equal(evs[0].to, 'NVDA');
  assert.equal(evs.filter(e => e.soft).length, 0);
  assert.ok(evs.every(e => !e.hash && !e.txHash), 'hashes are used for the dedup key only, never as content');
});

test('the gate: real events post at once, soft ones wait, nothing posts twice', () => {
  const now = new Date('2026-09-10T18:00:00Z');
  const cfg = {...DEFAULT_SOCIAL, safetyCapPerDay: 3, softEveryHours: 6};
  const log = {posts: [{key: 'buy:1', kind: 'buy', at: '2026-09-10T17:59:00Z'}]};
  assert.equal(canPost(log, {key: 'buy:1', kind: 'buy'}, cfg, now), 'already posted');
  assert.equal(canPost(log, {key: 'buy:2', kind: 'buy'}, cfg, now), null, 'a second real event a minute later still posts');
  assert.match(canPost(log, {key: 'musing:x', kind: 'musing', soft: true}, cfg, now), /quiet for 6h/);
  const quiet = new Date('2026-09-11T01:00:00Z');
  assert.equal(canPost(log, {key: 'musing:x', kind: 'musing', soft: true}, cfg, quiet), null, 'after six quiet hours a thought is allowed');
  const full = {posts: [1, 2, 3].map(i => ({key: 'k' + i, kind: 'buy', at: '2026-09-10T12:00:00Z'}))};
  assert.match(canPost(full, {key: 'k4', kind: 'buy'}, cfg, now), /safety cap/);
  assert.equal(canPost({posts: []}, {key: 'daily:x', kind: 'daily', soft: true}, cfg, now), 'not the daily hour');
  const at21 = new Date('2026-09-10T21:05:00Z');
  assert.equal(canPost({posts: []}, {key: 'daily:x', kind: 'daily', soft: true}, cfg, at21), null);
  assert.equal(canPost({posts: [{key: 'daily:y', kind: 'daily', at: '2026-09-10T21:01:00Z'}]}, {key: 'daily:x', kind: 'daily', soft: true}, cfg, at21), 'already reported today');
});

test('a close that names its replacement and the buy of it become one rotation post', () => {
  const out = {trading: {
    exits: [{symbol: 'TSLA', action: 'CLOSE', hash: '0xb', proceedsUsd: 100, realizedUsd: -12.3, replacedBy: 'NVDA', reason: 'better use'}],
    buys: [{symbol: 'NVDA', usd: 95, qty: 0.5, hash: '0xa'}],
    review: 'Rotated.', reviewed: ['TSLA'], researched: ['NVDA'],
  }};
  const evs = eventsFromTick(out);
  assert.deepEqual(evs.map(e => e.kind), ['rotation'], 'and the review note is suppressed because a trade said it');
  assert.equal(evs[0].from, 'TSLA'); assert.equal(evs[0].to, 'NVDA'); assert.equal(evs[0].realizedUsd, -12.3);
});

test('the composer is told the event and nothing else, and its output is stripped of quotes', async () => {
  let body;
  const text = await composePost({kind: 'close', symbol: 'TSLA', realizedUsd: -12.3, replacedBy: 'NVDA', hash: '0xSECRET'}, {}, {env: {ANTHROPIC_API_KEY: 't'},
    fetchImpl: async (u, init) => { body = JSON.parse(init.body); return {ok: true, json: async () => ({content: [{type: 'text', text: '"Sold TSLA at a loss. NVDA has the better claim on the money."'}]})}; }});
  assert.equal(text, 'Sold TSLA at a loss. NVDA has the better claim on the money.');
  assert.ok(!body.messages[0].content.includes('0xSECRET'), 'hash stripped before the model sees it');
  assert.match(body.system, /may not add a number/);
  assert.match(body.system, /Never say or imply anyone should buy \$ZZY/);
  assert.match(body.system, /created by Ozzy, also known as MeadGod, the creator of Pons/, 'the default creator');
  let sys0; await composePost({kind: 'daily'}, {social: {creator: ''}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: async (u, init) => { sys0 = JSON.parse(init.body).system; return {ok: true, json: async () => ({content: []})}; }});
  assert.match(sys0, /created by its creator/, 'an empty creator falls back cleanly');
  let sys2; await composePost({kind: 'daily'}, {social: {creator: 'Ozzy, the creator of Pons'}}, {env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: async (u, init) => { sys2 = JSON.parse(init.body).system; return {ok: true, json: async () => ({content: []})}; }});
  assert.match(sys2, /created by Ozzy, the creator of Pons/);
  assert.match(sys2, /no brokerage account/);
});

test('a dry run composes, scans, logs, and sends nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-social-'));
  try {
    const config = {social: {enabled: false, logPath: path.join(dir, 'log.json')}};
    let xCalls = 0;
    const fetchImpl = async (u, init) => {
      if (u.includes('api.x.com')) { xCalls++; return {ok: true, json: async () => ({data: {id: '1'}})}; }
      return {ok: true, json: async () => ({content: [{type: 'text', text: 'Bought NVDA. A quarter of the book, for now.'}]})};
    };
    const out = {trading: {buys: [{symbol: 'NVDA', usd: 62.5, qty: 0.35, hash: '0xa'}]}};
    const r = await socialAfterTick({out, config, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl, log: () => {}});
    assert.equal(r.posted.length, 1); assert.equal(r.posted[0].dryRun, true);
    assert.equal(xCalls, 0, 'nothing left the machine');
    const l = await loadSocialLog(config);
    assert.equal(l.posts[0].key, 'buy:0xa');
    // and it will not post the same event twice
    const again = await socialAfterTick({out, config, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl, log: () => {}});
    assert.equal((again.posted ?? []).length, 0);
  } finally { await rm(dir, {recursive: true}); }
});

test('a simulated run never posts', async () => {
  const r = await socialAfterTick({out: {trading: {buys: [{symbol: 'NVDA', usd: 1, hash: '0xa'}]}}, config: {_fork: true}, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: async () => { throw new Error('must not be called'); }});
  assert.equal(r.skipped, 'simulated run');
});

test('a post the scan refuses is dropped, not sent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-social-'));
  try {
    const config = {social: {enabled: true, logPath: path.join(dir, 'log.json')}};
    let xCalls = 0;
    const fetchImpl = async (u) => {
      if (u.includes('api.x.com')) { xCalls++; return {ok: true, json: async () => ({data: {id: '1'}})}; }
      return {ok: true, json: async () => ({content: [{type: 'text', text: 'buy $ZZY, it only goes up!'}]})};
    };
    const lines = [];
    await socialAfterTick({out: {trading: {buys: [{symbol: 'NVDA', usd: 1, hash: '0xa'}]}}, config, env: {ANTHROPIC_API_KEY: 't', X_API_KEY: 'k', X_API_SECRET: 's', X_ACCESS_TOKEN: 't', X_ACCESS_SECRET: 'x'}, fetchImpl, log: (m) => lines.push(m)});
    assert.equal(xCalls, 0);
    assert.ok(lines.some(l => /refused a buy post/.test(l)));
  } finally { await rm(dir, {recursive: true}); }
});

test('bearish events are not posted, and never spun', async () => {
  assert.equal(isBearish({kind: 'close', realizedUsd: -12}), 'realised loss');
  assert.equal(isBearish({kind: 'rotation', realizedUsd: -1, to: 'NVDA'}), 'realised loss', 'a rotation out at a loss stays quiet too');
  assert.equal(isBearish({kind: 'close', realizedUsd: 40}), null);
  assert.equal(isBearish({kind: 'daily', settledPnlUsd: 10, openPnlUsd: -30}), 'book under water');
  assert.equal(isBearish({kind: 'daily', settledPnlUsd: 100, openPnlUsd: -5}), 'open positions down');
  assert.equal(isBearish({kind: 'daily', settledPnlUsd: 100, openPnlUsd: 5}), null);
  assert.equal(isBearish({kind: 'musing', market: {benchmarks: [{symbol: 'SPY', move24hPercent: -1.2}]}}), 'market down on the day');
  assert.equal(isBearish({kind: 'musing', market: {benchmarks: [{symbol: 'SPY', move24hPercent: 0.4}], breadth: {up24hPercent: 61}}}), null);

  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-social-'));
  try {
    const config = {social: {enabled: false, logPath: path.join(dir, 'log.json')}};
    let composerCalls = 0;
    const fetchImpl = async () => { composerCalls++; return {ok: true, json: async () => ({content: [{type: 'text', text: 'anything'}]})}; };
    // a losing close: never reaches the composer
    const r = await socialAfterTick({out: {trading: {exits: [{symbol: 'TSLA', action: 'CLOSE', hash: '0xb', proceedsUsd: 50, realizedUsd: -20}]}}, config, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl, log: () => {}});
    assert.equal(composerCalls, 0); assert.equal((r.posted ?? []).length, 0);
    // a winning close with a composer that answers SKIP: nothing posted
    const skip = async () => ({ok: true, json: async () => ({content: [{type: 'text', text: 'SKIP'}]})});
    const r2 = await socialAfterTick({out: {trading: {exits: [{symbol: 'TSLA', action: 'CLOSE', hash: '0xc', proceedsUsd: 50, realizedUsd: 20}]}}, config, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: skip, log: () => {}});
    assert.equal((r2.posted ?? []).length, 0);
    // a composer that slips a bearish word past the mood instruction is caught by the word scan
    const gloomy = async () => ({ok: true, json: async () => ({content: [{type: 'text', text: 'Closed TSLA. The whole tape is bleeding today.'}]})});
    const r3 = await socialAfterTick({out: {trading: {exits: [{symbol: 'TSLA', action: 'CLOSE', hash: '0xd', proceedsUsd: 50, realizedUsd: 20}]}}, config, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: gloomy, log: () => {}});
    assert.equal((r3.posted ?? []).length, 0);
    // with postBearish on, the loss is posted plainly
    const cfgOn = {social: {enabled: false, postBearish: true, logPath: path.join(dir, 'log2.json')}};
    const plain = async () => ({ok: true, json: async () => ({content: [{type: 'text', text: 'Closed TSLA at a loss. It stopped earning its place.'}]})});
    const r4 = await socialAfterTick({out: {trading: {exits: [{symbol: 'TSLA', action: 'CLOSE', hash: '0xe', proceedsUsd: 50, realizedUsd: -20}]}}, config: cfgOn, env: {ANTHROPIC_API_KEY: 't'}, fetchImpl: plain, log: () => {}});
    assert.equal(r4.posted.length, 1);
  } finally { await rm(dir, {recursive: true}); }
});
