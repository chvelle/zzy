import {parseUnits, formatUnits, toFunctionSelector, encodeFunctionData, parseEther, formatEther, parseAbi, getAddress} from 'viem';
import {ADDRESSES, ERC20_ABI, WETH_ABI, SWAP_ROUTER_ABI, QUOTER_V2_ABI, PONS_POOL_FEE} from './chain.mjs';

// Preflight.
//
// Paper mode proves the agent reasons correctly. It proves nothing about
// whether a transaction will actually go through. Those fail for completely
// different reasons: wrong ABI, wrong selector, missing approval, no gas,
// a pool that does not exist, a contract that is not deployed where you
// think it is.
//
// Everything here runs through eth_call, which executes a transaction against
// current chain state on the node and throws away the result. Same code path
// the miner would run, same reverts, but nothing is broadcast, nothing is
// signed, and nothing costs gas. If a call simulates clean, the real one will
// go through barring a state change between then and now.

export async function checkRpc(client, expectedChainId = 4663) {
  const chainId = await client.getChainId();
  const block = await client.getBlockNumber();
  return {
    ok: chainId === expectedChainId,
    chainId, expectedChainId, blockNumber: Number(block),
    detail: chainId === expectedChainId ? `connected, block ${block}` : `wrong chain: node says ${chainId}, expected ${expectedChainId}`,
  };
}

// A contract that is not deployed returns empty bytecode. Catches a wrong or
// stale address before it wastes a transaction.
export async function checkDeployed(client, label, address) {
  const code = await client.getCode({address}).catch(() => null);
  const ok = Boolean(code && code !== '0x');
  return {ok, label, address, detail: ok ? `deployed, ${(code.length - 2) / 2} bytes` : 'no bytecode at this address'};
}

// Which Uniswap router is deployed, decided by the contract itself rather
// than by reading docs. The two variants have different function selectors
// because SwapRouter's params struct carries a deadline and SwapRouter02's
// does not, so the selector is present in exactly one of them.
export const ROUTER_SELECTORS = {
  SwapRouter: toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))'),
  SwapRouter02: toFunctionSelector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))'),
};

export async function detectRouterVariant(client, router = ADDRESSES.UNISWAP_SWAP_ROUTER) {
  const code = await client.getCode({address: router});
  if (!code || code === '0x') return {ok: false, detail: 'no bytecode at the router address'};
  const found = Object.entries(ROUTER_SELECTORS).filter(([, sel]) => code.includes(sel.slice(2)));
  if (found.length === 1) {
    return {ok: true, variant: found[0][0], detail: `bytecode contains ${found[0][1]}, so this is ${found[0][0]}`};
  }
  if (found.length > 1) {
    return {ok: false, variant: null, detail: `both selectors present (${found.map(f => f[0]).join(', ')}); check the source on Blockscout`};
  }
  return {ok: false, variant: null, detail: 'neither exactInputSingle selector found; this may be a proxy, check the implementation on Blockscout'};
}

// Does a pool exist and can it quote? Uses the quoter, which needs no balance
// and no approval, so this works before the wallet holds anything.
export async function checkPool(client, {tokenIn, tokenOut, amountIn, fees = [500, 3000, 10000]}) {
  const tried = [];
  for (const fee of fees) {
    try {
      const {result} = await client.simulateContract({
        address: ADDRESSES.UNISWAP_QUOTER_V2, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle',
        args: [{tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n}],
      });
      return {ok: true, fee, amountOut: result[0], detail: `pool found at ${fee / 10000}% fee, quotes ${formatEther(result[0])} out`};
    } catch (e) { tried.push(`${fee}: ${short(e)}`); }
  }
  return {ok: false, detail: `no pool on any tier (${tried.join('; ')})`};
}

export async function checkBalances(client, address) {
  const [eth, weth] = await Promise.all([
    client.getBalance({address}),
    client.readContract({address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [address]}).catch(() => 0n),
  ]);
  return {
    ok: eth > 0n,
    ethWei: eth, wethWei: weth,
    detail: `${formatEther(eth)} ETH for gas, ${formatEther(weth)} WETH to trade with`
      + (eth === 0n ? '  <-- no gas, every transaction will fail' : ''),
  };
}

