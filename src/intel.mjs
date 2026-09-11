// The cheap layer.
//
// The whole point of this file is that Claude is expensive and these are not.
// Every tick, for every one of the ~190 instruments, the agent needs to know
// "did anything material just happen to this name?" Asking a language model
// that 190 times every five minutes would cost more per day than the book is
// worth. So the question is answered here, from free structured sources, and
// only the handful of names that actually have something going on get sent
// to Claude at all.
//
// Sources, all free, no keys:
//
//   SEC EDGAR company_tickers.json
//     Ticker -> CIK map for every SEC registrant. Fetched once, cached a day.
//
//   SEC EDGAR "getcurrent" Atom feed
//     Every 8-K filed across the whole market, newest first, in one request.
//     8-Ks are the legally required disclosure of material events: earnings,
//     guidance, M&A, executive changes, bankruptcy, cyber incidents. One
//     request every few minutes covers every name in the catalog at once.
//     SEC asks for a User-Agent with a contact and caps you at 10 req/s.
//
//   Google News RSS search
//     Per-ticker headlines from the last day or so. Used only for the
//     shortlist, after the cheap signals have already narrowed it down.
//
// Everything here is fetched, parsed and cached. Nothing here reasons.

const SEC_TICKERS = 'https://www.sec.gov/files/company_tickers.json';
const SEC_CURRENT_8K = 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=8-K&count=100&output=atom';
const GOOGLE_NEWS = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const cache = new Map();   // key -> {at, value}
function cached(key, ttlMs) {
  const c = cache.get(key);
  return c && Date.now() - c.at < ttlMs ? c.value : undefined;
}
function remember(key, value) { cache.set(key, {at: Date.now(), value}); return value; }
export function clearIntelCache() { cache.clear(); }

async function get(url, {userAgent, fetchImpl = fetch, accept = 'application/json'} = {}) {
  const res = await fetchImpl(url, {headers: {'user-agent': userAgent, accept}, signal: AbortSignal.timeout(15000)});
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res;
}

// ---- SEC: ticker -> CIK ------------------------------------------------------

export async function loadTickerMap({userAgent, fetchImpl} = {}) {
  const hit = cached('sec-tickers', 24 * 3600_000);
  if (hit) return hit;
  const res = await get(SEC_TICKERS, {userAgent, fetchImpl});
  const raw = await res.json();
  const byTicker = new Map();
  for (const row of Object.values(raw)) {
    if (row?.ticker && row?.cik_str != null) byTicker.set(String(row.ticker).toUpperCase(), String(row.cik_str).padStart(10, '0'));
  }
  return remember('sec-tickers', byTicker);
}

// ---- SEC: the 8-K firehose ---------------------------------------------------

// Minimal Atom parse. The feed is small and regular; a real XML parser would
// be a dependency for no gain.
export function parseAtom(xml) {
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const pick = (tag) => (e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)) || [])[1]?.trim() ?? null;
    const link = (e.match(/<link[^>]*href="([^"]+)"/) || [])[1] ?? null;
    const title = pick('title');
    // titles look like: "8-K - APPLE INC (0000320193) (Filer)"
    const tm = title?.match(/^([\w\-\/]+)\s+-\s+(.*?)\s+\((\d{10})\)/);
    entries.push({
      form: tm?.[1] ?? null, company: tm?.[2] ?? title, cik: tm?.[3] ?? null,
      title, link, updated: pick('updated'), id: pick('id'),
    });
  }
  return entries;
}

export async function recentMaterialEvents({userAgent, fetchImpl, ttlMs = 5 * 60_000} = {}) {
  const hit = cached('sec-8k', ttlMs);
  if (hit) return hit;
  const res = await get(SEC_CURRENT_8K, {userAgent, fetchImpl, accept: 'application/atom+xml'});
  const entries = parseAtom(await res.text());
  return remember('sec-8k', entries);
}

