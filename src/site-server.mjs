import {createServer} from 'node:http';
import {readFile, stat, watch} from 'node:fs/promises';
import path from 'node:path';

// Read-only static server for the public dashboard, plus a push channel.
//
//   - serves files under site/ and nothing else (path traversal rejected)
//   - GET/HEAD only; every other method is 405
//   - no dynamic endpoints except /events, which is one-way and read-only
//   - binds to 127.0.0.1 by default. Put Cloudflare / nginx / a tunnel in
//     front of it for the public internet; do not expose it directly.
//   - data.json is served no-store so the page's polling always sees the
//     latest tick.
//
// /events is Server-Sent Events. The bot writes data.json atomically (rename),
// the server watches for that rename and pushes the new document to every
// open connection within milliseconds. The page still polls as a fallback,
// so a static host without this server degrades to the 15s poll rather than
// breaking. Nothing flows upstream: the browser cannot send anything on this
// channel, and the server never touches the bot process.
//
// Or skip this entirely and host site/ on any static host (Cloudflare Pages,
// Vercel, GitHub Pages) with the bot pushing data.json -- that keeps the
// machine holding the operator key off the public internet altogether,
// which is the more secure option.

const TYPES = {'.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'};

export function createSiteServer({root = 'site', maxClients = 500, heartbeatMs = 20000} = {}) {
  const base = path.resolve(root);
  const dataFile = path.join(base, 'data.json');
  const clients = new Set();
  let lastPayload = null;
  let watching = false;

  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    // Locked down to what the page actually needs. The font CDN is the only
    // external origin allowed, and only for stylesheets and font files.
    'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'",
  };

  async function broadcast() {
    let body;
    try { body = await readFile(dataFile, 'utf8'); } catch { return; }
    if (body === lastPayload) return;
    lastPayload = body;
    const frame = `event: data\ndata: ${body.replace(/\n/g, '')}\n\n`;
    for (const res of clients) { try { res.write(frame); } catch { clients.delete(res); } }
  }

  // One watcher for the process, started lazily on the first subscriber.
  // Atomic writes show up as a rename, so both event kinds are handled, and
  // a short debounce collapses the rename+change pair into one push.
  const ac = new AbortController();
  async function startWatching() {
    if (watching) return; watching = true;
    let timer = null;
    try {
      for await (const ev of watch(base, {persistent: false, signal: ac.signal})) {
        if (ev.filename && ev.filename !== 'data.json') continue;
        clearTimeout(timer); timer = setTimeout(broadcast, 40);
      }
    } catch { watching = false; }
  }

  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, headers); return res.end(); }
    let url = decodeURIComponent((req.url ?? '/').split('?')[0]);

    if (url === '/events') {
      if (clients.size >= maxClients) { res.writeHead(503, headers); return res.end(); }
      res.writeHead(200, {...headers, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no'});
      res.write('retry: 3000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      startWatching();
      // Send the current document immediately so the page never waits for
      // the next tick to render.
      try { const body = await readFile(dataFile, 'utf8'); res.write(`event: data\ndata: ${body.replace(/\n/g, '')}\n\n`); } catch { /* not exported yet */ }
      return;
    }

    if (url === '/') url = '/index.html';
    const file = path.resolve(base, `.${url}`);
    if (!file.startsWith(base + path.sep)) { res.writeHead(403, headers); return res.end(); }
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error('not a file');
      const ext = path.extname(file);
      const body = await readFile(file);
      res.writeHead(200, {
        ...headers,
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': ext === '.json' ? 'no-store' : 'public, max-age=60',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, headers); res.end();
    }
  });

  // Keep proxies from closing idle streams, and reap dead sockets.
  const hb = setInterval(() => { for (const res of clients) { try { res.write(': hb\n\n'); } catch { clients.delete(res); } } }, heartbeatMs);
  hb.unref();
  // server.close() alone waits for open streams, and an SSE stream is open by
  // definition. shutdown() ends them first so the process can actually exit.
  server.shutdown = () => new Promise((resolve) => {
    clearInterval(hb); ac.abort();
    for (const res of clients) { try { res.end(); } catch {} }
    clients.clear();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
  server.clients = clients;
  return server;
}

export function listen(config) {
  const host = config.site?.serve?.host ?? '127.0.0.1';
  const port = config.site?.serve?.port ?? 4663;
  const server = createSiteServer();
  server.listen(port, host, () => console.log(`dashboard: http://${host}:${port}  (read-only; live via /events; put a proxy in front for public access)`));
  return server;
}
