import {parseUnits, toFunctionSelector, encodeFunctionData, parseEther, formatEther, parseAbi, getAddress} from 'viem';
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
    pool = await checkPool(client, {tokenIn: ADDRESSES.USDG, tokenOut, amountIn: cashIn});
    add(`USDG -> ${symbol} pool quotes`, pool);
  } else {
    add('Catalog token', {ok: false, detail: 'no instrument with an address in the catalog; run npm run catalog:refresh'});
  }

  if (account) {
    add('Wallet balances', await checkBalances(client, account));
    add('Wrap ETH', await checkWrap(client, account, amountIn));
    add('Approve WETH', await checkApprove(client, account, amountIn));
    if (cashPool?.ok && variant) add('Swap WETH -> USDG', await checkSwap(client, account, {tokenIn: ADDRESSES.WETH, tokenOut: ADDRESSES.USDG, fee: cashPool.fee, amountIn, variant, label: 'swap WETH -> USDG (fund the book)'}));
    add('Approve USDG', await checkApprove(client, account, cashIn, ADDRESSES.USDG, 'USDG approve -> router'));
    if (tokenOut && pool?.ok && variant) {
      add('Swap', await checkSwap(client, account, {tokenIn: ADDRESSES.USDG, tokenOut, fee: pool.fee, amountIn: cashIn, variant, label: `swap USDG -> ${symbol} (buy)`}));
    }
    add('Claim fees', await checkClaim(client, account, config));
  }

  const failed = checks.filter(c => !c.ok && !c.skipped);
  return {checks, passed: checks.filter(c => c.ok).length, failed: failed.length,
          ready: failed.length === 0, account, testUsd};
}
