import {readdir, readFile} from 'node:fs/promises';
import {writeJsonAtomic} from './storage.mjs';
import {loadHistory, addPoint, saveHistory} from './pnl-history.mjs';
import path from 'node:path';
import {readLedger, zzyHeldForever} from './treasury.mjs';
import {loadCatalog, catalogProblems, listSymbols} from './catalog.mjs';
import {deployable} from './profit.mjs';
import {loadPositions, valuePositions} from './positions.mjs';
import {fetchQuote} from './adapters/robinhood-rhj.mjs';

// Builds the JSON the public dashboard renders.
//
// Everything here is derived from what the agent actually did: the treasury
// ledger (which only ever records settled transactions with a txHash) and
// the decision files it wrote. Nothing is estimated, projected, or filled
// in. This matters because the page has a buy button on it.
//
// SECURITY: this is the ONLY thing the public server exposes, so it is the
// only place a leak could happen. It reads config and the ledger and emits
// a fixed allowlist of fields. It never reads process.env, never touches
// the signer, and never includes file paths, RPC URLs, or anything under
// pons.*/uniswap.* config. tests/site-data.test.mjs asserts that a private
// key present in the environment cannot appear in the output.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function readDecisions(dir = 'decisions') {
  let files;
  try { files = (await readdir(dir)).filter(f => f.endsWith('.json')).sort().reverse(); }
  catch { return []; }
  const out = [];
  for (const f of files.slice(0, 60)) {
    try {
      const d = JSON.parse(await readFile(path.join(dir, f), 'utf8'));
      out.push({
        at: d.generatedAt,
        symbol: d.asset?.symbol ?? null,
        decision: d.decision,
        confidence: d.confidence,
        source: d.decisionSource ?? 'heuristic',
        rationale: (d.rationale ?? d.summary ?? '').slice(0, 240),
        sample: Boolean(d.sample),
      });
    } catch { /* skip unreadable decision file */ }
  }
  return out;
}

// A short, honest description of what the bot is doing right now, derived
// only from real state. Never a guess dressed up as activity.
function phaseOf(config, capital, decisions) {
  if (config.mode !== 'live') return 'Reasoning only, not signing';
  if (capital.deployableUsd <= 0) return 'Waiting on fees';
  const latest = decisions[0];
  if (latest && (Date.now() - new Date(latest.at)) / 1000 < 600) return `Reviewing ${latest.symbol}`;
  return 'Scanning markets';
}

// Reference prices for the symbols currently held. Read-only, no chain call,
// no key. A symbol that fails to quote is left null and its position is
// reported at cost rather than at a guess.
async function quoteHeld(symbols, quote) {
  const out = {};
  await Promise.all(symbols.map(async (sym) => {
    try { const q = await quote(sym); if (q?.mid > 0) out[sym] = q.mid; } catch { /* leave unpriced */ }
  }));
  return out;
}

