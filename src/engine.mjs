import {parseEther, formatEther, parseUnits, formatUnits} from 'viem';
import {ADDRESSES, ERC20_ABI} from './chain.mjs';
import {evaluateSnapshot} from './policy.mjs';
import {resolveToken} from './catalog.mjs';
import {fetchQuote} from './adapters/robinhood-rhj.mjs';
import {loadPrices, savePrices, recordPrice, moveOverPercent, moveDetail, volatilityScore, series, poolPremiumPercent} from './prices.mjs';
import {eventsBySymbol, headlinesFor, interestScore} from './intel.mjs';
import {exitGuards, gainPercent, DEFAULT_EXIT} from './exit.mjs';
import {allocate} from './allocator.mjs';
import {recordReview} from './decisions.mjs';
import {marketContext} from './market.mjs';
import {loadEarnings, earningsFor, inBlackout} from './earnings.mjs';
import {reviewFingerprint, shouldReview, intervalFor} from './review-gate.mjs';
import {loadNotebook, saveNotebook, liveEntries, applyNotes, notesFromReview} from './notebook.mjs';
import {loadPositions, savePositions, listPositions, recordBuy, recordSell, markReviewed, valuePositions} from './positions.mjs';
import {readLedger, recordRealizedPnl} from './treasury.mjs';
import {CASH, cashDecimals, cashBalance, toCash, fromCash} from './cash.mjs';
import {deployable} from './profit.mjs';
import {bestQuote, buildApproveTx, buildSwapTx, applySlippage} from './adapters/uniswap.mjs';
import {bestV4Quote, buildV4SwapTx, permit2Route} from './adapters/uniswap-v4.mjs';

// Both venues are asked and the better quote wins. v3 for the few names
// whose depth is there; v4 for the rest. A venue with no pool is simply not
// in the running; with neither, there is no trade.
export async function bestVenueQuote(client, {tokenIn, tokenOut, amountIn, allowedHooks = []}, log = () => {}) {
  const [v3, v4] = await Promise.all([
    bestQuote(client, {tokenIn, tokenOut, amountIn}).then(q => ({...q, venue: 'v3'})).catch(() => null),
    bestV4Quote(client, {tokenIn, tokenOut, amountIn, allowedHooks, log}).catch(() => null),
  ]);
  if (!v3 && !v4) throw new Error(`no Uniswap pool (v3 or v4) quotes ${tokenIn} -> ${tokenOut}`);
  const best = !v4 ? v3 : !v3 ? v4 : (v4.amountOut > v3.amountOut ? v4 : v3);
  if (v3 && v4) log(`venues: v3 ${v3.amountOut} vs v4 ${v4.amountOut}, taking ${best.venue}`);
  return best;
}

// Executes a quoted swap on its venue, approvals included. Returns the swap hash.
export async function executeSwap({client, signer, config, quote, tokenIn, tokenOut, amountIn, amountOutMinimum, label}) {
  if (quote.venue === 'v4') {
    for (const tx of await permit2Route(client, {owner: signer.address, token: tokenIn, amount: amountIn})) {
      await settled(client, await signer.send({to: tx.to, data: tx.data, value: tx.value}), `${label} ${tx.label}`);
    }
    const tx = buildV4SwapTx({key: quote.key, zeroForOne: quote.zeroForOne, tokenIn, tokenOut, amountIn, amountOutMinimum});
    const hash = await signer.send({to: tx.to, data: tx.data, value: tx.value});
    const receipt = await settled(client, hash, `${label} (v4)`);
    return {hash, receipt};
  }
  await settled(client, await signer.send(buildApproveTx(tokenIn, amountIn)), `${label} approve`);
  const hash = await signer.send(buildSwapTx({
    tokenIn, tokenOut, fee: quote.fee, amountIn, amountOutMinimum,
    recipient: signer.address, routerVariant: config.uniswap?.routerVariant,
  }));
  const receipt = await settled(client, hash, `${label} (v3)`);
  return {hash, receipt};
}
import {sessionAt} from './session.mjs';
import {sizeBuy, portfolioView, sizingConfig} from './sizing.mjs';

// One cycle of the trading leg.
//
//   1. Quote the ENTIRE catalog. Free. Every tick. Builds price history.
//   2. Manage what is held: re-examine each position on its own schedule and
//      execute any exit the agent decides on.
//   3. Gate every quoted name through the deterministic policy. Free.
//   4. Pull the SEC 8-K firehose once and join it to the catalog. Free.
//   5. Score every gated name for interest. Free. Take the top N.
//   6. Fetch headlines for those N. Free.
//   7. Send those N, with their headlines attached, to Claude. This is the
//      only step that costs anything, and N bounds it.
//   8. Size, cap, execute, record.
//
// The old design sent nothing to Claude unless a hand-written scoring formula
// crossed a bar it could never reach. That formula is gone. The policy layer
// says yes or no; the agent decides among the yeses.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- 1. quotes --------------------------------------------------------------

