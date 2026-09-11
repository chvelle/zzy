import test from 'node:test';
import assert from 'node:assert/strict';
import {createSiteServer} from '../src/site-server.mjs';
import path from 'node:path';

import {mkdtemp, rm, copyFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

// A fresh clone has no site/data.json (it is operator state and gitignored),
// so every test serves from a temp copy of the page with a minimal export.
async function withServer(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'zzy-site-'));
  await copyFile('site/index.html', path.join(root, 'index.html'));
  await writeFile(path.join(root, 'data.json'), JSON.stringify({generatedAt: new Date().toISOString(), portfolio: {}, treasury: {}, agent: {}, universe: {}, activity: {recent: []}, site: {}}));
  const server = createSiteServer({root});
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try { await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise(r => server.close(r)); await rm(root, {recursive: true}); }
}

test('serves the dashboard and data.json read-only', async () => {
  await withServer(async (u) => {
    const html = await fetch(u + '/');
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-type'), /text\/html/);
    const json = await fetch(u + '/data.json');
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('cache-control'), 'no-store', 'polling must never see a cached tick');
  });
});

test('SECURITY: path traversal cannot escape site/', async () => {
  await withServer(async (u) => {
    for (const p of ['/../config/default.json', '/..%2Fconfig%2Fdefault.json', '/../../.env', '/%2e%2e/package.json']) {
      const r = await fetch(u + p);
      assert.ok(r.status === 403 || r.status === 404, `${p} returned ${r.status}`);
    }
  });
});

test('SECURITY: only GET and HEAD are accepted', async () => {
  await withServer(async (u) => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await fetch(u + '/data.json', {method});
      assert.equal(r.status, 405, method);
    }
  });
});

test('SECURITY: hardening headers are present', async () => {
  await withServer(async (u) => {
    const r = await fetch(u + '/');
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(r.headers.get('content-security-policy'), /connect-src 'self'/);
  });
});

test('CSP allows the font CDN and nothing else external', async () => {
  await withServer(async (u) => {
    const csp = (await fetch(u + '/')).headers.get('content-security-policy');
    assert.match(csp, /style-src 'unsafe-inline' https:\/\/fonts\.googleapis\.com/);
    assert.match(csp, /font-src https:\/\/fonts\.gstatic\.com/);
    // nothing else may reach out: no arbitrary scripts, images or connections
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /connect-src 'self'/);
    assert.ok(!/script-src[^;]*https/.test(csp), 'no external script origins');
  });
});

test('/events pushes the current document on connect and again when data.json is rewritten', async () => {
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {writeJsonAtomic} = await import('../src/storage.mjs');
  const dir = await mkdtemp(path.join(tmpdir(), 'zzy-sse-'));
  const server = createSiteServer({root: dir, heartbeatMs: 100000});
  try {
    await writeJsonAtomic(path.join(dir, 'data.json'), {generatedAt: 'a'});
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (needle) => {
      const deadline = Date.now() + 4000;
      while (!buf.includes(needle)) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('timed out waiting for ' + needle + ' in ' + JSON.stringify(buf));
        const r = await Promise.race([reader.read(), new Promise(res => setTimeout(() => res({timeout: true}), left))]);
        if (r.timeout) throw new Error('timed out waiting for ' + needle + ' in ' + JSON.stringify(buf));
        if (r.done) break; buf += dec.decode(r.value);
      }
    };
    await until('"generatedAt": "a"');
    await writeJsonAtomic(path.join(dir, 'data.json'), {generatedAt: 'b'});
    await until('"generatedAt": "b"');
    reader.cancel();
  } finally { await server.shutdown(); await rm(dir, {recursive: true}); }
});

test('/events is read-only: POST is refused like everything else', async () => {
  const server = createSiteServer({root: 'site'});
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/events`, {method: 'POST'});
    assert.equal(res.status, 405);
  } finally { await server.shutdown(); }
});
