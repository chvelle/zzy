// The live feed for the public site.
//
// zzy.live is a static deploy. The page is fixed; the numbers come from two
// files, data.json and history.json. This pushes those files to Vercel Blob
// every time they change, and the site has a rewrite so /data.json and
// /history.json on zzy.live are served from the blob. The result: the bot
// writes locally every few seconds, the blob gets it within seconds, the
// CDN holds it for at most cacheSeconds, the page polls every pollSeconds.
// Worst case staleness is cacheSeconds + pollSeconds, about a minute and a
// half with the defaults, without ever exposing the machine that holds the
// key.
//
// Needs BLOB_READ_WRITE_TOKEN in .env. Without it this is a no-op and the
// site stays a snapshot, which is what it was before.

import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {writeJsonAtomic} from './storage.mjs';

export const DEFAULT_PUSH = {
  enabled: true,
  intervalSeconds: 30,     // data.json at most this often
  historySeconds: 300,     // history.json at most this often
  cacheSeconds: 60,        // CDN max-age on the blob; Vercel's floor is 60
};

export function pushConfig(config) { return {...DEFAULT_PUSH, ...(config.site?.push ?? {})}; }

const state = {dataAt: -Infinity, dataHash: null, historyAt: -Infinity, historyHash: null, urls: {}, warned: false, lastFail: null, lastFailAt: -Infinity};
export function _resetPushState() { Object.assign(state, {dataAt: -Infinity, dataHash: null, historyAt: -Infinity, historyHash: null, urls: {}, warned: false, lastFail: null, lastFailAt: -Infinity}); }

// The same failure is said once every ten minutes, not every push.
function failOnce(log, msg, now) {
  if (msg === state.lastFail && now - state.lastFailAt < 600_000) return;
  state.lastFail = msg; state.lastFailAt = now; log(msg);
}

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Two transports. Preferred: POST to the site's own /api/push with a shared
// secret; the blob token stays on Vercel and is never in this machine's
// .env. Fallback: the blob SDK with BLOB_READ_WRITE_TOKEN, for anyone who
// does have the token.
async function putBlob(pathname, body, {token, pushUrl, pushSecret, cacheSeconds, putImpl, fetchImpl = fetch}) {
  if (pushUrl && pushSecret) {
    const r = await fetchImpl(pushUrl, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-zzy-push-secret': pushSecret},
      body: JSON.stringify({pathname, body, cacheSeconds}),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`push endpoint ${r.status}: ${j.error ?? 'no detail'}`);
    if (!j.url) throw new Error('push endpoint returned no url');
    return j.url;
  }
  const put = putImpl ?? (await import('@vercel/blob')).put;
  const res = await put(pathname, body, {
    access: 'public', token,
    addRandomSuffix: false, allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: cacheSeconds,
  });
  return res.url;
}

// Called after every local export. Decides whether the blob needs the file,
// pushes it, and remembers the URL so vercel.json can be written.
export async function pushSite({config, env = process.env, now = Date.now(), log = () => {}, putImpl = null, fetchImpl = fetch, dataFile = 'site/data.json', historyFile = 'site/history.json'} = {}) {
  const cfg = pushConfig(config);
  const pushUrl = env.SITE_PUSH_URL || (config.site?.push?.url ?? null);
  const pushSecret = env.ZZY_PUSH_SECRET || null;
  const token = env.BLOB_READ_WRITE_TOKEN && /^vercel_blob_rw_/.test(env.BLOB_READ_WRITE_TOKEN) ? env.BLOB_READ_WRITE_TOKEN : null;
  if (!cfg.enabled) return {skipped: 'disabled'};
  if (!(pushUrl && pushSecret) && !token) {
    if (!state.warned) { state.warned = true; log('site push: set ZZY_PUSH_SECRET (and SITE_PUSH_URL) or BLOB_READ_WRITE_TOKEN in .env, or zzy.live will not update on its own (guide, section 7c)'); }
    return {skipped: 'no credentials'};
  }
  const creds = {token, pushUrl, pushSecret, putImpl, fetchImpl};
  const out = {pushed: []};

  if (now - state.dataAt >= cfg.intervalSeconds * 1000) {
    const body = await readFile(dataFile, 'utf8');
    const h = hash(body);
    if (h !== state.dataHash) {
      try {
        state.urls.data = await putBlob('data.json', body, {...creds, cacheSeconds: cfg.cacheSeconds});
        state.dataAt = now; state.dataHash = h; out.pushed.push('data.json');
      } catch (e) { failOnce(log, `site push: data.json failed: ${e.message.split('\n')[0]} (will keep retrying quietly)`, now); state.dataAt = now; }
    } else state.dataAt = now;
  }

  if (now - state.historyAt >= cfg.historySeconds * 1000) {
    try {
      const body = await readFile(historyFile, 'utf8');
      const h = hash(body);
      if (h !== state.historyHash) {
        state.urls.history = await putBlob('history.json', body, {...creds, cacheSeconds: cfg.cacheSeconds});
        state.historyHash = h; out.pushed.push('history.json');
      }
    } catch (e) { if (e.code !== 'ENOENT') failOnce(log, `site push: history.json failed: ${e.message.split('\n')[0]}`, now); }
    state.historyAt = now;
  }

  if (out.pushed.length) out.urls = {...state.urls};
  return out;
}

// Writes site/feed.json: the page reads it on load and, if present, polls the
// blob URLs instead of its own folder. Written after the first successful
// push and whenever a URL changes; deploy the site folder once after that.
export async function writeFeedFile({urls, file = 'site/feed.json', cacheSeconds = 60}) {
  if (!urls?.data) throw new Error('no data.json blob URL yet; push at least once first');
  await writeJsonAtomic(file, {data: urls.data, history: urls.history ?? null, cacheSeconds, writtenAt: new Date().toISOString()});
  return {file, urls};
}
