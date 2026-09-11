// Resolves the two values that can't be guessed and that the docs don't state:
//
//   uniswap.routerVariant   SwapRouter or SwapRouter02
//   pons.claim.*            the locker's claim function
//   pons.claimable.*        the locker's creator-claimable view, if it has one
//
// Everything here is a read. Nothing is signed, nothing is sent, no key is
// touched. Run with --write to patch config/default.json in place.

import {readFile, writeFile} from 'node:fs/promises';
import {toFunctionSelector} from 'viem';
import {ADDRESSES, ROBINHOOD_CHAIN} from './chain.mjs';

const RPC = ROBINHOOD_CHAIN.rpcUrls.default.http[0];
const EXPLORER = ROBINHOOD_CHAIN.blockExplorers.default.url;

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
  });
  const json = await res.json();
  if (json.error) throw new Error(method + ': ' + json.error.message);
  return json.result;
}

async function getCode(address) {
  const code = await rpc('eth_getCode', [address, 'latest']);
  if (!code || code === '0x') throw new Error('no contract at ' + address);
  return code;
}

// Blockscout serves the verified ABI without a key on the instance endpoint.
// Returns null when the contract isn't verified, which is a real answer.
async function verifiedAbi(address) {
  const url = EXPLORER + '/api/v2/smart-contracts/' + address;
  try {
    const res = await fetch(url, {headers: {accept: 'application/json'}});
    if (!res.ok) return null;
    const json = await res.json();
    return Array.isArray(json.abi) ? {abi: json.abi, name: json.name || null} : null;
  } catch {
    return null;
  }
}

function has(code, signature) {
  return code.toLowerCase().includes(toFunctionSelector(signature).slice(2).toLowerCase());
}

// ── router ────────────────────────────────────────────────────────────
// SwapRouter02 folds in the V2 router and the position manager. The original
// SwapRouter has neither. Both selectors are checked so a single false
// positive can't decide it.
async function resolveRouter() {
  const address = ADDRESSES.UNISWAP_SWAP_ROUTER;
  const code = await getCode(address);

  const markers = {
    'positionManager()': has(code, 'function positionManager() view returns (address)'),
    'swapExactTokensForTokens(uint256,uint256,address[],address)':
      has(code, 'function swapExactTokensForTokens(uint256,uint256,address[],address) returns (uint256)'),
    'approveMax(address)': has(code, 'function approveMax(address)'),
    // present on the original only: multicall without the deadline overload
    'refundETH()': has(code, 'function refundETH() payable'),
  };

  const hits = ['positionManager()', 'swapExactTokensForTokens(uint256,uint256,address[],address)', 'approveMax(address)']
    .filter((k) => markers[k]).length;

  const verified = await verifiedAbi(address);
  let fromAbi = null;
  if (verified) {
    const fn = verified.abi.find((f) => f.type === 'function' && f.name === 'exactInputSingle');
    const fields = fn?.inputs?.[0]?.components?.map((c) => c.name) || [];
    if (fields.length) fromAbi = fields.includes('deadline') ? 'SwapRouter' : 'SwapRouter02';
  }

  const fromBytecode = hits >= 2 ? 'SwapRouter02' : 'SwapRouter';
  return {address, markers, hits, fromBytecode, fromAbi, verifiedName: verified?.name || null,
          variant: fromAbi || fromBytecode, agree: fromAbi ? fromAbi === fromBytecode : null};
}

// ── pons locker ───────────────────────────────────────────────────────
// No guessing: the claim function is whatever the verified source says it is.
// Candidates are surfaced, not auto-selected, unless exactly one is unambiguous.
export function signatureOf(fn) {
  const args = (fn.inputs || []).map((i) => i.type + (i.name ? ' ' + i.name : '')).join(', ');
  const outs = (fn.outputs || []).map((o) => o.type).join(', ');
  const mut = fn.stateMutability === 'view' || fn.stateMutability === 'pure' ? ' ' + fn.stateMutability : '';
  return 'function ' + fn.name + '(' + args + ')' + mut + (outs ? ' returns (' + outs + ')' : '');
}

