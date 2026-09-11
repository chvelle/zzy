import {createPublicClient, createWalletClient, http, parseEther, formatEther, formatUnits, numberToHex} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ROBINHOOD_CHAIN, ADDRESSES, ERC20_ABI} from './chain.mjs';

// Local fork mode.
//
// The testnet is a bare L2. Uniswap, the Stock Tokens and the pons locker are
// all mainnet deployments, so there is nothing there for the agent to trade
// against. Forking mainnet locally gives you the opposite: every real contract
// at its real address, real pool liquidity, real prices, and a wallet the fork
// hands you as much fake ETH as you want. Transactions are genuinely signed
// and genuinely executed, they just execute on your laptop.
//
// That makes this a better rehearsal than a testnet could ever be. It is the
// production code path against the production contracts.
//
// SAFETY. Fork mode lets the agent sign without the mainnet acknowledgement,
// which would be dangerous if it could ever point at the real chain. So before
// signing is enabled the RPC must be BOTH on loopback AND answer to an
// Anvil-only method. A remote URL is refused outright, whatever it claims.

export const FORK_RPC = 'http://127.0.0.1:8545';

function isLoopback(rpcUrl) {
  try {
    const u = new URL(rpcUrl);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  } catch { return false; }
}

async function rpc(rpcUrl, method, params = []) {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

// Both conditions must hold. Loopback alone is not enough: someone could
// tunnel a remote node to localhost. Anvil alone is not enough either.
export async function assertLocalFork(rpcUrl) {
  if (!isLoopback(rpcUrl)) {
    throw new Error(`fork mode refuses a non-local RPC (${rpcUrl}). It must be on 127.0.0.1.`);
  }
  let info;
  try { info = await rpc(rpcUrl, 'anvil_nodeInfo'); }
  catch { throw new Error(`no Anvil node at ${rpcUrl}. Start one with:  npm run fork`); }
  const forkedFrom = info?.forkConfig?.forkUrl ?? null;
  if (!forkedFrom) throw new Error('that Anvil node is not forking anything. Start it with --fork-url so the real contracts exist.');
  const chainId = Number(await rpc(rpcUrl, 'eth_chainId'));
  if (chainId !== ROBINHOOD_CHAIN.id) {
    throw new Error(`the fork reports chain ${chainId}, expected ${ROBINHOOD_CHAIN.id}. Fork Robinhood Chain, not something else.`);
  }
  return {ok: true, chainId, forkedFrom, blockNumber: Number(info?.forkConfig?.forkBlockNumber ?? 0)};
}

// Anvil lets you write balances directly. Real chains obviously do not, which
// is exactly why this only runs after assertLocalFork has passed.
export async function fundOnFork(rpcUrl, address, eth = '10') {
  await assertLocalFork(rpcUrl);
  await rpc(rpcUrl, 'anvil_setBalance', [address, numberToHex(parseEther(String(eth)))]);
  const client = forkClient(rpcUrl);
  return {address, balanceEth: formatEther(await client.getBalance({address}))};
}

export function forkClient(rpcUrl = FORK_RPC) {
  return createPublicClient({chain: {...ROBINHOOD_CHAIN, rpcUrls: {default: {http: [rpcUrl]}}}, transport: http()});
}

// Wraps ETH into WETH so the agent has something to trade with. The agent's
// own loop expects to find WETH in the wallet, the same as it would after a
// real fee claim.
export async function wrapOnFork(rpcUrl, privateKey, eth = '1') {
  await assertLocalFork(rpcUrl);
  const account = privateKeyToAccount(privateKey);
  const chain = {...ROBINHOOD_CHAIN, rpcUrls: {default: {http: [rpcUrl]}}};
  const wallet = createWalletClient({account, chain, transport: http()});
  const client = forkClient(rpcUrl);
  const hash = await wallet.sendTransaction({
    to: ADDRESSES.WETH, value: parseEther(String(eth)),
    data: '0xd0e30db0',   // deposit()
  });
  await client.waitForTransactionReceipt({hash});
  const weth = await client.readContract({address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address]});
  return {hash, wethEth: formatEther(weth), address: account.address};
}

