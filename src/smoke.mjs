import {createPublicClient, createWalletClient, http, formatEther, parseEther} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {ROBINHOOD_TESTNET} from './chain.mjs';

// Testnet smoke test. Answers one question with zero ambiguity: can this
// machine, with this key, sign a transaction and get it mined?
//
// It sends a tiny amount of test ETH from the operator wallet to itself.
// That exercises the key, the RPC, nonce handling, gas estimation, signing,
// broadcast and receipt, which is the entire execution pipeline, without
// needing any contract to exist on the testnet.
//
// It refuses to run on anything but chain 46630. This bypasses the guarded
// signer (a self-transfer is not on its allowlist, correctly), so the chain
// check is the thing that keeps it harmless.

export async function smokeTest({privateKey, rpcUrl = ROBINHOOD_TESTNET.rpcUrls.default.http[0], amountEth = '0.0001', log = () => {}} = {}) {
  if (!privateKey) throw new Error('no operator key. Run: npm run wallet:new');
  const account = privateKeyToAccount(privateKey);
  const chain = {...ROBINHOOD_TESTNET, rpcUrls: {default: {http: [rpcUrl]}}};
  const pub = createPublicClient({chain, transport: http()});
  const wallet = createWalletClient({account, chain, transport: http()});

  const chainId = await pub.getChainId();
  if (chainId !== ROBINHOOD_TESTNET.id) {
    throw new Error(`refusing: connected to chain ${chainId}, this only runs on the testnet (${ROBINHOOD_TESTNET.id})`);
  }
  log(`connected to ${chain.name}, chain ${chainId}`);

  const balance = await pub.getBalance({address: account.address});
  log(`wallet ${account.address} has ${formatEther(balance)} test ETH`);
  if (balance === 0n) {
    throw new Error(`wallet is empty. Get test ETH at ${ROBINHOOD_TESTNET.faucet} for ${account.address}, then run this again.`);
  }

  const value = parseEther(amountEth);
  log(`sending ${amountEth} ETH to itself...`);
  const hash = await wallet.sendTransaction({to: account.address, value});
  log(`broadcast: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({hash, timeout: 120_000});
  const after = await pub.getBalance({address: account.address});
  const gasEth = formatEther(balance - after);
  log(`mined in block ${receipt.blockNumber}, status ${receipt.status}, gas cost ${gasEth} ETH`);
  return {
    ok: receipt.status === 'success', hash, block: Number(receipt.blockNumber), gasEth,
    explorer: `${ROBINHOOD_TESTNET.blockExplorers.default.url}/tx/${hash}`,
    address: account.address,
  };
}
