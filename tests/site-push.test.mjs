import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pushSite, writeFeedFile, _resetPushState} from '../src/site-push.mjs';

test('with no token the push is a no-op and warns once', async () => {
  _resetPushState();
  const lines = [];
  const r1 = await pushSite({config: {}, env: {}, log: (m) => lines.push(m)});
  const r2 = await pushSite({config: {}, env: {}, log: (m) => lines.push(m)});
  assert.equal(r1.skipped, 'no credentials'); assert.equal(r2.skipped, 'no credentials');
  assert.equal(lines.filter(l => /ZZY_PUSH_SECRET/.test(l)).length, 1);
});

test('data.json is pushed when it changes, throttled, and history on its own cadence', async () => {
  _resetPushState();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-push-'));
  try {
    const dataFile = path.join(dir, 'data.json'), historyFile = path.join(dir, 'history.json');
    await writeFile(dataFile, '{"a":1}'); await writeFile(historyFile, '{"points":[]}');
    const puts = [];
    const putImpl = async (pathname, body, opts) => { puts.push({pathname, body, opts}); return {url: `https://x.public.blob.vercel-storage.com/${pathname}`}; };
    const env = {BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test'};
    const config = {site: {push: {intervalSeconds: 30, historySeconds: 300, cacheSeconds: 60}}};
    let now = 1_000_000;
    const r1 = await pushSite({config, env, now, putImpl, dataFile, historyFile});
    assert.deepEqual(r1.pushed, ['data.json', 'history.json']);
    assert.equal(puts[0].opts.allowOverwrite, true); assert.equal(puts[0].opts.addRandomSuffix, false); assert.equal(puts[0].opts.cacheControlMaxAge, 60);
    // same content, 5s later: nothing
    const r2 = await pushSite({config, env, now: now + 5000, putImpl, dataFile, historyFile});
    assert.deepEqual(r2.pushed, []);
    // changed content, but inside the 30s throttle: nothing yet
    await writeFile(dataFile, '{"a":2}');
    const r3 = await pushSite({config, env, now: now + 10000, putImpl, dataFile, historyFile});
    assert.deepEqual(r3.pushed, []);
    // after the throttle: data goes, history does not (unchanged, and inside its 5min)
    const r4 = await pushSite({config, env, now: now + 31000, putImpl, dataFile, historyFile});
    assert.deepEqual(r4.pushed, ['data.json']);
    assert.equal(puts.length, 3);
    // feed.json points the page at the blob
    const feed = await writeFeedFile({urls: r4.urls, file: path.join(dir, 'feed.json')});
    const f = JSON.parse(await readFile(feed.file, 'utf8'));
    assert.equal(f.data, 'https://x.public.blob.vercel-storage.com/data.json');
    assert.equal(f.history, 'https://x.public.blob.vercel-storage.com/history.json');
  } finally { await rm(dir, {recursive: true}); }
});

test('a failed put is logged and retried on the next interval, never thrown into the loop', async () => {
  _resetPushState();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-push-'));
  try {
    const dataFile = path.join(dir, 'data.json'); await writeFile(dataFile, '{"a":1}');
    let calls = 0;
    const putImpl = async () => { calls++; if (calls === 1) throw new Error('503 from blob'); return {url: 'https://x/data.json'}; };
    const lines = [];
    const env = {BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_test'}, config = {site: {push: {intervalSeconds: 30}}};
    const r1 = await pushSite({config, env, now: 0, putImpl, dataFile, historyFile: path.join(dir, 'nope.json'), log: (m) => lines.push(m)});
    assert.deepEqual(r1.pushed, []); assert.ok(lines.some(l => /503 from blob/.test(l)));
    const r2 = await pushSite({config, env, now: 31000, putImpl, dataFile, historyFile: path.join(dir, 'nope.json'), log: (m) => lines.push(m)});
    assert.deepEqual(r2.pushed, ['data.json']);
  } finally { await rm(dir, {recursive: true}); }
});

test('with a push secret the files go through the site function, and a placeholder blob token is ignored', async () => {
  _resetPushState();
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-push-'));
  try {
    const dataFile = path.join(dir, 'data.json'); await writeFile(dataFile, '{"a":1}');
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({url, headers: init.headers, body: JSON.parse(init.body)}); return {ok: true, json: async () => ({url: 'https://x.public.blob.vercel-storage.com/data.json'})}; };
    const env = {ZZY_PUSH_SECRET: 's3cret-s3cret-s3cret', SITE_PUSH_URL: 'https://zzy.live/api/push', BLOB_READ_WRITE_TOKEN: '[SENSITIVE]'};
    const r = await pushSite({config: {}, env, now: 0, fetchImpl, dataFile, historyFile: path.join(dir, 'nope.json'), putImpl: async () => { throw new Error('SDK must not be used'); }});
    assert.deepEqual(r.pushed, ['data.json']);
    assert.equal(calls[0].url, 'https://zzy.live/api/push');
    assert.equal(calls[0].headers['x-zzy-push-secret'], 's3cret-s3cret-s3cret');
    assert.equal(calls[0].body.pathname, 'data.json'); assert.equal(calls[0].body.body, '{"a":1}');
  } finally { await rm(dir, {recursive: true}); }
});
