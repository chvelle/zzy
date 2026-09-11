// News ingestion. The answer to "what's the best news source" is layered:
//
//   1. PRIMARY SOURCE, free, official: SEC EDGAR full-text search. 8-Ks are
//      the legally required disclosure of material events (earnings, guidance,
//      M&A, executive changes). Nothing beats it for "what actually happened";
//      it just isn't fast -- companies file within four business days, often
//      after the market has already reacted.
//   2. LOW-LATENCY WIRE (paid): a real-time headline API. This module exposes
//      a provider hook for one; it ships without a default because every
//      option costs money and which one is worth it depends on your budget.
//   3. INTERPRETATION: allocator.mjs, where the model reads (1)+(2)+the price
//      series with web search on top, and decides what it means.
//
// Be honest with yourself about what this can and can't do: by the time a
// headline is in any feed you can afford, professional desks have traded it.
// The realistic edge is not speed, it's not being wrong -- avoiding names
// with a halt, a pending split, or a fresh 8-K you'd otherwise miss.

const EDGAR = 'https://efts.sec.gov/LATEST/search-index';

export async function edgarRecentFilings({symbol, name, forms = ['8-K'], days = 7, userAgent, fetchImpl = fetch, now = new Date()}) {
  if (!userAgent) throw new Error('SEC fair-access policy requires a User-Agent with app name + contact email (config.news.edgarUserAgent)');
  const end = now.toISOString().slice(0, 10);
  const start = new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
  const q = encodeURIComponent(`"${name ?? symbol}"`);
  const url = `${EDGAR}?q=${q}&forms=${forms.join(',')}&dateRange=custom&startdt=${start}&enddt=${end}&from=0`;
  const res = await fetchImpl(url, {headers: {'User-Agent': userAgent, accept: 'application/json'}, signal: AbortSignal.timeout(15000)});
  if (!res.ok) throw new Error(`EDGAR ${res.status}`);
  const json = await res.json();
  return (json.hits?.hits ?? []).map(h => {
    const s = h._source ?? {};
    const cik = String(s.ciks?.[0] ?? '').replace(/^0+/, '');
    const adsh = s.adsh ?? '';
    return {
      provider: 'sec-edgar',
      form: s.form ?? s.file_type ?? null,
      filedAt: s.file_date ?? null,
      entity: s.display_names?.[0] ?? null,
      url: cik && adsh ? `https://www.sec.gov/Archives/edgar/data/${cik}/${adsh.replace(/-/g, '')}/${adsh}-index.html` : null,
    };
  });
}

// Aggregates every configured provider for a symbol. Providers are functions
// (symbol, ctx) => Promise<item[]>; a failing provider yields [] and a note,
// never a crash -- missing news is a reason to be cautious, not to stop.
export async function gatherNews(symbol, name, config, providers = {}, fetchImpl = fetch) {
  const items = [];
  const errors = [];
  if (config.news?.edgar !== false) {
    try {
      items.push(...await edgarRecentFilings({symbol, name, userAgent: config.news?.edgarUserAgent, days: config.news?.lookbackDays ?? 7, fetchImpl}));
    } catch (e) { errors.push(`sec-edgar: ${e.message}`); }
  }
  for (const [pname, fn] of Object.entries(providers)) {
    try { items.push(...await fn(symbol, {config, fetchImpl})); }
    catch (e) { errors.push(`${pname}: ${e.message}`); }
  }
  return {items, errors};
}