// Swaps WETH into USDG on the fork, through the real pool, so the book has
// the cash it actually trades with. Returns what arrived.
export async function cashOnFork(rpcUrl, privateKey, eth = '1', routerVariant = 'SwapRouter02') {
  await assertLocalFork(rpcUrl);
  const {planWethToCash} = await import('./adapters/uniswap.mjs');
  const account = privateKeyToAccount(privateKey);
  const chain = {...ROBINHOOD_CHAIN, rpcUrls: {default: {http: [rpcUrl]}}};
  const wallet = createWalletClient({account, chain, transport: http()});
  const client = forkClient(rpcUrl);
  const before = await client.readContract({address: ADDRESSES.USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address]});
  const plan = await planWethToCash(client, {amountWei: parseEther(String(eth)), slippageBps: 100, recipient: account.address, routerVariant});
  const a = await wallet.sendTransaction({to: plan.approve.to, data: plan.approve.data, value: 0n});
  await client.waitForTransactionReceipt({hash: a});
  const s = await wallet.sendTransaction({to: plan.swap.to, data: plan.swap.data, value: 0n});
  const r = await client.waitForTransactionReceipt({hash: s});
  if (r.status !== 'success') throw new Error(`WETH->USDG swap reverted on the fork (${s})`);
  const after = await client.readContract({address: ADDRESSES.USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address]});
  const dec = Number(await client.readContract({address: ADDRESSES.USDG, abi: ERC20_ABI, functionName: 'decimals'}));
  return {hash: s, fee: plan.fee, usdg: Number(formatUnits(after - before, dec)), address: account.address};
}

export async function forkStatus(rpcUrl, address) {
  const info = await assertLocalFork(rpcUrl);
  const client = forkClient(rpcUrl);
  const block = await client.getBlockNumber();
  const out = {...info, currentBlock: Number(block)};
  if (address) {
    out.address = address;
    out.ethBalance = formatEther(await client.getBalance({address}));
    out.wethBalance = formatEther(await client.readContract({address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [address]}).catch(() => 0n));
    out.usdgBalance = formatUnits(await client.readContract({address: ADDRESSES.USDG, abi: ERC20_ABI, functionName: 'balanceOf', args: [address]}).catch(() => 0n), 6);
  }
  return out;
}

// Config overrides for a fork run. Live signing is turned on because the money
// is fake, but only the caller that has already run assertLocalFork should be
// applying this.
export function forkConfig(config, rpcUrl = FORK_RPC) {
  const ledgerPath = config.fork?.ledgerPath ?? 'data/fork-ledger.json';
  return {
    ...config,
    mode: 'live',
    chain: {...config.chain, rpcUrl},
    _fork: true,
    // Its own ledger. A rehearsal must never write into the book that funds
    // live trading, and its entries are labelled so the public site drops them.
    treasury: {...config.treasury, ledgerPath},
    positions: {path: config.fork?.positionsPath ?? 'data/fork-positions.json'},
    execution: {...config.execution, maxTxValueWei: String(parseEther('100'))},
  };
}

// Seeds the fork ledger so the trading leg has capital. Wrapping WETH puts
// money in the wallet; the book is ledger-based, so it has to be told.
export async function seedForkBook(config, {tradingUsd, rpcUrl = FORK_RPC, now = new Date()} = {}) {
  await assertLocalFork(rpcUrl);
  if (!(tradingUsd > 0)) throw new Error('tradingUsd must be positive');
  const {mkdir, writeFile} = await import('node:fs/promises');
  const path = (await import('node:path')).default;
  const file = forkConfig(config, rpcUrl).treasury.ledgerPath;
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, `${JSON.stringify({
    schemaVersion: 1, fork: true,
    entries: [{
      type: 'fee-claim', at: now.toISOString(), fork: true,
      claimUsd: tradingUsd * 2, claimEth: null,
      buybackUsd: tradingUsd, tradingUsd,
      txHash: 'fork', zzyDisposition: 'simulated',
    }],
  }, null, 2)}\n`);
  return {file, tradingUsd};
}