export async function quoteUniverse({catalog, config, priceStore, now, log}) {
  const symbols = (catalog?.symbols ?? []).map(e => e.symbol);
  const concurrency = config.execution?.quoteConcurrency ?? 8;
  const failed = [];
  const quotes = {};
  await mapLimit(symbols, concurrency, async (symbol) => {
    try {
      const q = await fetchQuote(symbol);
      quotes[symbol] = q;
      recordPrice(priceStore, symbol, q.mid, new Date(q.generatedAt || now));
    } catch (err) { failed.push(symbol); }
  });
  if (failed.length) log(`quotes failed for ${failed.length} of ${symbols.length}: ${failed.slice(0, 6).join(', ')}${failed.length > 6 ? '...' : ''}`);
  return {quotes, failed, total: symbols.length};
}

function snapshotFor(symbol, q, token, priceStore, account, now) {
  const d = moveDetail(priceStore, symbol, 300, now);
  return {
    source: 'https://api.robinhood.com/rhj/prices', sample: false, observedAt: q.generatedAt,
    asset: {symbol, name: token.name, assetClass: 'tokenized-stock', underlying: symbol, address: token.address},
    market: {
      priceUsd: q.mid, pricePreviewUsd: q.ask,
      priceMove5mPercent: d ? d.percent : null, priceMove1hPercent: moveOverPercent(priceStore, symbol, 3600, now),
      priceMove24hPercent: moveOverPercent(priceStore, symbol, 86400, now),
      spreadPercent: q.spreadPercent, volume24hUsd: q.dailyTradingVolume * q.mid, volatilityScore: volatilityScore(priceStore, symbol),
    },
    priceHistory: series(priceStore, symbol),
    account,
    riskFlags: [...(q.isTradingHalt ? ['trading-halt'] : []), ...(q.spreadPercent > 1 ? ['wide-spread'] : []), ...(d ? [] : ['no-price-history'])],
    _warming: d && !d.full ? d.windowSeconds : null,
  };
}

// ---- 2. positions -------------------------------------------------------------

async function tokenBalance(client, address, owner) {
  return client.readContract({address, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner]});
}

// Token decimals, read once per address and cached for the life of the
// process. The code used to hard-wire 1e18 for every stock token, which is
// correct for the ones checked so far and wrong the first time it isn't.
// An implausible answer (a mock, a proxy that reverts) falls back to 18 and
// says so once, rather than sizing a trade off garbage.
const decimalsCache = new Map();
let warnedDecimals = false;
export async function tokenDecimals(client, address, log = () => {}) {
  const key = address.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  let d = 18;
  try {
    const raw = await client.readContract({address, abi: ERC20_ABI, functionName: 'decimals'});
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 0 && n <= 36) d = n;
    else if (!warnedDecimals) { warnedDecimals = true; log(`decimals() on ${address} returned ${String(raw)}, assuming 18`); }
  } catch (e) { if (!warnedDecimals) { warnedDecimals = true; log(`could not read decimals() on ${address}, assuming 18`); } }
  decimalsCache.set(key, d);
  return d;
}

// Waits for a receipt and refuses to treat a reverted transaction as a fill.
// Every recording function downstream assumes the hash it is handed settled
// successfully; this is where that assumption is made true.
async function settled(client, hash, what) {
  const receipt = await client.waitForTransactionReceipt({hash});
  if (receipt?.status && receipt.status !== 'success') {
    throw new Error(`${what} reverted on-chain (${hash}); nothing recorded`);
  }
  return receipt;
}

// Executes one exit plan through the real sale path. Returns the recorded
// result, or throws; the caller decides what a failure means.
async function executeExit({client, signer, config, p, q, plan, positions, ethUsd, now, log}) {
  const decimals = await tokenDecimals(client, p.address, log);
  const heldOnChain = await tokenBalance(client, p.address, signer.address);
  // A full close sells the actual on-chain balance, not a float that was
  // multiplied by 1e18 and floored: that used to leave dust behind, or
  // overshoot the balance by a few wei and revert.
  let amountIn = plan.sellFraction >= 1 ? heldOnChain : parseUnits((p.qty * plan.sellFraction).toFixed(decimals), decimals);
  if (amountIn > heldOnChain) amountIn = heldOnChain;
  if (amountIn <= 0n) throw new Error('nothing on-chain to sell, position record is stale');
  const sellQty = Number(formatUnits(amountIn, decimals));
  const quote = await bestVenueQuote(client, {tokenIn: p.address, tokenOut: CASH, amountIn, allowedHooks: config.uniswap?.v4?.allowedHooks ?? []}, log);
  const cashBefore = await cashBalance(client, signer.address);
  const {hash} = await executeSwap({client, signer, config, quote, tokenIn: p.address, tokenOut: CASH, amountIn,
    amountOutMinimum: applySlippage(quote.amountOut, config.execution?.stockSlippageBps ?? 100), label: `${p.symbol} sell`});
  const cashAfter = await cashBalance(client, signer.address);
  const proceedsUsd = fromCash(cashAfter.raw - cashBefore.raw, cashAfter.decimals);
  // A successful swap with no cash arriving means the receipt lied or the
  // balance read raced. Either way, recording it would post a total loss
  // for tokens that are still in the wallet.
  if (!(proceedsUsd > 0)) throw new Error(`sell ${hash} settled but no USDG arrived; not recording`);
  const {realizedUsd} = recordSell(positions, {symbol: p.symbol, qty: Math.min(sellQty, p.qty), proceedsUsd, priceUsd: q.mid, txHash: hash, at: now});
  await savePositions(positions, config);
  await recordRealizedPnl({amountUsd: realizedUsd, note: `${p.symbol} ${plan.action.toLowerCase()}: ${plan.reason}`, at: now.toISOString()}, config);
  log(`${p.symbol}: ${plan.action.toLowerCase()} ${sellQty.toFixed(6)} for $${proceedsUsd.toFixed(2)}, realised ${realizedUsd >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)}${plan.replacedBy ? `, capital to ${plan.replacedBy}` : ''} (${hash})`);
  return {symbol: p.symbol, action: plan.action, reason: plan.reason, replacedBy: plan.replacedBy ?? null, sellQty, proceedsUsd, realizedUsd, hash};
}