async function resolveLocker() {
  const address = ADDRESSES.PONS_LOCKER;
  await getCode(address);
  const verified = await verifiedAbi(address);
  if (!verified) return {address, verified: false};

  const fns = verified.abi.filter((f) => f.type === 'function');
  const writes = fns.filter((f) => f.stateMutability !== 'view' && f.stateMutability !== 'pure');
  const views = fns.filter((f) => f.stateMutability === 'view' || f.stateMutability === 'pure');

  const claimish = /claim|collect|withdraw|harvest|sweep/i;
  const claimCandidates = writes.filter((f) => claimish.test(f.name)).map(signatureOf);
  const viewCandidates = views
    .filter((f) => claimish.test(f.name) || /fees?|owed|pending|earned/i.test(f.name))
    .map(signatureOf);

  return {address, verified: true, name: verified.name, claimCandidates, viewCandidates,
          allWrites: writes.map((f) => f.name)};
}

export function pickOne(candidates) {
  // Only auto-fill when there is exactly one candidate and it takes either
  // nothing or a single address. Anything else is a human decision.
  if (candidates.length !== 1) return null;
  const sig = candidates[0];
  const args = sig.slice(sig.indexOf('(') + 1, sig.indexOf(')'));
  if (args === '' || /^address(\s+\w+)?$/.test(args.trim())) return sig;
  return null;
}

export async function verify({write = false, configPath = 'config/default.json'} = {}) {
  const out = [];
  const router = await resolveRouter();

  out.push('ROUTER  ' + router.address);
  out.push('  verified as     ' + (router.verifiedName || 'not verified on Blockscout'));
  for (const [k, v] of Object.entries(router.markers)) out.push('  ' + (v ? 'has  ' : 'lacks') + '  ' + k);
  out.push('  bytecode says   ' + router.fromBytecode);
  out.push('  ABI says        ' + (router.fromAbi || 'unavailable'));
  if (router.agree === false) out.push('  ! bytecode and ABI disagree, do not set this automatically');
  out.push('  => routerVariant: ' + (router.agree === false ? 'UNRESOLVED' : router.variant));
  out.push('');

  const locker = await resolveLocker();
  out.push('PONS LOCKER  ' + locker.address);
  if (!locker.verified) {
    out.push('  not verified on Blockscout. The ABI cannot be read, so the claim');
    out.push('  signature has to come from pons directly. Ask in their channel, or');
    out.push('  decode a claim transaction sent by another creator.');
  } else {
    out.push('  verified as     ' + (locker.name || 'unnamed'));
    out.push('  claim candidates:');
    if (locker.claimCandidates.length) locker.claimCandidates.forEach((s) => out.push('    ' + s));
    else out.push('    none matched claim/collect/withdraw. All writes: ' + locker.allWrites.join(', '));
    out.push('  claimable views:');
    if (locker.viewCandidates.length) locker.viewCandidates.forEach((s) => out.push('    ' + s));
    else out.push('    none. Leave pons.claimable null and let the loop detect routed WETH.');
  }

  const claimSig = locker.verified ? pickOne(locker.claimCandidates) : null;
  const viewSig = locker.verified ? pickOne(locker.viewCandidates) : null;

  if (write) {
    const raw = await readFile(configPath, 'utf8');
    const cfg = JSON.parse(raw);
    const changed = [];

    if (router.agree !== false && router.variant) {
      cfg.uniswap.routerVariant = router.variant;
      changed.push('uniswap.routerVariant = ' + router.variant);
    }
    if (claimSig) {
      cfg.pons.claim.abi = [claimSig];
      cfg.pons.claim.functionName = claimSig.slice(9, claimSig.indexOf('('));
      changed.push('pons.claim = ' + claimSig);
    }
    if (viewSig) {
      cfg.pons.claimable.abi = [viewSig];
      cfg.pons.claimable.functionName = viewSig.slice(9, viewSig.indexOf('('));
      changed.push('pons.claimable = ' + viewSig);
    }

    out.push('');
    if (changed.length) {
      await writeFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
      out.push('WROTE ' + configPath);
      changed.forEach((c) => out.push('  ' + c));
      const left = [];
      if (!claimSig && locker.verified && locker.claimCandidates.length > 1) left.push('pons.claim (several candidates, pick one)');
      if (!locker.verified) left.push('pons.claim (locker not verified)');
      if (left.length) out.push('  still unset: ' + left.join(', '));
    } else {
      out.push('NOTHING WRITTEN. Nothing resolved unambiguously.');
    }
  } else {
    out.push('');
    out.push('Read only. Re-run with --write to patch ' + configPath + '.');
  }

  return out.join('\n');
}
