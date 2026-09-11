import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createOperatorWallet, operatorAddress, loadEnv, readEnvFile, envPermissionsOk, upsertEnv} from '../src/wallet.mjs';

const tmp = () => mkdtemp(path.join(tmpdir(), 'zzy-wallet-'));

test('a new wallet is written to .env and only the address comes back', async () => {
  const dir = await tmp(); const file = path.join(dir, '.env');
  try {
    const r = await createOperatorWallet({file});
    assert.match(r.address, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(!('privateKey' in r) && !JSON.stringify(r).includes('0x' + '0'.repeat(10)), 'the return value must not carry the key');
    const text = await readFile(file, 'utf8');
    assert.match(text, /^ZZY_OPERATOR_PRIVATE_KEY=0x[0-9a-fA-F]{64}$/m);
    assert.equal(await operatorAddress({file, env: {}}), r.address, 'the address derives from the saved key');
  } finally { await rm(dir, {recursive: true}); }
});

test('SECURITY: .env is owner-only, and that is reported', async () => {
  const dir = await tmp(); const file = path.join(dir, '.env');
  try {
    await createOperatorWallet({file});
    const st = await stat(file);
    assert.equal(st.mode & 0o777, 0o600);
    assert.equal(await envPermissionsOk(file), true);
    await writeFile(file, await readFile(file, 'utf8'), {mode: 0o644});
    const {chmod} = await import('node:fs/promises'); await chmod(file, 0o644);
    assert.equal(await envPermissionsOk(file), false, 'a world-readable key file must be flagged');
  } finally { await rm(dir, {recursive: true}); }
});

test('SECURITY: an existing key is never silently overwritten', async () => {
  const dir = await tmp(); const file = path.join(dir, '.env');
  try {
    const first = await createOperatorWallet({file});
    await assert.rejects(() => createOperatorWallet({file}), /already has an operator key/);
    assert.equal(await operatorAddress({file, env: {}}), first.address, 'the original key must survive');
  } finally { await rm(dir, {recursive: true}); }
});

test('an imported key works the same way: paste it into .env and the address is derived', async () => {
  const dir = await tmp(); const file = path.join(dir, '.env');
  try {
    // the well-known hardhat #0 test key, never used for anything real
    await upsertEnv('ZZY_OPERATOR_PRIVATE_KEY', '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', file);
    assert.equal(await operatorAddress({file, env: {}}), '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  } finally { await rm(dir, {recursive: true}); }
});

test('loadEnv fills process-style env without overriding a shell export', async () => {
  const dir = await tmp(); const file = path.join(dir, '.env');
  try {
    await upsertEnv('ANTHROPIC_API_KEY', 'from-file', file);
    await upsertEnv('OTHER', 'x', file);
    const env = {ANTHROPIC_API_KEY: 'from-shell'};
    await loadEnv(env, file);
    assert.equal(env.ANTHROPIC_API_KEY, 'from-shell', 'the shell wins');
    assert.equal(env.OTHER, 'x');
  } finally { await rm(dir, {recursive: true}); }
});

test('readEnvFile ignores comments and tolerates quotes', async () => {
  const dir = await tmp(); const file = path.join(dir, '.env');
  try {
    await writeFile(file, '# comment\nA="quoted"\nB=plain\n  C = spaced \n');
    assert.deepEqual(await readEnvFile(file), {A: 'quoted', B: 'plain', C: 'spaced'});
  } finally { await rm(dir, {recursive: true}); }
});