// Simulates a call from `account` without signing it. This is the check that
// actually answers "will the transaction go through".
async function simulate(client, {account, to, data, value = 0n}) {
  try {
    await client.call({account, to, data, value});
    return {ok: true, detail: 'simulated clean'};
  } catch (e) {
    return {ok: false, detail: short(e)};
  }
}

export async function checkApprove(client, account, amountIn, token = ADDRESSES.WETH, label = 'WETH approve -> router') {
  return {
    label,
    ...await simulate(client, {account, to: token,
      data: encodeFunctionData({abi: ERC20_ABI, functionName: 'approve', args: [ADDRESSES.UNISWAP_SWAP_ROUTER, amountIn]})}),
  };
}

export async function checkWrap(client, account, amountIn) {
  return {
    label: 'wrap ETH -> WETH',
    ...await simulate(client, {account, to: ADDRESSES.WETH, value: amountIn,
      data: encodeFunctionData({abi: WETH_ABI, functionName: 'deposit'})}),
  };
}

export async function checkSwap(client, account, {tokenIn = ADDRESSES.WETH, tokenOut, fee, amountIn, variant, label = null}) {
  const abi = SWAP_ROUTER_ABI[variant];
  if (!abi) return {label: 'swap', ok: false, detail: `unknown router variant ${variant}`};
  const base = {tokenIn, tokenOut, fee, recipient: account, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n};
  const params = variant === 'SwapRouter' ? {...base, deadline: BigInt(Math.floor(Date.now() / 1000) + 600)} : base;
  return {
    label: label ?? `swap ${tokenIn.slice(0, 8)}... -> ${tokenOut.slice(0, 8)}...`,
    ...await simulate(client, {account, to: ADDRESSES.UNISWAP_SWAP_ROUTER,
      data: encodeFunctionData({abi, functionName: 'exactInputSingle', args: [params]})}),
  };
}

// Simulates the configured pons claim. This is how you find out the signature
// you copied off Blockscout is the right one, before it matters.
export async function checkClaim(client, account, config) {
  const c = config.pons?.claim;
  if (!c?.abi || !c?.functionName) {
    return {label: 'pons fee claim', ok: false, skipped: true, detail: 'pons.claim not configured yet, see SETUP.md stage 2b'};
  }
  const token = config.treasury?.zzyTokenAddress;
  if (!token) return {label: 'pons fee claim', ok: false, skipped: true, detail: 'treasury.zzyTokenAddress not set'};
  try {
    const data = encodeFunctionData({abi: parseAbi(c.abi), functionName: c.functionName, args: c.args ?? [token]});
    return {label: 'pons fee claim', ...await simulate(client, {account, to: config.pons?.locker ?? ADDRESSES.PONS_LOCKER, data})};
  } catch (e) {
    return {label: 'pons fee claim', ok: false, detail: `could not encode the call: ${short(e)}`};
  }
}

function short(e) {
  const m = e?.shortMessage || e?.details || e?.message || String(e);
  return m.split('\n')[0].slice(0, 160);
}

