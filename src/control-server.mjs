import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {writeJsonAtomic} from './storage.mjs';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import path from 'node:path';
import {preflight} from './preflight.mjs';
import {seedPaperCapital} from './paper.mjs';
import {readBookState} from './profit.mjs';
import {readLedger} from './treasury.mjs';
import {loadPositions, valuePositions} from './positions.mjs';
import {publicClient} from './chain.mjs';

// The control panel's backend.
//
// This is the one surface that can change what a possibly-live bot does, so
// it is locked down harder than the public site:
//
//   - Binds to 127.0.0.1 only. There is no config option to bind elsewhere.
//   - Every API call needs a token generated fresh at startup and printed to
//     the terminal. Without it, any web page you happen to have open could
//     POST to localhost and pause your bot or rewrite its limits. The
//     token goes in a header, not a cookie, so a browser will not attach it
//     on a cross-site request by itself.
//   - Config edits are limited to an explicit allowlist of paths. Nothing
//     outside it can be touched from the panel, and `mode` is not on it.
//     Turning live on is a file edit plus two environment variables plus a
//     restart, on purpose.
//   - Nothing here reads or returns a private key, and the runner never
//     exposes one either.

export const EDITABLE = {
  'runtime.watchAddress':          {type: 'address'},
  'policy.maxOrderUsd':            {type: 'number|null', min: 1, max: 100000},
  'policy.sizing.maxPositionPercent': {type: 'number', min: 1, max: 100},
  'policy.sizing.maxOrderPercent': {type: 'number', min: 1, max: 100},
  'policy.sizing.minOrderUsd':     {type: 'number', min: 1, max: 10000},
  'policy.maxTotalExposureUsd':    {type: 'number', min: 1, max: 1000000},
  'policy.maxPriceMovePercent':    {type: 'number', min: 0.1, max: 50},
  'policy.earningsBlackoutDays':   {type: 'number', min: 0, max: 30},
  'execution.tickIntervalSeconds': {type: 'number', min: 10, max: 86400},
  'execution.tickIntervalSecondsExtended': {type: 'number', min: 10, max: 86400},
  'execution.tickIntervalSecondsClosed': {type: 'number', min: 10, max: 86400},
  'execution.maxPoolPremiumPercent': {type: 'number', min: 0, max: 20},
  'research.intervalSeconds':      {type: 'number', min: 60, max: 86400},
  'research.intervalSecondsExtended': {type: 'number', min: 60, max: 86400},
  'research.intervalSecondsClosed': {type: 'number', min: 60, max: 86400},
  'research.skipIfNothingNew':     {type: 'boolean'},
  'social.enabled':                {type: 'boolean'},
  'social.safetyCapPerDay':        {type: 'number', min: 1, max: 500},
  'social.softEveryHours':         {type: 'number', min: 1, max: 168},
  'social.postBearish':            {type: 'boolean'},
  'research.maxCandidatesPerCycle':{type: 'number', min: 1, max: 30},
  'research.minInterestScore':     {type: 'number', min: 0, max: 100},
  'research.maxSearchesPerCycle':  {type: 'number', min: 0, max: 20},
  'research.timeoutMs':            {type: 'number', min: 30000, max: 600000},
  'profitPolicy.mode':             {type: 'enum', values: ['compound', 'buyback', 'threshold']},
  'profitPolicy.compoundUntilUsd': {type: 'number', min: 1, max: 100000000},
  'exitPolicy.maxLossPercent':     {type: 'number|null', min: 1, max: 95},
  'treasury.zzyTokenAddress':      {type: 'address|null'},
  'pons.claimThresholdEth':        {type: 'number', min: 0.001, max: 1000},
  'site.twitter':                  {type: 'url|null'},
  'site.credit':                   {type: 'string'},
};

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const SYM = /^[A-Z0-9.]{1,10}$/;

export function validateEdit(pathKey, value) {
  const rule = EDITABLE[pathKey];
  if (!rule) throw new Error(`${pathKey} cannot be edited from the control panel`);
  const t = rule.type;
  const bad = () => { throw new Error(`${pathKey}: invalid value`); };
  if (t === 'boolean') { if (typeof value !== 'boolean') bad(); return value; }
  if (t === 'string') { if (typeof value !== 'string' || value.length > 200) bad(); return value; }
  if (t === 'enum') { if (!rule.values.includes(value)) bad(); return value; }
  if (t === 'address') { if (typeof value !== 'string' || !ADDR.test(value)) bad(); return value; }
  if (t === 'address|null') { if (value !== null && (typeof value !== 'string' || !ADDR.test(value))) bad(); return value; }
  if (t === 'url|null') { if (value !== null && !(typeof value === 'string' && /^https:\/\/[^\s]+$/.test(value))) bad(); return value; }
  if (t === 'symbols') {
    if (!Array.isArray(value) || value.length > 50 || !value.every(v => typeof v === 'string' && SYM.test(v))) bad();
    return [...new Set(value)];
  }
  if (t === 'number' || t === 'number|null') {
    if (value === null && t === 'number|null') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) throw new Error(`${pathKey}: must be between ${rule.min} and ${rule.max}`);
    return n;
  }
  bad();
}

function setPath(obj, pathKey, value) {
  const parts = pathKey.split('.');
  let o = obj;
  for (const p of parts.slice(0, -1)) { if (typeof o[p] !== 'object' || o[p] === null) o[p] = {}; o = o[p]; }
  o[parts.at(-1)] = value;
}

function getPath(obj, pathKey) {
  return pathKey.split('.').reduce((o, p) => (o == null ? undefined : o[p]), obj);
}