export async function buildSiteData(config, {now = new Date(), wallet = null, quote = fetchQuote} = {}) {
  const raw = await readLedger(config);
  // Simulated money must never reach a public page. Paper and fork entries are dropped
  // here regardless of which ledger path the exporter was pointed at.
  const ledger = {...raw, entries: (raw.entries ?? []).filter(e => !e.paper && !e.fork)};
  const book = deployable(ledger, config);
  const store = await loadPositions(config);
  const priceBySymbol = await quoteHeld(valuePositions(store, {}).rows.map(r => r.symbol), quote);
  const held = valuePositions(store, priceBySymbol);
  const zzy = zzyHeldForever(ledger);
  const catalog = await loadCatalog(config);
  const decisions = await readDecisions();

  const claims = ledger.entries.filter(e => e.type === 'fee-claim');
  const feesClaimedUsd = claims.reduce((s, e) => s + (e.claimUsd ?? 0), 0);
  const feesClaimedEth = claims.reduce((s, e) => s + (e.claimEth ?? 0), 0);
  const buybacks = claims.slice(-20).reverse().map(e => ({at: e.at, buybackUsd: e.buybackUsd, tradingUsd: e.tradingUsd, txHash: e.txHash}));

  const real = decisions.filter(d => !d.sample);
  const executed = real.filter(d => d.decision === 'PREPARE');

  const site = config.site ?? {};
  const t = config.treasury ?? {};

  return {
    generatedAt: now.toISOString(),
    agent: {
      name: config.agentName ?? 'ZZY',
      mode: config.mode ?? 'preview',
      live: config.mode === 'live',
      chain: 'Robinhood Chain',
      chainId: config.chain?.id ?? 4663,
      // The operator wallet is deliberately NOT published. It is discoverable
      // on chain by anyone who looks, but putting it on the page invites
      // copy-trading, which is not what this is.
      phase: phaseOf(config, book, real),
    },
    links: {
      twitter: site.twitter ?? null,
      credit: site.credit ?? null,
      creditUrl: site.creditUrl ?? null,
      explorer: 'https://robinhoodchain.blockscout.com',
    },
    universe: {
      tracked: listSymbols(catalog).length,
      usable: catalogProblems(catalog, config, now).length === 0,
      updatedAt: catalog?.fetchedAt ?? null,
      symbols: listSymbols(catalog),
    },
    treasury: {
      zzyTokenAddress: t.zzyTokenAddress ?? null,
      launched: Boolean(t.zzyTokenAddress),
      buybackShareBps: t.buybackShareBps ?? 5000,
      tradingShareBps: t.tradingShareBps ?? 5000,
      claimThresholdEth: config.pons?.claimThresholdEth ?? 0.42,
      feesClaimedUsd: Number(feesClaimedUsd.toFixed(2)),
      feesClaimedEth: Number(feesClaimedEth.toFixed(6)),
      zzyBoughtUsd: zzy.totalBoughtUsd,
      zzyEverSold: zzy.everSold,
      zzySellPossible: zzy.sellPossible,
      claimCount: claims.length,
      buybacks,
    },
    portfolio: {
      // principal is the money the agent was given to trade with; book value
      // is what that has become. Keeping them separate is the whole point.
      principalUsd: book.principalUsd,
      bookValueUsd: book.bookValueUsd,
      // bookValueUsd is settled cash only. markToMarketUsd adds what the open
      // positions are worth right now, which is the number that moves between
      // trades. openPnlUsd is unrealised and can go negative.
      markToMarketUsd: round2(book.bookValueUsd - held.totalCostUsd + held.totalUsd),
      openPnlUsd: round2(held.totalUsd - held.pricedCostUsd),
      openPositionsUsd: round2(held.totalUsd),
      unpricedPositions: held.unpricedCount,
      realizedPnlUsd: book.realisedPnlUsd,
      lifetimeProfitUsd: book.lifetimeProfitUsd,
      totalPnlUsd: round2(book.lifetimeProfitUsd + (held.totalUsd - held.pricedCostUsd)),
      sweptToBuybackUsd: book.sweptToBuybackUsd,
      deployableUsd: book.deployableUsd,
      exposureCapUsd: book.exposureCapUsd,
      maxOrderUsd: config.policy?.maxOrderUsd ?? null,
      maxPositionPercent: config.policy?.sizing?.maxPositionPercent ?? 60,
      cappedByPolicy: book.cappedByPolicy,
      profitMode: book.mode,
      compoundTargetUsd: book.targetUsd,
      progressPercent: book.progressPercent,
      positions: held.rows.map(r => ({
        symbol: r.symbol, openedAt: r.openedAt,
        valueUsd: r.valueUsd == null ? null : round2(r.valueUsd),
        unrealizedUsd: r.unrealizedUsd == null ? null : round2(r.unrealizedUsd),
        unrealizedPercent: r.unrealizedPercent == null ? null : round2(r.unrealizedPercent),
      })),
    },
    activity: {
      decisionsLogged: real.length,
      ordersExecuted: executed.length,
      recent: real.slice(0, 14),
    },
    site: {pollSeconds: site.pollSeconds ?? 15},
  };
}

let lastArchiveWrite = 0;
export async function writeSiteData(config, {outFile = 'site/data.json', wallet = null, now = new Date()} = {}) {
  const data = await buildSiteData(config, {wallet, now});
  // The PnL series: one point per export, the recent hour riding inside
  // data.json so the chart moves with every push, the long archive in its
  // own file once a minute.
  try {
    const p = data.portfolio;
    const store = addPoint(await loadHistory(config), {t: now.getTime(), book: p.markToMarketUsd, pnl: p.totalPnlUsd, open: p.openPnlUsd}, {...config.history});
    await saveHistory(store, config);
    data.history = {live: store.live, archiveUrl: './history.json'};
    if (now.getTime() - lastArchiveWrite > 60_000) {
      await writeJsonAtomic(outFile.replace(/data\.json$/, 'history.json'), {generatedAt: now.toISOString(), points: store.archive}, {pretty: false});
      lastArchiveWrite = now.getTime();
    }
  } catch (e) { data.history = {live: [], archiveUrl: null, error: e.message}; }
  // Atomic, so the page's poll (and the SSE watcher) never reads a half-written file.
  await writeJsonAtomic(outFile, data);
  return {file: outFile, data};
}
