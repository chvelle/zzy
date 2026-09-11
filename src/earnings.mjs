// Earnings calendar.
//
// A report date is the most predictable volatility event a stock has, and
// the one thing about a name that is a fact rather than a judgement. Until
// now the bot learned a company had reported when the 8-K arrived, after the
// fact, so it could walk into a position the evening before a print without
// knowing. That is not a thesis, it is a coin flip.
//
// Source: Nasdaq's public calendar endpoint, one request per day in the
// window. It needs a browser-like User-Agent, it is free, and it has been
// stable for years. Fourteen days are fetched at a time and the result is
// written to disk, so a restart does not refetch and the steady-state cost
// is fourteen small requests every twelve hours.
//
// Two uses, and the first one saves money rather than spending it:
//   1. Blackout. A candidate reporting within policy.earningsBlackoutDays is
//      dropped BEFORE research. The bot has no edge on a print and should
//      not pay to reason about one.
//   2. Context. Every holding and candidate carries its next report date
//      into the review, so "reports Tuesday, wait" is a decision it can make.

import {readJsonOrDefault, writeJsonAtomic} from './storage.mjs';

const NASDAQ = 'https://api.nasdaq.com/api/calendar/earnings';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const DEFAULT_EARNINGS = {path: 'data/earnings.json', windowDays: 14, refreshHours: 12, blackoutDays: 1};
export function earningsConfig(config) { return {...DEFAULT_EARNINGS, ...(config.earnings ?? {}), blackoutDays: config.policy?.earningsBlackoutDays ?? config.earnings?.blackoutDays ?? DEFAULT_EARNINGS.blackoutDays}; }

const day = (d) => d.toISOString().slice(0, 10);

function whenOf(t) {
  const s = String(t ?? '').toLowerCase();
  if (s.includes('pre')) return 'pre-market';
  if (s.includes('after')) return 'after-hours';
  return 'unknown';
}

// Fetches the window. Returns {fetchedAt, from, to, bySymbol: {SYM: {date, when, epsForecast}}}.
export async function fetchEarningsWindow({fetchImpl = fetch, now = new Date(), days = 14, concurrency = 4} = {}) {
  const dates = Array.from({length: days}, (_, i) => day(new Date(now.getTime() + i * 86400_000)));
  const bySymbol = {};
  let failures = 0;
  let i = 0;
  await Promise.all(Array.from({length: Math.min(concurrency, dates.length)}, async () => {
    while (i < dates.length) {
      const d = dates[i++];
      try {
        const res = await fetchImpl(`${NASDAQ}?date=${d}`, {headers: {'user-agent': UA, accept: 'application/json'}, signal: AbortSignal.timeout(15000)});
        if (!res.ok) { failures++; continue; }
        const json = await res.json();
        for (const row of json?.data?.rows ?? []) {
          const sym = String(row.symbol ?? '').toUpperCase();
          if (!sym) continue;
          // Earliest date wins if a symbol somehow appears twice.
          if (!bySymbol[sym] || bySymbol[sym].date > d) {
            // An absent forecast must stay null: Number('') is 0, and a
            // forecast of exactly zero would be a real claim.
            const cleaned = String(row.epsForecast ?? '').replace(/[^0-9.-]/g, '');
            const eps = cleaned === '' ? null : Number(cleaned);
            bySymbol[sym] = {date: d, when: whenOf(row.time), epsForecast: Number.isFinite(eps) ? eps : null};
          }
        }
      } catch { failures++; }
    }
  }));
  return {fetchedAt: now.toISOString(), from: dates[0], to: dates.at(-1), days: dates.length, failures, bySymbol};
}

// Loads from disk, refreshing when stale. Never throws: a calendar that
// cannot be fetched is reported as absent, and the caller treats absent as
// "unknown", not as "no report coming".
export async function loadEarnings(config, {fetchImpl = fetch, now = new Date(), log = () => {}} = {}) {
  const cfg = earningsConfig(config);
  let cal = null;
  try { cal = await readJsonOrDefault(cfg.path, null); } catch (e) { log(`earnings cache unreadable, refetching: ${e.message}`); }
  const fresh = cal && (now - new Date(cal.fetchedAt)) / 3600_000 < cfg.refreshHours && cal.to >= day(now);
  if (fresh) return cal;
  try {
    const next = await fetchEarningsWindow({fetchImpl, now, days: cfg.windowDays});
    if (next.failures === next.days) throw new Error('every day in the window failed');
    await writeJsonAtomic(cfg.path, next);
    log(`earnings calendar: ${Object.keys(next.bySymbol).length} names reporting in the next ${next.days} days${next.failures ? `, ${next.failures} days failed to load` : ''}`);
    return next;
  } catch (e) {
    log(`earnings calendar unavailable: ${e.message}${cal ? ', using the stale copy' : ''}`);
    return cal;
  }
}

// What the review is told about one name. Compact on purpose: it is
// repeated for every holding and candidate in the prompt.
export function earningsFor(symbol, cal, now = new Date()) {
  if (!cal?.bySymbol) return {status: 'unknown'};
  const e = cal.bySymbol[String(symbol).toUpperCase()];
  if (!e) return {status: 'none-in-window', windowTo: cal.to};
  const daysUntil = Math.round((new Date(e.date + 'T00:00:00Z') - new Date(day(now) + 'T00:00:00Z')) / 86400_000);
  return {status: daysUntil <= 0 ? 'today' : 'upcoming', date: e.date, when: e.when, daysUntil, epsForecast: e.epsForecast};
}

// Deterministic. True when a NEW position should not be opened because the
// print is inside the blackout. Holdings are never force-sold by this; the
// review sees the date and decides.
export function inBlackout(symbol, cal, config, now = new Date()) {
  const cfg = earningsConfig(config);
  const e = earningsFor(symbol, cal, now);
  if (e.status !== 'upcoming' && e.status !== 'today') return null;
  if (e.daysUntil > cfg.blackoutDays) return null;
  return `reports ${e.date}${e.when !== 'unknown' ? ` ${e.when}` : ''}, inside the ${cfg.blackoutDays}-day blackout`;
}