export function newToken() { return randomBytes(24).toString('base64url'); }

function tokenOk(given, expected) {
  if (!given || !expected || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

const json = (res, code, body, extra = {}) => {
  const s = JSON.stringify(body);
  res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(s), ...extra});
  res.end(s);
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) { chunks.push(c); if (chunks.reduce((n, b) => n + b.length, 0) > 65536) throw new Error('body too large'); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export function createControlServer({runner, configPath = 'config/default.json', token = newToken(), root = 'control'}) {
  const base = path.resolve(root);
  const headers = {
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // The page itself. It receives the token once, via the URL you were
    // given in the terminal, and keeps it in memory.
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      try {
        const body = await readFile(path.join(base, 'index.html'));
        res.writeHead(200, {...headers, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store'});
        return res.end(body);
      } catch { res.writeHead(404, headers); return res.end(); }
    }

    if (!url.pathname.startsWith('/api/')) { res.writeHead(404, headers); return res.end(); }

    // Every API call is authenticated. Origin is also checked, because the
    // token lives in the page and a same-origin page is the only thing that
    // should be presenting it.
    const given = req.headers['x-zzy-token'];
    if (!tokenOk(given, token)) return json(res, 401, {error: 'missing or wrong token'}, headers);
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, {error: 'cross-origin request refused'}, headers);

    try {
      const route = `${req.method} ${url.pathname}`;
      switch (route) {
        case 'GET /api/state': {
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          const editable = Object.fromEntries(Object.keys(EDITABLE).map(k => [k, getPath(config, k) ?? null]));
          const eff = runner.config ?? config;   // the runner's config carries paper/fork paths
          let book = null, positions = null;
          try { book = await readBookState(eff); } catch {}
          try { positions = valuePositions(await loadPositions(eff), {}).rows; } catch {}
          return json(res, 200, {runner: runner.snapshot(), editable, book, positions, lines: runner.lines.slice(-120)}, headers);
        }
        case 'GET /api/log': return json(res, 200, {lines: runner.lines}, headers);
        case 'POST /api/resume': return json(res, 200, await runner.resume(), headers);
        case 'POST /api/pause': return json(res, 200, runner.pause(), headers);
        case 'POST /api/tick': {
          const r = await runner.tick();
          return json(res, 200, {result: r, runner: runner.snapshot()}, headers);
        }
        case 'POST /api/config': {
          const body = await readBody(req);
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          const applied = {};
          for (const [k, v] of Object.entries(body.set ?? {})) {
            const clean = validateEdit(k, v);         // throws on anything not allowlisted or out of range
            setPath(config, k, clean); applied[k] = clean;
          }
          await writeJsonAtomic(configPath, config, {backup: true});
          runner.log(`config updated: ${Object.keys(applied).join(', ') || 'nothing'}`);
          return json(res, 200, {applied}, headers);
        }
        case 'POST /api/preflight': {
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          const client = publicClient(config.chain?.rpcUrl);
          const account = runner.snapshot().wallet ?? config.runtime?.watchAddress ?? null;
          const report = await preflight(client, config, {account});
          runner.log(`preflight: ${report.passed} passed, ${report.failed} failed`);
          return json(res, 200, report, headers);
        }
        case 'POST /api/paper/reset': {
          const body = await readBody(req);
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          const amount = Number(body.capitalUsd ?? 500);
          if (!(amount > 0 && amount <= 1000000)) throw new Error('capital must be between 1 and 1,000,000');
          const r = await seedPaperCapital(config, amount);
          runner.log(`paper capital reset to $${amount}`);
          return json(res, 200, {file: r.file, tradingUsd: r.tradingUsd}, headers);
        }
        case 'POST /api/fork/buy': {
          const body = await readBody(req);
          const r = await runner.forceBuy(String(body.symbol || '').toUpperCase(), Number(body.usd || 20));
          return json(res, 200, r, headers);
        }
        case 'POST /api/fork/sell': {
          const body = await readBody(req);
          const r = await runner.forceSell(String(body.symbol || '').toUpperCase(), Number(body.fraction ?? 1));
          return json(res, 200, r, headers);
        }
        case 'POST /api/fork/verdict': {
          const body = await readBody(req);
          return json(res, 200, runner.setForkVerdict(String(body.symbol || ''), String(body.verdict || '').toUpperCase(), {reason: body.reason}), headers);
        }
        case 'POST /api/fork/exit': {
          const body = await readBody(req);
          return json(res, 200, runner.setForkExit(String(body.symbol || ''), String(body.action || '').toUpperCase(), {reason: body.reason}), headers);
        }
        case 'GET /api/ledger': {
          const config = JSON.parse(await readFile(configPath, 'utf8'));
          const cfg = runner.paper ? {...config, treasury: {...config.treasury, ledgerPath: config.paper?.ledgerPath}} : config;
          const ledger = await readLedger(cfg);
          return json(res, 200, {entries: ledger.entries.slice(-100)}, headers);
        }
        default: return json(res, 404, {error: 'no such route'}, headers);
      }
    } catch (e) {
      return json(res, 400, {error: e.message.split('\n')[0]}, headers);
    }
  });

  return {server, token};
}

export function listenControl({runner, configPath, port = 4664}) {
  const {server, token} = createControlServer({runner, configPath});
  // 127.0.0.1 is hardcoded. This must not be reachable from another machine.
  server.listen(port, '127.0.0.1', () => {
    console.log(`\nZZY control panel:\n\n  http://127.0.0.1:${port}/?token=${token}\n\nThis URL is your login. Don't share it, don't put it in a screenshot.\n`);
  });
  return {server, token};
}