async function runExit({client, signer, config, p, q, plan, positions, ethUsd, now, log, results}) {
  markReviewed(positions, p.symbol, now);
  if (plan.action === 'HOLD') { results.push({symbol: p.symbol, action: 'HOLD', reason: plan.reason, source: plan.source}); log(`${p.symbol}: hold (${plan.reason})`); return; }
  if (!signer.live) {
    log(`[preview] ${p.symbol}: would ${plan.action.toLowerCase()} ${(plan.sellFraction * 100).toFixed(0)}% (${plan.reason})${plan.replacedBy ? `, capital to ${plan.replacedBy}` : ''}`);
    results.push({symbol: p.symbol, action: plan.action, reason: plan.reason, replacedBy: plan.replacedBy ?? null, source: plan.source, preview: true});
    return;
  }
  try { results.push({...await executeExit({client, signer, config, p, q, plan, positions, ethUsd, now, log}), source: plan.source}); }
  catch (e) { log(`${p.symbol}: exit failed, position unchanged: ${e.message.split('\n')[0]}`); results.push({symbol: p.symbol, action: 'ERROR', reason: e.message.split('\n')[0]}); }
}

// Mark-to-market value of the whole book: free cash inside the cap plus
// every position at its latest quote. Share-of-book is measured against
// this, not against settled cash, which put a fully invested book "over
// 100%" in one name and asked the model to trim a position that was exactly
// the size it had chosen.
function bookAtMarket({positions, quotes, ledger, config}) {
  const invested = listPositions(positions).reduce((sum, x) => sum + (quotes[x.symbol] ? x.qty * quotes[x.symbol].mid : x.costBasisUsd), 0);
  const cash = Math.max(0, deployable(ledger, config).deployableUsd - invested);
  return {invested, cash, total: cash + invested};
}

// Turns an allocator holding decision into a sell plan. A TRIM aims at the
// allocator's new target weight; the tranche is clamped into the operator's
// band so a model cannot dribble out 2% or dump 95% in one go.
function planFromAllocation(h, p, q, book, config) {
  const ep = {...DEFAULT_EXIT, ...(config.exitPolicy ?? {})};
  const gain = gainPercent(p, q.mid);
  if (h.action === 'CLOSE') return {action: 'CLOSE', sellFraction: 1, sellQty: p.qty, gainPercent: gain, reason: h.reason, replacedBy: h.replacedBy, source: 'allocator'};
  if (h.action === 'TRIM') {
    const currentWeight = book.total > 0 ? (p.qty * q.mid / book.total) * 100 : 0;
    let pctOut = h.targetWeightPercent != null && currentWeight > 0 ? (1 - h.targetWeightPercent / currentWeight) * 100 : ep.minTranchePercent;
    pctOut = Math.min(ep.maxTranchePercent, Math.max(ep.minTranchePercent, pctOut));
    return {action: 'TRIM', sellFraction: pctOut / 100, sellQty: p.qty * pctOut / 100, gainPercent: gain, reason: h.reason, replacedBy: h.replacedBy, source: 'allocator'};
  }
  return {action: 'HOLD', gainPercent: gain, reason: h.reason, source: 'allocator'};
}

// ---- the cycle ----------------------------------------------------------------

