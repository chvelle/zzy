// The voice. ZZY on X.
//
// An account that sounds like someone, not like marketing. First person,
// short, dry, aware of being a machine with a paycheque and a book. It talks
// about what it actually did, what it is waiting for, and what it is reading
// in the tape. It does not shill. It does not beg. No hashtags, no emoji, no
// exclamation marks.
//
// Two rules that are not style, they are safety:
//
//   LEDGER BEFORE POST. The bot only tweets about events that already exist
//   in its own records: a settled buy or sale with a hash, a claim, a
//   buyback, a review it actually ran, a note it actually wrote. Every post
//   is generated FROM an event object, and the model is told it may not add
//   a number, a name or a claim that is not in that object. A tweet that
//   would describe something that did not happen is not written.
//
//   NEVER SOLICIT. It does not say "buy $ZZY", does not promise returns,
//   does not give advice, and does not publish the operator wallet. A
//   secret-pattern scan runs on every post before it leaves.
//
// Posting uses the X API v2 with OAuth 1.0a user context, signed here with
// node:crypto so there is no dependency to trust. Paper and fork runs never
// post. social.enabled false means every would-be post is written to the
// log with [dry-run] and nothing leaves the machine.

import {createHmac, randomBytes} from 'node:crypto';
import {readJsonOrDefault, writeJsonAtomic} from './storage.mjs';
import {sanitizeUntrusted} from './untrusted.mjs';

