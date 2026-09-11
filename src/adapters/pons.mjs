import {encodeFunctionData, parseAbi, formatEther, zeroAddress} from 'viem';
import {ADDRESSES, ERC20_ABI, PONS_FACTORY_ABI, PONS_LOCKER_READ_ABI, PONS_TOKEN_ABI} from '../chain.mjs';

// Everything under "documented" is copied from docs.ponsfamily.com.
// The claim write path is NOT documented there. It must be supplied in config
// from the verified locker source on Blockscout:
//   pons.claim.abi        e.g. ["function claimFees(address token)"]   <- read from Blockscout
//   pons.claim.functionName
//   pons.claimable.abi    a view returning the creator's claimable WETH, if the locker exposes one
//   pons.claimable.functionName
// Until those are set, claim() refuses and the loop falls back to detecting
// fees that pons automation has already routed to the payout wallet.

export async function readTokenInfo(client, token, factory = ADDRESSES.PONS_FACTORY) {
  const [symbol, pool, deployer, launched] = await Promise.all([
    client.readContract({address: token, abi: PONS_TOKEN_ABI, functionName: 'symbol'}),
    client.readContract({address: token, abi: PONS_TOKEN_ABI, functionName: 'liquidityPool'}),
    client.readContract({address: token, abi: PONS_TOKEN_ABI, functionName: 'deployer'}),
    client.readContract({address: factory, abi: PONS_FACTORY_ABI, functionName: 'getLaunchedToken', args: [token]}),
  ]);
  const locker = await client.readContract({address: factory, abi: PONS_FACTORY_ABI, functionName: 'locker'});
  const [protocolShare, redirect] = await Promise.all([
    client.readContract({address: locker, abi: PONS_LOCKER_READ_ABI, functionName: 'tokenProtocolFeeShares', args: [token]}),
    client.readContract({address: locker, abi: PONS_LOCKER_READ_ABI, functionName: 'feeRedirects', args: [token]}),
  ]);
  const l = launched.launched ?? launched;
  return {
    symbol, pool, deployer, locker,
    isToken0: l.isToken0, poolFee: Number(l.poolFee), pairedToken: l.pairedToken,
    creatorSharePercent: 100 - Number(protocolShare),
    creatorPayout: redirect === zeroAddress ? deployer : redirect,
  };
}

export async function graduation(client, token, factory = ADDRESSES.PONS_FACTORY) {
  const [pairedPrincipal, threshold, graduated] = await client.readContract({
    address: factory, abi: PONS_FACTORY_ABI, functionName: 'graduationStatus', args: [token],
  });
  return {pairedPrincipalEth: Number(formatEther(pairedPrincipal)), thresholdEth: Number(formatEther(threshold)), graduated};
}

// Creator-claimable WETH, if the locker exposes a view for it. Returns null
// when not configured -- callers must treat null as "unknown", not zero.
export async function readClaimableWeth(client, token, config) {
  const c = config.pons?.claimable;
  if (!c?.abi || !c?.functionName) return null;
  const raw = await client.readContract({
    address: config.pons?.locker ?? ADDRESSES.PONS_LOCKER,
    abi: parseAbi(c.abi), functionName: c.functionName, args: c.args ?? [token],
  });
  // Allow the view to return either a bare uint or a tuple; pick the index config says.
  const value = Array.isArray(raw) ? raw[c.wethIndex ?? 0] : raw;
  return Number(formatEther(BigInt(value)));
}

// Build (do not send) the claim tx. Refuses without a verified ABI.
export function buildClaimTx(token, config) {
  const c = config.pons?.claim;
  if (!c?.abi || !c?.functionName) {
    throw new Error('pons.claim.abi/functionName not configured. Read the verified locker on Blockscout and copy the claim function signature into config -- it is not in the pons docs and will not be guessed.');
  }
  return {
    to: config.pons?.locker ?? ADDRESSES.PONS_LOCKER,
    data: encodeFunctionData({abi: parseAbi(c.abi), functionName: c.functionName, args: c.args ?? [token]}),
    value: 0n,
  };
}

export function claimThresholdMet(claimableEth, config) {
  const threshold = config.pons?.claimThresholdEth ?? 0.42;
  return typeof claimableEth === 'number' && claimableEth >= threshold;
}

export async function wethBalance(client, address) {
  const raw = await client.readContract({address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [address]});
  return {wei: raw, eth: Number(formatEther(raw))};
}