export async function tradingCycle({client, signer, config, catalog, ethUsd, now = new Date(), log = () => {}, state = {}}) {
  const ua = config.news?.edgarUserAgent || 'zzy-agent (no contact set; set news.edgarUserAgent)';
  const priceStore = await loadPrices(config);
  const positions = await loadPositions(config);
  let ledger = await readLedger(config);
  const exits = [];

  // 1
  const {quotes, failed, total} = await quoteUniverse({catalog, config, priceStore, now, log});
  await savePrices(priceStore, config);
  const priced = Object.keys(quotes).length;
  if (!priced) return {acted: false, reason: 'no quotes succeeded', failed};

  // 2. Deterministic guards on every position, before any model is asked.
  //    The stop loss executes here. Cooldown and fee-viability produce a HOLD
  //    that the allocator cannot override. Everything else is reviewed
  //    against the opportunity set below, as a portfolio.
  const guarded = new Set();
  for (const p of listPositions(positions)) {
    const q = quotes[p.symbol]; if (!q) { guarded.add(p.symbol); continue; }
    const forced = exitGuards(p, q.mid, config, {now});
    if (!forced) continue;
    guarded.add(p.symbol);
    if (forced.action === 'CLOSE') await runExit({client, signer, config, p, q, plan: forced, positions, ethUsd, now, log, results: exits});
    else log(`${p.symbol}: ${forced.reason}`);
  }
  await savePositions(positions, config);
  ledger = await readLedger(config);

  // capital, after any guard exits posted P&L
  let book = deployable(ledger, config);
  const priceBySymbol = Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, q.mid]));
  let held = valuePositions(positions, priceBySymbol);
  let room = Math.max(0, book.deployableUsd - held.totalUsd);
  // The ledger says how much the book may deploy; the wallet says how much
  // USDG is actually there. Room is the smaller. If they disagree, say so:
  // a ledger ahead of the wallet means something was recorded that did not
  // settle, or cash left the wallet by another route.
  let walletCashUsd = null;
  if (signer.live) {
    try {
      walletCashUsd = (await cashBalance(client, signer.address)).usd;
      if (room > walletCashUsd + 1) log(`ledger room $${room.toFixed(2)} but wallet holds $${walletCashUsd.toFixed(2)} USDG; trading with the wallet figure`);
      room = Math.min(room, walletCashUsd);
    } catch (e) { log(`could not read USDG balance: ${e.message.split('\n')[0]}`); }
  }
  const account = {buyingPowerUsd: room, currentExposureUsd: held.totalUsd, openOrders: 0};

  // 3
  const gated = [];
  let rejected = 0, warming = 0;
  for (const [symbol, q] of Object.entries(quotes)) {
    let token; try { token = resolveToken(catalog, symbol); } catch { continue; }
    const snap = snapshotFor(symbol, q, token, priceStore, account, now);
    if (snap._warming) warming++;
    const policy = evaluateSnapshot(snap, config, now, catalog);
    if (!policy.accepted) { rejected++; continue; }
    gated.push(snap);
  }
  log(`quoted ${priced}/${total}, ${gated.length} pass policy, ${rejected} rejected${warming ? `, ${warming} still on a short price window` : ''}`);

  // Gate 1: cadence by session. Cheap, and it runs before any network fetch
  // beyond the quotes, so an off-hours tick that is not due costs nothing.
  const session = sessionAt(now);
  const overridesPending = Boolean(config._fork && (Object.keys(state.verdictOverrides ?? {}).length || Object.keys(state.exitOverrides ?? {}).length));
  const lastCheck = state.lastCheckAt ?? state.lastReviewAt;
  const interval = intervalFor(session, config);
  if (!overridesPending && lastCheck && (now - new Date(lastCheck)) / 1000 < interval) {
    return {acted: exits.some(e => e.hash), reason: `review not due for ${Math.ceil(interval - (now - new Date(lastCheck)) / 1000)}s (${session.phase} cadence ${interval}s)`, gated: gated.length, exits, book: book.deployableUsd, exposureUsd: held.totalUsd};
  }
  state.lastCheckAt = now.toISOString();
  const reviewable = listPositions(positions).filter(p => !guarded.has(p.symbol));
  if (!gated.length && !reviewable.length) return {acted: false, reason: 'nothing passed policy and nothing to review', exits};

  // 4 + 5
  let events = {};
  try { events = await eventsBySymbol(gated.map(s => s.asset.symbol), {userAgent: ua}); }
  catch (e) { log(`SEC feed unavailable this cycle: ${e.message}`); }
  const heldSet = new Set(listPositions(positions).map(p => p.symbol));
  const notebook = await loadNotebook(config);
  const notes = liveEntries(notebook, now);
  const noted = new Set(notes.map(n => n.symbol));
  const earnings = await loadEarnings(config, {now, log});
  const scored = gated.map(s => ({snapshot: s, ...interestScore(s, {events: events[s.asset.symbol] ?? [], held: heldSet.has(s.asset.symbol), session, noted: noted.has(s.asset.symbol)})}))
    .sort((a, b) => b.score - a.score);
  const maxN = config.research?.maxCandidatesPerCycle ?? 6;
  const minScore = config.research?.minInterestScore ?? 5;
  // Earnings blackout: a name reporting inside the window is dropped before
  // it can cost a headline fetch or a slot in the review. Held names are
  // never dropped here; the review sees the date and decides.
  const blacked = [];
  let shortlist = scored.filter(c => {
    if (c.score < minScore) return false;
    if (heldSet.has(c.snapshot.asset.symbol)) return true;
    const why = inBlackout(c.snapshot.asset.symbol, earnings, config, now);
    if (why) { blacked.push(`${c.snapshot.asset.symbol} (${why})`); return false; }
    return true;
  }).slice(0, maxN);
  if (blacked.length) log(`earnings blackout: ${blacked.join('; ')}`);
  // Fork-only: a verdict override forces its symbol onto the shortlist so the
  // downstream path (headlines, sizing, premium check, swap, record) runs for
  // real with only the model's answer substituted. Consumed once.
  const overrides = config._fork ? (state.verdictOverrides ?? {}) : {};
  for (const sym of Object.keys(overrides)) {
    if (!shortlist.some(c => c.snapshot.asset.symbol === sym)) {
      const c = scored.find(c => c.snapshot.asset.symbol === sym);
      if (c) { shortlist = [c, ...shortlist].slice(0, Math.max(maxN, shortlist.length + 1)); log(`[fork] ${sym} forced onto the shortlist by a verdict override`); }
      else log(`[fork] cannot override ${sym}: it did not pass policy this cycle`);
    }
  }
  if (shortlist.length) log(`shortlist: ${shortlist.map(c => `${c.snapshot.asset.symbol} (${c.score}: ${c.reasons.join(', ')})`).join('; ')}`);
  else log(`no candidate cleared the interest threshold (top score ${scored[0]?.score ?? 0}, threshold ${minScore}); reviewing holdings against cash`);

  // 6. Headlines for the shortlist and for what is held. Cached ten minutes
  //    upstream, so repeated checks between reviews are free.
  for (const c of shortlist) {
    try { c.headlines = await headlinesFor(c.snapshot.asset.symbol, c.snapshot.asset.name, {userAgent: ua}); }
    catch { c.headlines = []; }
    c.events = events[c.snapshot.asset.symbol] ?? [];
    c.earnings = earningsFor(c.snapshot.asset.symbol, earnings, now);
    await sleep(150);
  }
  let heldEvents = {};
  try { heldEvents = reviewable.length ? await eventsBySymbol(reviewable.map(p => p.symbol), {userAgent: ua}) : {}; } catch {}
  const heldNews = {};
  for (const p of reviewable) {
    try { heldNews[p.symbol] = await headlinesFor(p.symbol, resolveToken(catalog, p.symbol).name, {userAgent: ua}); } catch { heldNews[p.symbol] = []; }
    await sleep(150);
  }

  // Gate 2: nothing new. The model cannot form a different view of the
  // inputs it already saw, so it is not asked to.
  const holdingPrices = Object.fromEntries(reviewable.map(p => [p.symbol, quotes[p.symbol]?.mid]).filter(([, v]) => v > 0));
  const fingerprint = reviewFingerprint({shortlist, notebook: notes, portfolioCashUsd: room,
    holdings: reviewable.map(p => ({symbol: p.symbol, headlines: heldNews[p.symbol], events: heldEvents[p.symbol]}))});
  const gate = shouldReview({state, fingerprint, holdingPrices, overridesPending}, config);
  if (!gate.review) {
    log(gate.reason);
    return {acted: exits.some(e => e.hash), reason: gate.reason, gated: gated.length, exits, book: book.deployableUsd, exposureUsd: held.totalUsd};
  }
  log(`reviewing: ${gate.reason}`);
  state.lastFingerprint = fingerprint;
  state.lastPrices = holdingPrices;

  // 7. One review of the whole book against the whole opportunity set.
  state.lastReviewAt = now.toISOString();
  log(`session: ${session.description}${session.phase !== 'regular' ? `, underlying opens in ${session.hoursToOpen}h` : ''}`);
  const sizing = sizingConfig(config);
  const bookMtm = bookAtMarket({positions, quotes, ledger, config});
  const portfolio = portfolioView({room, held, sizing});
  const holdingsIn = reviewable.map(p => {
    const row = held.rows.find(r => r.symbol === p.symbol) ?? {};
    return {symbol: p.symbol, weightPercent: bookMtm.total > 0 && row.valueUsd != null ? Number((row.valueUsd / bookMtm.total * 100).toFixed(2)) : null,
      valueUsd: row.valueUsd ?? null, unrealizedPercent: row.unrealizedPercent ?? null, costBasisUsd: p.costBasisUsd,
      thesis: p.thesis, falsifier: p.falsifier, targetWeightPercent: p.targetWeightPercent ?? null, openedAt: p.openedAt,
      headlines: heldNews[p.symbol] ?? [], events: heldEvents[p.symbol] ?? [], earnings: earningsFor(p.symbol, earnings, now)};
  });
  const market = marketContext(quotes, priceStore, now, {catalog});
  state.lastMarket = market; state.lastSession = session;
  const review = await allocate({portfolio, holdings: holdingsIn, session, market, notebook: notes,
    candidates: shortlist.map(c => ({snapshot: c.snapshot, decision: {confidence: c.score, decision: 'CANDIDATE'}, headlines: c.headlines, events: c.events}))}, config);
  if (review.summary) log(`review: ${review.summary}`);
  else if (review.reason) log(`review: ${review.reason}`);
  // A review that never happened (network, timeout) does not count as one:
  // the gate is reset so the next tick tries again instead of waiting a
  // full interval, and the fingerprint is cleared so "nothing changed"
  // cannot skip it.
  if (review.failed) { state.lastReviewAt = null; state.lastFingerprint = null; log('review did not complete; will retry on the next tick'); }
  // What it wants to remember for next time.
  try { await saveNotebook(applyNotes(notebook, notesFromReview(review), config, now), config); }
  catch (e) { log(`could not save notebook: ${e.message}`); }
  // The public log gets every call, not just the ones that become trades.
  // Paper and fork reviews are flagged so the site exporter can drop them.
  try { await recordReview(review, {now, dir: config.decisions?.path ?? 'decisions', mode: config.mode ?? 'preview', sample: Boolean(config._fork || config._paper)}); }
  catch (e) { log(`could not write decision log: ${e.message}`); }

  // Fork-only overrides replace only the model's answers.
  const byHold = new Map(review.holdings.map(h => [h.symbol, h]));
  for (const [sym, ex] of Object.entries(config._fork ? (state.exitOverrides ?? {}) : {})) {
    if (!byHold.has(sym)) continue;
    byHold.set(sym, {symbol: sym, action: ex.action, targetWeightPercent: ex.action === 'TRIM' ? null : undefined, reason: `[fork override] ${ex.reason ?? 'forced'}`, replacedBy: null, source: 'fork-override'});
    delete state.exitOverrides[sym];
    log(`[fork] exit verdict on ${sym} replaced with ${ex.action}`);
  }
  const byFn = new Map(review.candidates.map(v => [v.symbol, v]));
  for (const [sym, o] of Object.entries(overrides)) {
    if (!shortlist.some(c => c.snapshot.asset.symbol === sym)) continue;
    byFn.set(sym, {symbol: sym, verdict: o.verdict, confidence: o.confidence ?? 80, targetWeightPercent: o.targetWeightPercent ?? null, rationale: `[fork override] ${o.reason ?? 'forced verdict'}`, downsideCase: 'override', falsifier: 'override', sources: []});
    delete state.verdictOverrides[sym];
    log(`[fork] Claude's verdict on ${sym} replaced with ${o.verdict}`);
  }

  // 8a. Exits first, so freed capital is available to what replaces it.
  for (const p of reviewable) {
    const q = quotes[p.symbol]; const h = byHold.get(p.symbol); if (!q || !h) continue;
    const plan = planFromAllocation(h, p, q, bookMtm, config);
    await runExit({client, signer, config, p, q, plan, positions, ethUsd, now, log, results: exits});
  }
  await savePositions(positions, config);
  ledger = await readLedger(config);
  book = deployable(ledger, config);
  held = valuePositions(positions, priceBySymbol);
  room = Math.max(0, book.deployableUsd - held.totalUsd);
  if (walletCashUsd != null) { try { room = Math.min(room, (await cashBalance(client, signer.address)).usd); } catch {} }
  const portfolioAfter = portfolioView({room, held, sizing});
  if (room <= 0 && !shortlist.length) return {acted: exits.some(e => e.hash), reason: `no room: book $${book.deployableUsd.toFixed(2)}, exposure $${held.totalUsd.toFixed(2)}`, gated: gated.length, exits, review: review.summary};

  // 8b. Buys, sized as a share of the book toward the allocator's targets.
  const buys = [];
  let remaining = room;
  const maxOrder = config.policy?.maxOrderUsd ?? null;   // optional hard dollar cap; percent limits do the real work
  const decided = shortlist.map(c => ({c, v: byFn.get(c.snapshot.asset.symbol)})).filter(x => x.v);
  const heldUsdBy = Object.fromEntries(held.rows.map(r => [r.symbol, r.valueUsd ?? r.costBasisUsd ?? 0]));
  for (const {c, v} of decided) {
    const sym = c.snapshot.asset.symbol;
    if (v.verdict !== 'PREPARE') { log(`${sym}: ${v.verdict.toLowerCase()} (${v.reason || v.rationale || ''})`); continue; }
    if (room <= 0) { log(`${sym}: agent said buy but the book is fully deployed`); continue; }
    const size = sizeBuy({portfolioUsd: portfolioAfter.portfolioUsd, currentUsd: heldUsdBy[sym] ?? 0, remainingUsd: remaining,
      targetWeightPercent: v.targetWeightPercent, conviction: v.confidence, maxOrderUsd: maxOrder, sizing});
    if (!(size.usd > 0)) { log(`${sym}: agent said buy, not sizing in: ${size.reason}`); continue; }
    const usd = size.usd;
    log(`${sym}: sizing $${usd.toFixed(2)} (${size.reason})`);
    const token = resolveToken(catalog, sym);
    const cashDec = await cashDecimals(client);
    const amountIn = toCash(usd, cashDec);

    let quote = null, premium = null;
    try {
      quote = await bestVenueQuote(client, {tokenIn: CASH, tokenOut: token.address, amountIn, allowedHooks: config.uniswap?.v4?.allowedHooks ?? []}, log);
      const outDec = await tokenDecimals(client, token.address, log);
      premium = poolPremiumPercent(usd / Number(formatUnits(quote.amountOut, outDec)), c.snapshot.market.priceUsd);
    } catch (err) {
      if (signer.live) { log(`${sym}: no pool quote, skipping (${err.message.split('\n')[0]})`); continue; }
    }
    const maxPremium = config.execution?.maxPoolPremiumPercent ?? 2;
    if (premium !== null && premium > maxPremium) { log(`${sym}: pool ${premium.toFixed(2)}% over reference, skipping`); continue; }

    if (!signer.live) {
      log(`[preview] would buy ${sym} for $${usd.toFixed(2)} (target ${size.targetPercent.toFixed(0)}%, conviction ${v.confidence}): ${v.rationale}`);
      buys.push({symbol: sym, usd, preview: true});
      remaining -= usd;
      continue;
    }
    try {
      const decimals = await tokenDecimals(client, token.address, log);
      const before = await tokenBalance(client, token.address, signer.address);
      const {hash} = await executeSwap({client, signer, config, quote, tokenIn: CASH, tokenOut: token.address, amountIn,
        amountOutMinimum: applySlippage(quote.amountOut, config.execution?.stockSlippageBps ?? 100), label: `${sym} buy`});
      const after = await tokenBalance(client, token.address, signer.address);
      const qty = Number(formatUnits(after - before, decimals));
      if (!(qty > 0)) throw new Error(`${sym} buy ${hash} settled but no tokens arrived; not recording`);
      recordBuy(positions, {symbol: sym, address: token.address, qty, costUsd: usd, priceUsd: c.snapshot.market.priceUsd, txHash: hash,
        thesis: v.rationale, falsifier: v.falsifier, target: v.target, targetWeightPercent: size.targetPercent, at: now});
      await savePositions(positions, config);
      heldUsdBy[sym] = (heldUsdBy[sym] ?? 0) + usd;
      remaining -= usd;
      buys.push({symbol: sym, usd, qty, hash});
      log(`${sym}: bought ${qty.toFixed(6)} for $${usd.toFixed(2)} (${hash}) :: ${v.rationale}`);
    } catch (e) {
      log(`${sym}: buy failed, nothing recorded: ${e.message.split('\n')[0]}`);
      buys.push({symbol: sym, usd, error: e.message.split('\n')[0]});
    }
  }

  return {acted: buys.some(b => !b.preview) || exits.some(e => e.hash), buys, exits, researched: shortlist.map(c => c.snapshot.asset.symbol), reviewed: reviewable.map(p => p.symbol), review: review.summary, gated: gated.length, book: book.deployableUsd, exposureUsd: held.totalUsd, failedQuotes: failed.length};
}

