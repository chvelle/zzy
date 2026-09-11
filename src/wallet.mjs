import {readFile, writeFile, stat, chmod} from 'node:fs/promises';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';

// Operator wallet helpers.
//
// The key is generated on your machine, written straight to .env with
// owner-only permissions, and never printed. The only thing this module ever
// shows you is the address. If you want to use a wallet you already have,
// paste its key into .env yourself; the same rule applies, nothing here
// echoes it back.

const ENV = '.env';

export async function readEnvFile(file = ENV) {
  try {
    const out = {};
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch { return {}; }
}

// Loads .env into process.env for keys that are not already set. Shell
// exports win, so `export ANTHROPIC_API_KEY=...` still overrides the file.
export async function loadEnv(env = process.env, file = ENV) {
  const vars = await readEnvFile(file);
  for (const [k, v] of Object.entries(vars)) if (env[k] === undefined) env[k] = v;
  return Object.keys(vars);
}

export async function upsertEnv(key, value, file = ENV) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch {}
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, '\n')}${line}\n`;
  await writeFile(file, text, {mode: 0o600});
  await chmod(file, 0o600);   // owner read/write only, even if the file existed
}

export async function createOperatorWallet({file = ENV} = {}) {
  const existing = await readEnvFile(file);
  if (existing.ZZY_OPERATOR_PRIVATE_KEY) {
    const addr = safeAddress(existing.ZZY_OPERATOR_PRIVATE_KEY);
    throw new Error(`.env already has an operator key (address ${addr ?? 'unreadable'}). Delete that line first if you really want a new one; the old key will be gone for good.`);
  }
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  await upsertEnv('ZZY_OPERATOR_PRIVATE_KEY', pk, file);
  return {address: account.address, file};
}

export function safeAddress(pk) {
  try { return privateKeyToAccount(pk).address; } catch { return null; }
}

export async function operatorAddress({file = ENV, env = process.env} = {}) {
  const pk = env.ZZY_OPERATOR_PRIVATE_KEY ?? (await readEnvFile(file)).ZZY_OPERATOR_PRIVATE_KEY;
  if (!pk) return null;
  return safeAddress(pk);
}

export async function envPermissionsOk(file = ENV) {
  try { const st = await stat(file); return (st.mode & 0o077) === 0; } catch { return null; }
}
