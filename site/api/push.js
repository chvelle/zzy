// The bot's way into the blob store without ever holding the store's token.
//
// Vercel keeps BLOB_READ_WRITE_TOKEN sensitive: it cannot be read back out
// of the dashboard, but a function deployed in this project can use it. So
// the bot POSTs data.json / history.json here with a shared secret it and
// this function both know (ZZY_PUSH_SECRET, a value you choose), and this
// function writes them to the blob. The token never leaves Vercel.
import {put} from '@vercel/blob';

const ALLOWED = new Set(['data.json', 'history.json']);
const MAX_BYTES = 4_000_000;

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({error: 'POST only'}); }
  const secret = process.env.ZZY_PUSH_SECRET;
  if (!secret || secret.length < 16) return res.status(500).json({error: 'ZZY_PUSH_SECRET is not set on this project'});
  const given = req.headers['x-zzy-push-secret'];
  if (!timingSafeEqual(String(given ?? ''), secret)) return res.status(401).json({error: 'bad secret'});
  if (!process.env.BLOB_READ_WRITE_TOKEN) return res.status(500).json({error: 'BLOB_READ_WRITE_TOKEN is not on this project; connect the blob store'});

  const {pathname, body, cacheSeconds} = req.body ?? {};
  if (!ALLOWED.has(pathname)) return res.status(400).json({error: 'pathname must be data.json or history.json'});
  if (typeof body !== 'string' || !body.length) return res.status(400).json({error: 'body must be the JSON text'});
  if (Buffer.byteLength(body) > MAX_BYTES) return res.status(413).json({error: 'too large'});
  try { JSON.parse(body); } catch { return res.status(400).json({error: 'body is not valid JSON'}); }

  try {
    const r = await put(pathname, body, {
      access: 'public', addRandomSuffix: false, allowOverwrite: true,
      contentType: 'application/json', cacheControlMaxAge: Math.max(60, Number(cacheSeconds) || 60),
    });
    return res.status(200).json({url: r.url, pathname});
  } catch (e) {
    return res.status(502).json({error: String(e?.message ?? e).slice(0, 200)});
  }
}