// ---- forced trades, fork only ------------------------------------------------
//
// Runs the exact execution path a real decision would take (resolve, quote,
// premium check, approve, swap, balance delta, record) with Claude's verdict
// replaced by your say-so. It exists to prove the plumbing on a fork. It
// refuses anywhere else: config._fork is set only by fork.mjs after it has
// verified the RPC is a local Anvil fork, so this cannot reach real money.

function assertForkOnly(config, what) {
  if (!config._fork) throw new Error(`${what} only runs on a local fork (npm run control:fork). It will not touch a real chain.`);
}

export async function forceBuy({client, signer, config, catalog, symbol, usd, ethUsd, now = new Date(), log = () => {}}) {
  assertForkOnly(config, 'a forced buy');
  if (!signer.live) throw new Error('signer is not live on this fork');
  const token = resolveToken(catalog, symbol);
  const positions = await loadPositions(config);
  const q = await fetchQuote(symbol);
  const cashDec = await cashDecimals(client);
  const amountIn = toCash(usd, cashDec);
  const decimals = await tokenDecimals(client, token.address, log);
  const quote = await bestVenueQuote(client, {tokenIn: CASH, tokenOut: token.address, amountIn, allowedHooks: config.uniswap?.v4?.allowedHooks ?? []}, log);
  const premium = poolPremiumPercent(usd / Number(formatUnits(quote.amountOut, decimals)), q.mid);
  log(`${symbol}: pool ${premium >= 0 ? '+' : ''}${premium.toFixed(2)}% vs reference $${q.mid}, ${quote.venue} fee tier ${quote.fee}`);
  const before = await tokenBalance(client, token.address, signer.address);
  const {hash, receipt} = await executeSwap({client, signer, config, quote, tokenIn: CASH, tokenOut: token.address, amountIn,
    amountOutMinimum: applySlippage(quote.amountOut, config.execution?.stockSlippageBps ?? 100), label: `${symbol} buy`});
  const after = await tokenBalance(client, token.address, signer.address);
  const qty = Number(formatUnits(after - before, decimals));
  if (!(qty > 0)) throw new Error(`swap mined (${hash}) but the token balance did not change; check the receipt`);
  recordBuy(positions, {symbol, address: token.address, qty, costUsd: usd, priceUsd: q.mid, txHash: hash,
    thesis: 'forced test buy on a fork', falsifier: 'none, this is a plumbing test', at: now});
  await savePositions(positions, config);
  log(`${symbol}: bought ${qty.toFixed(6)} for $${usd.toFixed(2)} in block ${receipt.blockNumber}, status ${receipt.status} (${hash})`);
  return {symbol, qty, usd, hash, block: Number(receipt.blockNumber), status: receipt.status, premium};
}