// Runs everything and returns a report. `account` is optional: without it the
// checks that need no wallet still run, so you can validate the plumbing
// before funding anything.
export async function preflight(client, config, {account = null, testUsd = 5, ethUsd = 3000} = {}) {
  const checks = [];
  const add = (name, r) => checks.push({name, ...r});

  add('RPC connection', await checkRpc(client, config.chain?.id ?? 4663));
  for (const [label, addr] of [
    ['WETH', ADDRESSES.WETH], ['Uniswap router', ADDRESSES.UNISWAP_SWAP_ROUTER],
    ['Uniswap quoter', ADDRESSES.UNISWAP_QUOTER_V2], ['pons locker', config.pons?.locker ?? ADDRESSES.PONS_LOCKER],
  ]) add(`${label} deployed`, await checkDeployed(client, label, addr));

  const router = await detectRouterVariant(client, ADDRESSES.UNISWAP_SWAP_ROUTER);
  add('Router variant', router);
  const variant = router.variant ?? config.uniswap?.routerVariant;
  if (router.variant && config.uniswap?.routerVariant && router.variant !== config.uniswap.routerVariant) {
    add('Router variant matches config', {ok: false,
      detail: `config says ${config.uniswap.routerVariant}, the chain says ${router.variant}. Trust the chain.`});
  }

  const amountIn = parseEther(String(testUsd / ethUsd));
  // The book's cash is USDG. Read its decimals rather than assuming six.
  let cashDec = 6;
  try { cashDec = Number(await client.readContract({address: ADDRESSES.USDG, abi: ERC20_ABI, functionName: 'decimals'})); } catch {}
  const cashIn = parseUnits(testUsd.toFixed(cashDec), cashDec);
  add('USDG deployed', await checkDeployed(client, 'USDG', ADDRESSES.USDG));
  const cashPool = await checkPool(client, {tokenIn: ADDRESSES.WETH, tokenOut: ADDRESSES.USDG, amountIn});
  add('WETH -> USDG pool quotes', cashPool);
  let symbol = null, tokenOut = null, pool = null;
  try {
    const {loadCatalog} = await import('./catalog.mjs');
    const cat = await loadCatalog(config);
    const first = cat?.symbols?.find(e => e.address);
    if (first) { symbol = first.symbol; tokenOut = first.address; }
  } catch { /* reported below */ }
  if (tokenOut) {
    add(`${symbol} token deployed`, await checkDeployed(client, symbol, tokenOut));
    // Stock tokens trade against USDG. A WETH pool is not what the bot uses.
    // Both venues are shown; the engine takes the better quote at trade time.
    pool = await checkPool(client, {tokenIn: ADDRESSES.USDG, tokenOut, amountIn: cashIn});
    add(`USDG -> ${symbol} v3 quote`, pool.ok ? pool : {...pool, ok: true, skipped: true, detail: (pool.detail ?? 'no v3 pool') + ' (v3 is optional; v4 below is where most names trade)'});
    try {
      const {bestV4Quote, discoverV4Pools} = await import('./adapters/uniswap-v4.mjs');
      const found = await discoverV4Pools(client, ADDRESSES.USDG, tokenOut).catch(() => []);
      add(`${symbol} v4 pools on chain`, found.length
        ? {ok: true, detail: found.map(p => `fee ${p.fee}/${p.tickSpacing}${p.hooks && p.hooks !== '0x0000000000000000000000000000000000000000' ? ' hook ' + p.hooks.slice(0, 10) + '…' : ''}`).join('; ')}
        : {ok: true, skipped: true, detail: 'none found by discovery; standard configs will be tried'});
      const notes = [];
      const v4 = await bestV4Quote(client, {tokenIn: ADDRESSES.USDG, tokenOut, amountIn: cashIn, allowedHooks: config.uniswap?.v4?.allowedHooks ?? [], log: m => notes.push(m)});
      for (const n of notes) add('v4 note', {ok: true, skipped: true, detail: n});
      add(`USDG -> ${symbol} v4 quote`, v4 ? {ok: true, detail: `pool at fee ${v4.fee}/${v4.tickSpacing}, quotes ${formatUnits(v4.amountOut, 18)} out for ${testUsd} USDG`} : {ok: false, detail: 'no v4 pool quotes either'});
      if (!pool.ok && v4) pool = {ok: true, fee: null, v4};
    } catch (e) { add(`USDG -> ${symbol} v4 quote`, {ok: false, detail: e.message.split('\n')[0]}); }
  } else {
    add('Catalog token', {ok: false, detail: 'no instrument with an address in the catalog; run npm run catalog:refresh'});
  }

  if (account) {
    add('Wallet balances', await checkBalances(client, account));
    add('Wrap ETH', await checkWrap(client, account, amountIn));
    add('Approve WETH', await checkApprove(client, account, amountIn));
    // A swap simulation needs the wallet to actually hold the input token;
    // an empty wallet fails with Uniswap's "STF" and that is not a bug. Skip
    // with a reason instead of failing, and re-run once cash has arrived.
    const wethHeld = await client.readContract({address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [account]}).catch(() => 0n);
    const usdgHeld = await client.readContract({address: ADDRESSES.USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [account]}).catch(() => 0n);
    if (cashPool?.ok && variant) {
      add('Swap WETH -> USDG', wethHeld >= amountIn
        ? await checkSwap(client, account, {tokenIn: ADDRESSES.WETH, tokenOut: ADDRESSES.USDG, fee: cashPool.fee, amountIn, variant, label: 'swap WETH -> USDG (fund the book)'})
        : {ok: true, skipped: true, detail: 'no WETH in the wallet to simulate with; only needed for a V1 token'});
    }
    add('Approve USDG', await checkApprove(client, account, cashIn, ADDRESSES.USDG, 'USDG approve -> router'));
    if (tokenOut && pool?.ok && pool.fee != null && variant) {
      add('Swap', usdgHeld >= cashIn
        ? await checkSwap(client, account, {tokenIn: ADDRESSES.USDG, tokenOut, fee: pool.fee, amountIn: cashIn, variant, label: `swap USDG -> ${symbol} (buy)`})
        : {ok: true, skipped: true, detail: `no USDG in the wallet yet; re-run preflight after the first claim to simulate a stock buy for real`});
    }
    // Pons V2: the claim is documented, so it can be checked for real.
    let v2launch = null;
    try {
      const {readLaunch, escrowOwed, buildClaimTx, quoteCurveBuy, quoteV4Buy, PHASE, fmt} = await import('./adapters/pons-v2.mjs');
      const {zeroAddress, formatUnits} = await import('viem');
      const token = config.treasury?.zzyTokenAddress;
      const launch = token ? await readLaunch(client, token, config.pons?.v2?.factory).catch(() => null) : null;
      v2launch = launch;
      if (launch) {
        const pairDec = launch.native ? 18 : Number(await client.readContract({address: launch.pairToken, abi: ERC20_ABI, functionName: 'decimals'}).catch(() => 18));
        const probe = 10n ** BigInt(pairDec) / 1000n;   // 0.001 of the quote asset, in its own decimals
        const pairName = launch.native ? 'ETH' : (launch.pairToken.toLowerCase() === ADDRESSES.USDG.toLowerCase() ? 'USDG' : 'the pair token');
        add('Pons V2 launch', {ok: true, detail: `${launch.phaseName}; quote ${launch.native ? 'ETH' : launch.pairToken}; creator fees to ${launch.creatorFeeRecipient}`});
        add('Creator fees reach this wallet', launch.creatorFeeRecipient.toLowerCase() === account.toLowerCase()
          ? {ok: true, detail: 'yes'} : {ok: false, detail: `fees go to ${launch.creatorFeeRecipient}, not ${account}`});
        const owed = await escrowOwed(client, account, launch.native ? zeroAddress : launch.pairToken, config.pons?.v2?.escrow);
        add('V2 escrow balance', {ok: true, detail: `${formatUnits(owed, pairDec)} ${pairName} owed`});
        const claimTx = buildClaimTx(launch.native ? zeroAddress : launch.pairToken, config.pons?.v2?.escrow);
        add('V2 escrow claim', owed > 0n ? await simulate(client, {account, to: claimTx.to, data: claimTx.data}) : {ok: true, skipped: true, detail: 'nothing owed yet, claim not simulated'});
        if (launch.phase === PHASE.NotGraduated) {
          const q = await quoteCurveBuy(client, launch.curve, probe, account).catch(e => ({error: e.message}));
          add('V2 curve quote', q.error ? {ok: false, detail: q.error.split('\n')[0]} : {ok: q.tokensOut > 0n, detail: `${fmt(q.tokensOut).toLocaleString('en-US', {maximumFractionDigits: 0})} $ZZY for 0.001 ${pairName}`});
        } else if (launch.phase === PHASE.PoolCreated) {
          const q = await quoteV4Buy(client, launch, probe).catch(e => ({error: e.message}));
          add('V2 v4 pool quote', q.error ? {ok: false, detail: q.error.split('\n')[0]} : {ok: q.amountOut > 0n, detail: `${fmt(q.amountOut).toLocaleString('en-US', {maximumFractionDigits: 0})} $ZZY for 0.001 ${pairName}`});
        }
      }
    } catch (e) { add('Pons V2 checks', {ok: false, detail: e.message.split('\n')[0]}); }
    // The V1 claim only applies to a V1 token.
    add('Claim fees (V1)', v2launch ? {ok: true, skipped: true, detail: 'V2 token; the V2 escrow claim above is the real check'} : await checkClaim(client, account, config));
  }

  const failed = checks.filter(c => !c.ok && !c.skipped);
  return {checks, passed: checks.filter(c => c.ok).length, failed: failed.length,
          ready: failed.length === 0, account, testUsd};
}
