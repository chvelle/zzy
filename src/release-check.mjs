// Scans the tree for anything that must not be published: keys, tokens,
// wallet keys, personal identifiers, and state files that belong to one
// operator. Runs before a release and refuses if it finds anything.
//
// Contract addresses are expected and allowed (the ones in chain.mjs and
// the catalog). Anything else that looks like a wallet or a key is a stop.

import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {ADDRESSES} from './chain.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', '.vercel']);
const TEXT = /\.(mjs|js|json|md|html|txt|example|yml|yaml|css)$/;

// Files that hold one operator's state and must not be committed.
const MUST_NOT_EXIST_IN_RELEASE = [
  '.env', 'site/.env.local', 'site/.env.vercel', 'data/positions.json', 'data/notebook.json', 'data/pnl-history.json',
  'data/social-log.json', 'data/earnings.json', 'data/prices.json', 'data/paper-ledger.json', 'data/fork-ledger.json',
  'treasury/ledger.json', 'site/feed.json',
];

const PATTERNS = [
  ['Anthropic API key', /sk-ant-api[0-9A-Za-z_-]{20,}/],
  ['private key', /\b0x[0-9a-fA-F]{64}\b/],
  ['Vercel blob token', /vercel_blob_rw_[0-9A-Za-z_-]{10,}/],
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['session token in a URL', /token=[A-Za-z0-9_-]{20,}/],
];

const KNOWN_ADDRESSES = new Set(Object.values(ADDRESSES).map(a => a.toLowerCase()));
const ALLOWED_EMAILS = [/example\.com$/, /you@/, /t@t\.t/, /^i@izs\.me$/];
// Anvil's published test accounts. Public by design, used only on the fork.
const ANVIL_KEYS = ['0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'];

async function* walk(dir) {
  for (const e of await readdir(dir, {withFileTypes: true})) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

export async function releaseCheck({root = '.', catalogPath = 'data/stock-token-catalog.json'} = {}) {
  const findings = [];
  let catalogAddrs = new Set();
  try { catalogAddrs = new Set(JSON.parse(await readFile(path.join(root, catalogPath), 'utf8')).symbols.map(s => s.address.toLowerCase())); } catch {}

  for (const f of MUST_NOT_EXIST_IN_RELEASE) {
    try { await stat(path.join(root, f)); findings.push({file: f, kind: 'operator state file present', hint: 'it is gitignored, but do not ship it in a zip either'}); } catch {}
  }

  for await (const file of walk(root)) {
    if (!TEXT.test(file)) continue;
    const rel = path.relative(root, file);
    if (rel.startsWith('site/data.json') || rel.startsWith('site/history.json') || rel === 'package-lock.json') continue;
    // embedded images are base64 noise, not secrets
    const text = (await readFile(file, 'utf8')).replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/g, 'data:image;base64,...');
    for (const [kind, re] of PATTERNS) {
      for (const m of text.matchAll(new RegExp(re.source, 'g' + re.flags.replace('g', '')))) {
        const hit = m[0];
        if (kind === 'email address' && ALLOWED_EMAILS.some(p => p.test(hit))) continue;
        if (kind === 'private key' && ANVIL_KEYS.includes(hit.toLowerCase())) continue;
        findings.push({file: rel, kind, sample: hit.slice(0, 6) + '…'});
      }
    }
    // wallet addresses that are not contracts we know
    for (const m of text.matchAll(/\b0x[0-9a-fA-F]{40}\b/g)) {
      const a = m[0].toLowerCase();
      if (KNOWN_ADDRESSES.has(a) || catalogAddrs.has(a)) continue;
      if (/^0x(0+|1+|2+|3+|9+|a+|d+)$/i.test(a) || /^0x(1111|2222|3333|9999|dead)/i.test(a)) continue;   // test fixtures
      if (rel.startsWith('tests/')) continue;
      findings.push({file: rel, kind: 'wallet address (not a known contract)', sample: m[0].slice(0, 10) + '…'});
    }
  }
  return {clean: findings.length === 0, findings};
}