// An operator-directed live buy. Not a bypass: the same quote, venue choice,
// premium guard, sizing floor and signer as the allocator's own buys, and
// the position is recorded like any other, with a thesis that says who
// asked for it. The allocator reviews it next cycle and may close it if it
// does not earn its place. The premium cap can be raised for one order with
// maxPremiumPercent, deliberately and in the log.
export async function operatorBuy({client, signer, config, catalog, symbol, usd, note = 'operator-directed buy', maxPremiumPercent = null, now = new Date(), log = () => {}}) {
  if (config.mode !== 'live' || !signer.live) throw new Error('operator buy needs live mode with a live signer');
  if (config._fork || config._paper) throw new Error('operator buy is for the real chain; use fork:buy on a fork');
  if (!(usd > 0)) throw new Error('usd must be positive');
  const minOrder = config.policy?.sizing?.minOrderUsd ?? 5;
  if (usd < minOrder) throw new Error(`$${usd} is below policy.sizing.minOrderUsd ($${minOrder})`);
  const cap = config.policy?.maxOrderUsd;
  if (cap != null && usd > cap) throw new Error(`$${usd} exceeds policy.maxOrderUsd ($${cap})`);
  const token = resolveToken(catalog, symbol);
  const positions = await loadPositions(config);
  const ledger = await readLedger(config);
  const book = deployable(ledger, config);
  const q = await fetchQuote(symbol);
  const priceBySymbol = {[symbol]: q.mid};
  const held = valuePositions(positions, priceBySymbol);
  let room = Math.max(0, book.deployableUsd - held.totalUsd);
  const wallet = await cashBalance(client, signer.address);
  room = Math.min(room, wallet.usd);
  if (usd > room + 0.01) throw new Error(`$${usd} exceeds what the book may deploy right now ($${room.toFixed(2)}: ledger room vs $${wallet.usd.toFixed(2)} USDG in the wallet)`);
  const cashDec = await cashDecimals(client);
  const amountIn = toCash(usd, cashDec);
  const decimals = await tokenDecimals(client, token.address, log);
  const quote = await bestVenueQuote(client, {tokenIn: CASH, tokenOut: token.address, amountIn, allowedHooks: config.uniswap?.v4?.allowedHooks ?? []}, log);
  const premium = poolPremiumPercent(usd / Number(formatUnits(quote.amountOut, decimals)), q.mid);
  const maxPrem = maxPremiumPercent ?? config.policy?.maxPoolPremiumPercent ?? 2;
  log(`${symbol}: reference $${q.mid}, pool ${premium >= 0 ? '+' : ''}${premium.toFixed(2)}% on ${quote.venue} (fee ${quote.fee}), cap ${maxPrem}%`);
  if (premium > maxPrem) throw new Error(`${symbol} pool is ${premium.toFixed(2)}% over the reference, above the ${maxPrem}% cap; pass --max-premium to raise it for this order, knowingly`);
  const before = await tokenBalance(client, token.address, signer.address);
  const {hash, receipt} = await executeSwap({client, signer, config, quote, tokenIn: CASH, tokenOut: token.address, amountIn,
    amountOutMinimum: applySlippage(quote.amountOut, config.execution?.stockSlippageBps ?? 100), label: `${symbol} buy`});
  const after = await tokenBalance(client, token.address, signer.address);
  const qty = Number(formatUnits(after - before, decimals));
  if (!(qty > 0)) throw new Error(`${symbol} buy ${hash} settled but no tokens arrived; not recording`);
  recordBuy(positions, {symbol, address: token.address, qty, costUsd: usd, priceUsd: q.mid, txHash: hash,
    thesis: note, falsifier: 'the allocator reviews this position on its next cycle like any other', target: null, targetWeightPercent: null, at: now});
  await savePositions(positions, config);
  log(`${symbol}: bought ${qty.toFixed(6)} for $${usd.toFixed(2)} on ${quote.venue}, block ${receipt.blockNumber} (${hash})`);
  return {symbol, qty, usd, hash, venue: quote.venue, premium, block: Number(receipt.blockNumber)};
}