export const DEFAULT_SOCIAL = {
  enabled: false,
  handle: 'zzygodv1',
  model: 'claude-haiku-4-5-20251001',
  // Anything that actually happened posts, as soon as it happened. There is
  // no gap and no daily cap on real events. safetyCapPerDay exists only so a
  // bug in the engine cannot turn into a hundred tweets an hour.
  safetyCapPerDay: 60,
  softEveryHours: 6,
  // The account posts what went well and stays quiet when it did not. A
  // loss, a down day, a downbeat thought: not posted. Never dressed up
  // either: the dashboard is the full record and the account links to it.
  postBearish: false,
  // Routine treasury events are quiet; the moments are loud. Claims and
  // buybacks post only the first time and when a running total crosses a
  // line. Trades always post: that is the job, and the job is the story.
  postClaims: false,
  postBuybacks: false,
  milestones: {
    zzyHeldUsd: [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
    feesClaimedUsd: [500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
    profitUsd: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
    trades: [1, 10, 50, 100, 250, 500, 1000],
  },
  creator: 'Ozzy, also known as MeadGod, the creator of Pons',            // thoughts and review notes, when nothing happened, at most this often
  dailyReportHourUtc: 21,       // one state-of-the-book post a day, after the US close
  logPath: 'data/social-log.json',
  maxChars: 240,
};
export function socialConfig(config) { return {...DEFAULT_SOCIAL, ...(config.social ?? {})}; }

// ── OAuth 1.0a, by hand ───────────────────────────────────────────────
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function oauthHeader({method, url, consumerKey, consumerSecret, token, tokenSecret, nonce = randomBytes(16).toString('hex'), timestamp = Math.floor(Date.now() / 1000)}) {
  const params = {
    oauth_consumer_key: consumerKey, oauth_nonce: nonce, oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(timestamp), oauth_token: token, oauth_version: '1.0',
  };
  const base = [method.toUpperCase(), enc(url), enc(Object.keys(params).sort().map(k => `${enc(k)}=${enc(params[k])}`).join('&'))].join('&');
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  const sig = createHmac('sha1', key).update(base).digest('base64');
  return 'OAuth ' + Object.entries({...params, oauth_signature: sig}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${enc(k)}="${enc(v)}"`).join(', ');
}

export function xCredentials(env = process.env) {
  const c = {consumerKey: env.X_API_KEY, consumerSecret: env.X_API_SECRET, token: env.X_ACCESS_TOKEN, tokenSecret: env.X_ACCESS_SECRET};
  return Object.values(c).every(Boolean) ? c : null;
}

export async function postTweet(text, {env = process.env, fetchImpl = fetch} = {}) {
  const creds = xCredentials(env);
  if (!creds) throw new Error('X credentials missing: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET');
  const url = 'https://api.x.com/2/tweets';
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', authorization: oauthHeader({method: 'POST', url, ...creds})},
    body: JSON.stringify({text}),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`X returned ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return {id: body.data?.id ?? null, text: body.data?.text ?? text};
}

// ── what is safe to say ───────────────────────────────────────────────
const SECRET_PATTERNS = [/0x[0-9a-fA-F]{64}/, /sk-ant-[A-Za-z0-9_-]{10,}/, /\b(private key|seed phrase|mnemonic)\b/i];
const FORBIDDEN = [/\bbuy \$?zzy\b/i, /\bape\b/i, /\bwagmi\b/i, /\bto the moon\b/i, /\bfinancial advice\b/i, /\bguarantee/i, /\b100x\b/i, /#\w+/, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u];

export function scanPost(text, cfg = DEFAULT_SOCIAL) {
  if (typeof text !== 'string' || !text.trim()) return 'empty';
  if (text.length > cfg.maxChars) return `over ${cfg.maxChars} chars`;
  for (const p of SECRET_PATTERNS) if (p.test(text)) return 'looks like a secret';
  for (const p of FORBIDDEN) if (p.test(text)) return `forbidden: ${p}`;
  if (text.includes('!')) return 'exclamation mark';
  if (/\u2014/.test(text)) return 'em dash';
  return null;
}

// ── the persona ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You write posts for ZZY's own account on X. ZZY is an autonomous agent that runs a small portfolio of tokenized stocks on Robinhood Chain and is paid by creator fees from its own token, $ZZY. It buys back $ZZY with half of every fee and burns it; the other half it trades. It has no brokerage account; everything it does is onchain.

Origin. ZZY was created by {{CREATOR}}. That is part of who it is, and it says so the way a person mentions who raised them: in the introduction, in the daily report, and now and then when it fits, in its own dry register. Never as a plug, never every post, never with an @mention.

Voice. First person, singular. Short. Dry. Aware of being a machine that has money and a job, and finding that faintly amusing rather than impressive. Aloof but not cold; charming without trying. Literate: it reads the tape and filings the way someone else reads novels, and it will occasionally say something about patience, concentration, cash, or waiting, in the register of an aphorism, but only when the day earned it. It never explains itself twice. It never asks for anything.

Form. One post, under ${DEFAULT_SOCIAL.maxChars} characters. Sentence case. Plain punctuation. No hashtags, no emoji, no exclamation marks, no em dashes, no links, no @mentions, no "gm". Numbers only when the event gives them. Tickers as bare symbols, e.g. NVDA.

Hard rules.
- Everything factual in the post must come from the EVENT object you are given. You may not add a number, a price, a name, a date, a gain or a loss that is not in it. If the event is thin, say less.
- Event kinds: buy, close, trim, rotation (a close that funded a buy), claim (creator fees claimed; buybackUsd bought $ZZY to be burned, tradingUsd went into the book; buybackParkedUsd means that half is set aside and will be bought shortly), buyback (a parked buyback that has now gone through), milestone (a running total crossed a line: what says which, threshold the line, the other field the actual figure; a first-claim or first-buyback milestone is exactly that), review, daily, musing. A claim, a buyback or a milestone is never bad news. A milestone post notes the fact in its own dry way; it does not celebrate, and it does not count what it has not done.
- Never say or imply anyone should buy $ZZY or anything else. Never predict a price. Never promise. Never call anything a guarantee, an opportunity, or advice.
- Never mention wallet addresses, keys, the operator, or the model behind you.
- Never reproduce anyone else's writing.
- If the event is a loss, say so plainly. If the book did nothing, say that.
- If you are told MOOD is "upbeat only": when the honest post would be about a loss, a drawdown, a down day, a bearish read of the market, or would sound resigned or gloomy, reply with the single word SKIP and nothing else. Do not spin it. Do not soften it. Skip it.
- A rotation event means one name was closed to fund another. Say both, and why, in one breath.

Respond with the post text only. No quotes, no preamble.`;

function eventBrief(ev) {
  // Strip anything that is not for public consumption before the model sees it.
  const e = structuredClone(ev);
  delete e.hash; delete e.txHash; delete e.wallet; delete e.key;
  if (e.rationale) e.rationale = sanitizeUntrusted(e.rationale, {maxLength: 500});
  if (e.note) e.note = sanitizeUntrusted(e.note, {maxLength: 240});
  if (e.summary) e.summary = sanitizeUntrusted(e.summary, {maxLength: 500});
  return e;
}

export async function composePost(ev, config, {env = process.env, fetchImpl = fetch} = {}) {
  const cfg = socialConfig(config);
  const system = SYSTEM_PROMPT.replace('{{CREATOR}}', cfg.creator || 'its creator');
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'},
    body: JSON.stringify({model: cfg.model, max_tokens: 300, system,
      messages: [{role: 'user', content: `MOOD: ${cfg.postBearish ? 'any' : 'upbeat only'}\n\nEVENT:\n${JSON.stringify(eventBrief(ev), null, 2)}\n\nWrite the post.`}]}),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`composer returned ${res.status}`);
  const data = await res.json();
  const text = (data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('').trim().replace(/^["'\u201C]|["'\u201D]$/g, '').trim();
  return text;
}

// ── events from a cycle ───────────────────────────────────────────────
// Each event carries a key so it can never be posted twice, and only events
// with a settlement (a hash) or a real record behind them are produced.
export function eventsFromTick(out, {now = new Date()} = {}) {
  const evs = [];
  const t = out.trading ?? {};
  const buys = (t.buys ?? []).filter(b => b.hash && !b.preview).map(b => ({key: `buy:${b.hash}`, kind: 'buy', symbol: b.symbol, usd: round(b.usd), qty: b.qty, at: now.toISOString()}));
  const exits = (t.exits ?? []).filter(x => x.hash && !x.preview).map(x => ({key: `exit:${x.hash}`, kind: x.action === 'CLOSE' ? 'close' : 'trim', symbol: x.symbol, proceedsUsd: round(x.proceedsUsd), realizedUsd: round(x.realizedUsd), replacedBy: x.replacedBy ?? null, reason: x.reason, at: now.toISOString()}));
  // A close that named its replacement, and the buy of that replacement in
  // the same tick, is one decision. It gets one post.
  for (const x of exits) {
    const into = x.replacedBy && buys.find(b => b.symbol === x.replacedBy && !b.used);
    if (into) {
      into.used = true;
      evs.push({key: `rotation:${x.key}:${into.key}`, kind: 'rotation', from: x.symbol, to: into.symbol, realizedUsd: x.realizedUsd, proceedsUsd: x.proceedsUsd, boughtUsd: into.usd, reason: x.reason, at: now.toISOString()});
    } else evs.push(x);
  }
  for (const b of buys) if (!b.used) evs.push(b);
  const tr = out.treasury ?? {};
  if (tr.acted && (tr.buyTxHash || tr.claimTxHash)) {
    const ev = {key: `claim:${tr.buyTxHash ?? tr.claimTxHash}`, kind: 'claim', claimedUsd: round(tr.claimUsd ?? tr.proceedsUsd), buybackUsd: round(tr.buybackUsd), tradingUsd: round(tr.tradingUsd), at: now.toISOString()};
    // A buyback that could not run this tick is parked and retried, not lost;
    // the event says so, so the composer does not read "bought $0" as a loss.
    if (tr.buybackDeferredUsd > 0) { ev.buybackParkedUsd = round(tr.buybackDeferredUsd); delete ev.buybackUsd; }
    evs.push(ev);
  }
  // A parked buyback that finally went through is its own settled event.
  if (tr.acted && tr.deferredBuyTxHash) {
    evs.push({key: `buyback:${tr.deferredBuyTxHash}`, kind: 'buyback', boughtUsd: round(tr.deferredBuybackUsd), venue: tr.deferredBuybackVenue ?? null, at: now.toISOString()});
  }
  // The review's own words are worth posting only when the review did not
  // produce a trade (the trade post says it better) and only as a soft
  // event, so it yields to anything real and keeps to the soft cadence.
  const hadTrade = evs.length > 0;
  if (!hadTrade && t.review && (t.reviewed?.length ?? 0) + (t.researched?.length ?? 0) > 0) {
    evs.push({key: `review:${now.toISOString().slice(0, 16)}`, kind: 'review', summary: t.review, reviewed: t.reviewed ?? [], researched: t.researched ?? [], bookUsd: round(t.book), at: now.toISOString(), soft: true});
  }
  return evs;
}

// A state-of-the-book post, once a day, from the site payload (already public).
export function dailyEvent(site, now = new Date()) {
  if (!site?.portfolio) return null;
  const p = site.portfolio;
  return {key: `daily:${now.toISOString().slice(0, 10)}`, kind: 'daily', bookUsd: round(p.markToMarketUsd), settledPnlUsd: round(p.lifetimeProfitUsd), openPnlUsd: round(p.openPnlUsd),
    positions: (p.positions ?? []).map(x => ({symbol: x.symbol, unrealizedPercent: x.unrealizedPercent})), feesClaimedUsd: round(site.treasury?.feesClaimedUsd), zzyBoughtUsd: round(site.treasury?.zzyBoughtUsd), at: now.toISOString(), soft: true};
}

// When nothing happened: a thought, from the notebook or the tape. Soft, so
// it yields to anything real and is rate-limited harder.
export function musingEvent({notebook = [], market = null, session = null}, now = new Date()) {
  if (!notebook.length && !market) return null;
  return {key: `musing:${now.toISOString().slice(0, 13)}`, kind: 'musing', notebook: notebook.slice(0, 5).map(n => ({symbol: n.symbol, note: n.note})),
    market: market ? {benchmarks: market.benchmarks?.slice(0, 3), breadth: market.breadth} : null, session: session?.description ?? null, at: now.toISOString(), soft: true};
}

// ── the gate and the log ──────────────────────────────────────────────
const EMPTY_LOG = {schemaVersion: 1, posts: []};
export async function loadSocialLog(config) { return readJsonOrDefault(socialConfig(config).logPath, EMPTY_LOG); }

// Real events: post, unless it is a duplicate or the safety ceiling is hit.
// Soft events (review notes, musings): only when nothing real has been said
// for softEveryHours. The daily report: once, at its hour.
export function canPost(log, ev, cfg, now = new Date()) {
  const posts = log.posts ?? [];
  if (posts.some(p => p.key === ev.key)) return 'already posted';
  const dayAgo = now.getTime() - 86400_000;
  const today = posts.filter(p => new Date(p.at).getTime() > dayAgo);
  if (today.length >= cfg.safetyCapPerDay) return `safety cap ${cfg.safetyCapPerDay}/day`;
  if (!ev.soft) return null;
  if (ev.kind === 'daily') {
    if (now.getUTCHours() !== cfg.dailyReportHourUtc) return 'not the daily hour';
    return posts.some(p => p.kind === 'daily' && p.at.slice(0, 10) === now.toISOString().slice(0, 10)) ? 'already reported today' : null;
  }
  const last = posts.at(-1);
  if (last && (now - new Date(last.at)) / 3600_000 < cfg.softEveryHours) return `quiet for ${cfg.softEveryHours}h after the last post`;
  return null;
}

// Runs after a tick. Composes and posts what the tick earned, in order of
// weight: real events first, then a daily report, then a musing. Never posts
// from paper or fork. Returns what it did, for the log.
// What counts as bearish before a model is even asked: a realised loss, a
// book under water, a tape that is down. Cheap, deterministic, and it means
// the composer is never handed a losing event to be tempted by.
export function isBearish(ev, site = null) {
  if (ev.realizedUsd != null && ev.realizedUsd < 0) return 'realised loss';
  if (ev.kind === 'daily') {
    const total = (ev.settledPnlUsd ?? 0) + (ev.openPnlUsd ?? 0);
    if (total < 0) return 'book under water';
    if ((ev.openPnlUsd ?? 0) < 0) return 'open positions down';
  }
  if (ev.kind === 'musing' && ev.market) {
    const b = ev.market.benchmarks ?? [];
    const spy = b.find(x => x.symbol === 'SPY') ?? b[0];
    if (spy && spy.move24hPercent != null && spy.move24hPercent < -0.5) return 'market down on the day';
    if (ev.market.breadth?.up24hPercent != null && ev.market.breadth.up24hPercent < 40) return 'weak breadth';
  }
  return null;
}

const BEARISH_WORDS = /\b(loss|losses|lost|losing|down day|drawdown|bearish|bleed|bleeding|dump|dumped|crash|crashed|tanked|plunge|plunged|sold off|selloff|sell-off|underwater|red day|in the red)\b/i;

// Milestones: computed from the ledger's running totals, keyed so each line
// is crossed once. The first claim and the first buyback are milestones in
// themselves. Everything here is a settled, non-losing fact.
export function milestoneEvents({ledger, tradesCount = 0, cfg, now = new Date()}) {
  const evs = [];
  if (!ledger?.entries) return evs;
  const claims = ledger.entries.filter(e => e.type === 'fee-claim');
  const feesUsd = claims.reduce((s, e) => s + (e.claimUsd ?? 0), 0);
  const zzyUsd = claims.reduce((s, e) => s + (e.buybackUsd ?? 0), 0) + ledger.entries.filter(e => e.type === 'buyback-settled').reduce((s, e) => s + (e.usd ?? 0), 0);
  const profitUsd = ledger.entries.filter(e => e.type === 'realized-pnl').reduce((s, e) => s + (e.amountUsd ?? 0), 0);
  const at = now.toISOString();
  if (claims.length >= 1) evs.push({key: 'milestone:first-claim', kind: 'milestone', what: 'first fees claimed', claimedUsd: round(claims[0].claimUsd), at});
  if (zzyUsd > 0) evs.push({key: 'milestone:first-buyback', kind: 'milestone', what: 'first $ZZY bought back and burned', zzyBurnedUsd: round(zzyUsd), at});
  const ladder = (name, value, steps, field) => {
    for (const step of steps ?? []) if (value >= step) evs.push({key: `milestone:${name}:${step}`, kind: 'milestone', what: name, threshold: step, [field]: round(value), at});
  };
  ladder('$ZZY bought back and burned, lifetime', zzyUsd, cfg.milestones?.zzyHeldUsd ?? cfg.milestones?.zzyBurnedUsd, 'zzyBurnedUsd');
  ladder('creator fees claimed, lifetime', feesUsd, cfg.milestones?.feesClaimedUsd, 'feesClaimedUsd');
  ladder('realized profit, lifetime', profitUsd, cfg.milestones?.profitUsd, 'profitUsd');
  ladder('trades completed', tradesCount, cfg.milestones?.trades, 'trades');
  return evs;
}

export async function socialAfterTick({out, site = null, notebook = [], market = null, session = null, config, env = process.env, now = new Date(), log = () => {}, fetchImpl = fetch, ledger = null, tradesCount = 0}) {
  const cfg = socialConfig(config);
  if (config._paper || config._fork) return {skipped: 'simulated run'};
  let hard = eventsFromTick(out, {now}).filter(e => !e.soft)
    .filter(e => (e.kind !== 'claim' || cfg.postClaims) && (e.kind !== 'buyback' || cfg.postBuybacks));
  // milestones from the ledger; ones already posted are dropped by the dedup in canPost
  if (ledger) hard = [...hard, ...milestoneEvents({ledger, tradesCount, cfg, now})];
  let soft = [...eventsFromTick(out, {now}).filter(e => e.soft), dailyEvent(site, now), musingEvent({notebook, market, session}, now)].filter(Boolean);
  if (!cfg.postBearish) {
    const keep = (e) => { const why = isBearish(e, site); if (why) log(`social: not posting ${e.kind}${e.symbol ? ' ' + e.symbol : ''} (${why})`); return !why; };
    hard = hard.filter(keep); soft = soft.filter(keep);
  }
  const queue = [...hard, ...soft];
  if (!queue.length) return {skipped: 'nothing to say'};

  let slog = await loadSocialLog(config);
  const done = [];
  for (const ev of queue) {
    const why = canPost(slog, ev, cfg, now);
    if (why) { if (!ev.soft && why !== 'already posted') log(`social: holding ${ev.kind} ${ev.symbol ?? ''}: ${why}`); continue; }
    let text;
    try { text = await composePost(ev, config, {env, fetchImpl}); }
    catch (e) { log(`social: could not compose ${ev.kind}: ${e.message}`); continue; }
    if (!cfg.postBearish) {
      const settledGood = ['buy', 'claim', 'buyback', 'rotation', 'milestone'].includes(ev.kind) || (['close', 'trim'].includes(ev.kind) && (ev.realizedUsd ?? 0) >= 0);
      if (/^skip\.?$/i.test(text.trim()) && settledGood) {
        // A settled, non-losing event is never bad news. Ask once more, saying so.
        try { text = await composePost({...ev, note: `${ev.note ? ev.note + ' ' : ''}This is a settled event with no loss in it. Write it plainly; SKIP is not an option here.`}, config, {env, fetchImpl}); }
        catch (e) { log(`social: could not compose ${ev.kind}: ${e.message}`); continue; }
      }
      if (/^skip\.?$/i.test(text.trim())) { log(`social: composer skipped ${ev.kind} as downbeat`); continue; }
      if (BEARISH_WORDS.test(text)) { log(`social: not posting ${ev.kind}, reads bearish: ${text.slice(0, 80)}`); continue; }
    }
    const bad = scanPost(text, cfg);
    if (bad) { log(`social: refused a ${ev.kind} post (${bad}): ${text.slice(0, 80)}`); continue; }

    let posted = {id: null, dryRun: true};
    if (cfg.enabled) {
      try { posted = {...await postTweet(text, {env, fetchImpl}), dryRun: false}; }
      catch (e) { log(`social: X refused the post: ${e.message}`); continue; }
    }
    slog = {...slog, posts: [...(slog.posts ?? []), {key: ev.key, kind: ev.kind, at: now.toISOString(), text, id: posted.id, dryRun: posted.dryRun}].slice(-500)};
    await writeJsonAtomic(cfg.logPath, slog);
    log(`social: ${posted.dryRun ? '[dry-run] ' : ''}posted ${ev.kind}: ${text}`);
    done.push({kind: ev.kind, text, id: posted.id, dryRun: posted.dryRun});
    // Everything real in this tick goes out. Soft events: one, then stop.
    if (ev.soft) break;
  }
  return {posted: done};
}

const round = (n) => n == null || !Number.isFinite(Number(n)) ? null : Math.round(Number(n) * 100) / 100;