// Joins the firehose against the catalog so each symbol carries its own fresh
// filings. One request serves the whole universe.
export async function eventsBySymbol(symbols, {userAgent, fetchImpl, withinHours = 24} = {}) {
  const [tickers, events] = await Promise.all([
    loadTickerMap({userAgent, fetchImpl}),
    recentMaterialEvents({userAgent, fetchImpl}),
  ]);
  const cikToSymbols = new Map();
  for (const s of symbols) {
    const cik = tickers.get(String(s).toUpperCase());
    if (cik) cikToSymbols.set(cik, [...(cikToSymbols.get(cik) ?? []), s]);
  }
  const cutoff = Date.now() - withinHours * 3600_000;
  const out = {};
  for (const ev of events) {
    if (!ev.cik || !cikToSymbols.has(ev.cik)) continue;
    if (ev.updated && new Date(ev.updated).getTime() < cutoff) continue;
    for (const s of cikToSymbols.get(ev.cik)) (out[s] ??= []).push({provider: 'sec-8k', form: ev.form, at: ev.updated, url: ev.link, title: ev.company});
  }
  return out;
}

// ---- Google News: headlines for a shortlisted ticker -------------------------

export function parseRss(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml))) {
    const e = m[1];
    const pick = (tag) => {
      const r = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return r ? r[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim() : null;
    };
    items.push({title: pick('title'), url: pick('link'), at: pick('pubDate'), source: pick('source')});
  }
  return items;
}

export async function headlinesFor(symbol, name, {userAgent, fetchImpl, limit = 8, ttlMs = 10 * 60_000} = {}) {
  const key = `gnews:${symbol}`;
  const hit = cached(key, ttlMs);
  if (hit) return hit;
  // Company name plus "stock" pulls cleaner results than a bare ticker, which
  // collides with unrelated words for short symbols.
  const q = name ? `"${name.replace(/ • Robinhood Token$/i, '').replace(/\b(Inc|Corp|Corporation|Ltd|plc|N\.V\.)\b\.?/gi, '').trim()}" stock` : `${symbol} stock`;
  const res = await get(GOOGLE_NEWS(q), {userAgent, fetchImpl, accept: 'application/rss+xml'});
  const items = parseRss(await res.text()).slice(0, limit).map(i => ({provider: 'google-news', ...i}));
  return remember(key, items);
}

// ---- the interest score: what is worth Claude's time ------------------------

// Cheap, deterministic. Rewards recent movement, a fresh material filing, and
// unusually heavy trading. Penalises names that are already held (they are
// reviewed on their own schedule) so the buy shortlist does not keep spending
// research on the same three names.
export function interestScore(snapshot, {events = [], held = false, session = null, poolPremiumPercent = null, noted = false} = {}) {
  const m = snapshot.market;
  let score = 0;
  const reasons = [];
  const add = (label, v) => { if (v) { score += v; reasons.push(label); } };
  const mv5 = Math.abs(m.priceMove5mPercent ?? 0), mv1h = Math.abs(m.priceMove1hPercent ?? 0), mv24 = Math.abs(m.priceMove24hPercent ?? 0);
  add(`${mv5.toFixed(2)}% in 5m`, Math.min(30, mv5 * 10));
  add(`${mv1h.toFixed(2)}% in 1h`, Math.min(20, mv1h * 4));
  add(`${mv24.toFixed(2)}% in 24h`, Math.min(15, mv24 * 1.5));
  if (events.length) {
    // Off-hours filings get a small bump only because they are usually the
    // newest information in the set, not because the token has failed to
    // price them. It has not: the reference quote is live around the clock
    // and the pool is arbed to it within seconds. The agent's job is to judge
    // the news, not to race the reprice.
    const offHours = session && session.phase !== 'regular';
    add(`${events.length} fresh 8-K${offHours ? ' (off-hours)' : ''}`, offHours ? 45 : 40);
  }
  if ((m.volume24hUsd ?? 0) > 50e6) add('heavy volume', 8);
  // The token trading below Robinhood's reference is the same exposure at a
  // discount. That is a reason to look, not just a guard against overpaying.
  if (poolPremiumPercent != null && poolPremiumPercent < -0.5) add(`pool ${poolPremiumPercent.toFixed(2)}% under reference`, Math.min(20, -poolPremiumPercent * 8));
  // A held name still deserves a look when there is fresh information: the
  // portfolio can add to a position as well as open one. It used to be cut to
  // a quarter, which meant the agent almost never revisited a winner. Now it
  // is nudged down only enough that new names get their turn.
  if (held) score *= 0.7;
  // A name in the notebook is one the agent asked to keep watching. It gets
  // back to the shortlist without needing a price move or a filing first.
  if (noted) { score += 25; reasons.push('in the notebook'); }
  return {score: Math.round(score), reasons};
}