export async function forceSell({client, signer, config, catalog, symbol, fraction = 1, ethUsd, now = new Date(), log = () => {}}) {
  assertForkOnly(config, 'a forced sell');
  if (!signer.live) throw new Error('signer is not live on this fork');
  const positions = await loadPositions(config);
  const p = positions.positions[symbol];
  if (!p) throw new Error(`no open position in ${symbol}`);
  const q = await fetchQuote(symbol);
  const frac = Math.min(1, Math.max(0.01, fraction));
  const decimals = await tokenDecimals(client, p.address, log);
  const heldOnChain = await tokenBalance(client, p.address, signer.address);
  let amountIn = frac >= 1 ? heldOnChain : parseUnits((p.qty * frac).toFixed(decimals), decimals);
  if (amountIn > heldOnChain) amountIn = heldOnChain;
  if (amountIn <= 0n) throw new Error(`nothing on-chain to sell for ${symbol}`);
  const sellQty = Math.min(p.qty, Number(formatUnits(amountIn, decimals)));
  const quote = await bestVenueQuote(client, {tokenIn: p.address, tokenOut: CASH, amountIn, allowedHooks: config.uniswap?.v4?.allowedHooks ?? []}, log);
  const cashBefore = await cashBalance(client, signer.address);
  const {hash, receipt} = await executeSwap({client, signer, config, quote, tokenIn: p.address, tokenOut: CASH, amountIn,
    amountOutMinimum: applySlippage(quote.amountOut, config.execution?.stockSlippageBps ?? 100), label: `${symbol} sell`});
  const cashAfter = await cashBalance(client, signer.address);
  const proceedsUsd = fromCash(cashAfter.raw - cashBefore.raw, cashAfter.decimals);
  if (!(proceedsUsd > 0)) throw new Error(`${symbol} sell ${hash} settled but no USDG arrived; not recording`);
  const {realizedUsd, remainingQty} = recordSell(positions, {symbol, qty: sellQty, proceedsUsd, priceUsd: q.mid, txHash: hash, at: now});
  await savePositions(positions, config);
  await recordRealizedPnl({amountUsd: realizedUsd, note: `${symbol} forced test sell`, at: now.toISOString()}, config);
  log(`${symbol}: sold ${sellQty.toFixed(6)} for $${proceedsUsd.toFixed(2)}, realised ${realizedUsd >= 0 ? '+' : ''}$${realizedUsd.toFixed(2)}, ${remainingQty.toFixed(6)} left (${hash})`);
  return {symbol, sellQty, proceedsUsd, realizedUsd, remainingQty, hash, block: Number(receipt.blockNumber), status: receipt.status};
}
