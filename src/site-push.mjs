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

const state = {dataAt: -Infinity, dataHash: null, historyAt: -Infinity, historyHash: null, urls: {}, warned: false};
export function _resetPushState() { Object.assign(state, {dataAt: -Infinity, dataHash: null, historyAt: -Infinity, historyHash: null, urls: {}, warned: false}); }

const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

async function putBlob(pathname, body, {token, cacheSeconds, putImpl}) {
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
export async function pushSite({config, env = process.env, now = Date.now(), log = () => {}, putImpl = null, dataFile = 'site/data.json', historyFile = 'site/history.json'} = {}) {
  const cfg = pushConfig(config);
  const token = env.BLOB_READ_WRITE_TOKEN;
  if (!cfg.enabled) return {skipped: 'disabled'};
  if (!token) {
    if (!state.warned) { state.warned = true; log('site push: BLOB_READ_WRITE_TOKEN not set; zzy.live will not update on its own (see the guide, section 7c)'); }
    return {skipped: 'no token'};
  }
  const out = {pushed: []};

  if (now - state.dataAt >= cfg.intervalSeconds * 1000) {
    const body = await readFile(dataFile, 'utf8');
    const h = hash(body);
    if (h !== state.dataHash) {
      try {
        state.urls.data = await putBlob('data.json', body, {token, cacheSeconds: cfg.cacheSeconds, putImpl});
        state.dataAt = now; state.dataHash = h; out.pushed.push('data.json');
      } catch (e) { log(`site push: data.json failed: ${e.message.split('\n')[0]}`); state.dataAt = now; }
    } else state.dataAt = now;
  }

  if (now - state.historyAt >= cfg.historySeconds * 1000) {
    try {
      const body = await readFile(historyFile, 'utf8');
      const h = hash(body);
      if (h !== state.historyHash) {
        state.urls.history = await putBlob('history.json', body, {token, cacheSeconds: cfg.cacheSeconds, putImpl});
        state.historyHash = h; out.pushed.push('history.json');
      }
    } catch (e) { if (e.code !== 'ENOENT') log(`site push: history.json failed: ${e.message.split('\n')[0]}`); }
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
