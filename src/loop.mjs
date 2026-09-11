import {formatEther, parseEther} from 'viem';
import {planFeeClaim, readLedger, recordBuyback, recordRealizedPnl, assertZzyDisposalBlocked} from './treasury.mjs';
import {readClaimableWeth, buildClaimTx, claimThresholdMet, wethBalance} from './adapters/pons.mjs';
import {planBuyZzy, planWethToCash} from './adapters/uniswap.mjs';
import {cashBalance, fromCash} from './cash.mjs';
import {ADDRESSES} from './chain.mjs';
import {writeJsonAtomic} from './storage.mjs';

// One tick of the treasury leg. Pure orchestration; every side effect goes
// through injected adapters so this can be tested with fakes.
//
//   1. If claimable WETH >= threshold (0.42 ETH default) -> claim.
//      If the locker doesn't expose a claimable view, or pons automation
//      already routed fees to the payout wallet, the loop detects WETH in
//      the wallet above the tracked baseline and treats that as proceeds.
//   2. Split proceeds 50/50 (treasury.mjs, rounding favours trading).
//   3. Buy $ZZY with the buyback half. Hold. Never sell (signer enforces).
//   4. Earmark the trading half; record everything to the ledger.
export async function treasuryTick({client, signer, config, ethUsd, now = new Date(), log = () => {}}) {
  assertZzyDisposalBlocked('BUY');
  const zzy = config.treasury?.zzyTokenAddress;
  // Before the token exists there is nothing to claim or buy back. That is an
  // expected state, not a failure, so it does not get logged as an error.
  if (!zzy) return {acted: false, skipped: true, reason: 'no $ZZY token configured yet, nothing to claim'};
  const wallet = signer.address ?? config.runtime?.watchAddress;
  if (!wallet) throw new Error('no wallet address (live signer) or runtime.watchAddress (preview) to observe');

  const ledger = await readLedger(config);
  const baselineEth = ledger.wethBaselineEth ?? 0;

  // --- 1. claim -------------------------------------------------------------
  const claimable = await readClaimableWeth(client, zzy, config); // number | null
  let claimTxHash = null;
  if (claimable !== null && claimThresholdMet(claimable, config)) {
    if (!signer.live) {
      log(`[preview] ${claimable} ETH claimable >= threshold; would claim`);
    } else {
      const tx = buildClaimTx(zzy, config);
      claimTxHash = await signer.send(tx);
      const r = await client.waitForTransactionReceipt({hash: claimTxHash});
      if (r?.status && r.status !== 'success') throw new Error(`claim reverted (${claimTxHash})`);
      log(`claimed: ${claimTxHash}`);
    }
  }

  // --- 2. measure proceeds ---------------------------------------------------
  const {eth: wethNow} = await wethBalance(client, wallet);
  const proceedsEth = Math.max(0, wethNow - baselineEth);
  const minProceeds = config.treasury?.minProceedsEth ?? 0.01;
  if (proceedsEth < minProceeds) {
    return {acted: false, reason: `unallocated WETH ${proceedsEth.toFixed(6)} < min ${minProceeds}`, claimable, claimTxHash};
  }

  const claimUsd = proceedsEth * ethUsd;
  const plan = planFeeClaim(claimUsd, config);
  const buybackEth = proceedsEth * (config.treasury?.buybackShareBps ?? 5000) / 10000;
  const tradingEth = proceedsEth - buybackEth;

  // --- 3. buy $ZZY -----------------------------------------------------------
  const buy = await planBuyZzy(client, {
    zzyToken: zzy, amountEth: buybackEth, recipient: wallet,
    slippageBps: config.execution?.slippageBps ?? 300,
    routerVariant: config.uniswap?.routerVariant,
  });
  let buyTxHash = null;
  if (signer.live) {
    const a = await client.waitForTransactionReceipt({hash: await signer.send(buy.approve)});
    if (a?.status && a.status !== 'success') throw new Error('WETH approve for buyback reverted');
    buyTxHash = await signer.send(buy.swap);
    const r = await client.waitForTransactionReceipt({hash: buyTxHash});
    // A reverted buyback must not be booked as a claim: the ledger would show
    // $ZZY bought that was never bought, and the baseline would move anyway.
    if (r?.status && r.status !== 'success') throw new Error(`buyback swap reverted (${buyTxHash}); nothing recorded`);

    // --- 4. the trading half becomes cash ------------------------------------
    // Stock tokens trade against USDG, so the book's cash is USDG. One swap
    // through the deepest pool on the chain. The ledger records what actually
    // arrived, not an ETH-price estimate.
    const conv = await planWethToCash(client, {amountWei: parseEther(tradingEth.toFixed(18)), recipient: wallet,
      slippageBps: config.execution?.cashSlippageBps ?? 50, routerVariant: config.uniswap?.routerVariant});
    const cashBefore = await cashBalance(client, wallet);
    const ca = await client.waitForTransactionReceipt({hash: await signer.send(conv.approve)});
    if (ca?.status && ca.status !== 'success') throw new Error('WETH approve for cash conversion reverted');
    const convHash = await signer.send(conv.swap);
    const cr = await client.waitForTransactionReceipt({hash: convHash});
    if (cr?.status && cr.status !== 'success') throw new Error(`WETH->USDG conversion reverted (${convHash}); buyback recorded, trading half left as WETH`);
    const cashAfter = await cashBalance(client, wallet);
    const tradingUsd = fromCash(cashAfter.raw - cashBefore.raw, cashAfter.decimals);
    if (!(tradingUsd > 0)) throw new Error(`conversion ${convHash} settled but no USDG arrived`);

    await recordBuyback({claimUsd, claimEth: proceedsEth, buybackUsd: plan.buyback.amountUsd, tradingUsd, txHash: buyTxHash, cashTxHash: convHash, at: now.toISOString()}, config);
    log(`converted ${tradingEth.toFixed(6)} WETH to $${tradingUsd.toFixed(2)} USDG for the book (${convHash})`);
    // New baseline: whatever WETH remains after both swaps. Subsequent ticks
    // only see fresh proceeds.
    const after = await wethBalance(client, wallet);
    await patchLedger(config, {wethBaselineEth: after.eth});
  } else {
    log(`[preview] would buy ~${formatEther(buy.expectedOut)} $ZZY with ${buybackEth.toFixed(6)} WETH and convert ${tradingEth.toFixed(6)} WETH to USDG for the book`);
  }

  return {acted: true, claimable, proceedsEth, buybackEth, tradingEth, claimUsd, buyTxHash, claimTxHash, expectedZzyOut: buy.expectedOut.toString()};
}

async function patchLedger(config, patch) {
  const file = config.treasury?.ledgerPath ?? 'treasury/ledger.json';
  const ledger = await readLedger(config);
  await writeJsonAtomic(file, {...ledger, ...patch}, {backup: true});
}

export {recordRealizedPnl};
