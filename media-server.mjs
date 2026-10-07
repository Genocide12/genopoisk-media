// Genopoisk media proxy — standalone server for Render (free web service).
//
// Wraps the UNCHANGED production handler (media-handler.mjs = byte-identical
// copy of api/media/[...url].mjs from the Genopoisk repo) in a plain Node http
// server. The handler's (req, res) signature is exactly http.createServer's
// callback, so no adaptation is needed.
//
// Endpoints:
//   /api/media/<enc>  — the video proxy itself (same URL scheme as Vercel,
//                       so the production cutover is a single 307 redirect)
//   /health           — liveness + keep-alive ping target
//   /                 — service info (JSON)
//   /egress/status    — host-level CDN reachability (is interkh.com answering
//                       THIS machine's egress IP at all)
//   /egress/test?url= — the DECISIVE test: does the CDN serve REAL media
//                       segments to this egress IP? Pass a live tokened
//                       segment URL (from the player's devtools). GET, no
//                       auth: it is restricted to the same interkh.com
//                       allowlist the proxy itself uses, so it opens nothing
//                       the proxy doesn't already do.
//
// Render specifics: PORT comes from the environment (Render sets it), the
// server binds 0.0.0.0, TLS terminates at Render's edge (onrender.com
// hostname with automatic certificates).

import http from 'node:http';
import handler from './media-handler.mjs';

const PORT = Number(process.env.PORT || 8080);
const CDN_ROOT = 'https://hye1eaipby4w.interkh.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const INTERKH_RE = /^https?:\/\/[a-z0-9-]+\.interkh\.com\//i;

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

// Host-level probe: root of the CDN. NOTE: 410 Gone here is NORMAL and
// expected everywhere in the world — it only proves the host is reachable
// from this machine (no TCP/DNS block). Proving media egress requires a
// real tokened segment URL → /egress/test.
async function egressStatus() {
  try {
    const r = await fetch(CDN_ROOT, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(10000)
    });
    return { host_reachable: true, http: r.status, note: '410 on / is normal — host answered; run /egress/test?url=<live segment url> for the real verdict' };
  } catch (e) {
    return { host_reachable: false, error: e.code || e.name };
  }
}

// The decisive test: fetch a REAL media segment (browser UA, embess
// Referer, small Range) exactly like the production proxy does.
async function segmentTest(url) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://api.embess.ws/',
        'Range': 'bytes=0-1023'
      },
      signal: AbortSignal.timeout(20000)
    });
    const verdict = (r.status === 200 || r.status === 206)
      ? 'ALLOWED — this egress IP can serve video; hosting is suitable'
      : (r.status === 410 || r.status === 403)
        ? 'BLOCKED — the CDN refuses this egress IP; pick another hosting/region'
        : 'UNEXPECTED — repeat with a fresh segment URL (tokens expire)';
    return { http: r.status, verdict, ms: Date.now() - t0 };
  } catch (e) {
    return { http: 0, error: e.code || e.name, verdict: 'UNREACHABLE', ms: Date.now() - t0 };
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');

    // The proxy itself — exact same scheme as on Vercel.
    if (u.pathname.startsWith('/api/media/')) return handler(req, res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range'
      });
      return res.end();
    }

    if (u.pathname === '/' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'genopoisk-media-proxy',
        uptime_s: Math.round(process.uptime()),
        endpoints: ['/api/media/<enc>', '/health', '/egress/status', '/egress/test?url=<segment>']
      });
    }

    if (u.pathname === '/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, service: 'genopoisk-media-proxy', uptime_s: Math.round(process.uptime()) });
    }

    if (u.pathname === '/egress/status' && req.method === 'GET') {
      return json(res, 200, { ...(await egressStatus()), cdn: 'hye1eaipby4w.interkh.com' });
    }

    if (u.pathname === '/egress/test' && req.method === 'GET') {
      const url = u.searchParams.get('url');
      if (!url || !INTERKH_RE.test(url)) {
        return json(res, 400, { error: 'url must be a live interkh.com segment URL (copy from player devtools and URL-decode)' });
      }
      return json(res, 200, { ...(await segmentTest(url)) });
    }

    return json(res, 404, { error: 'not found', endpoints: ['/api/media/<enc>', '/health', '/egress/status', '/egress/test?url=<segment>'] });
  } catch (e) {
    return json(res, 500, { error: e.name || 'error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[media-proxy] listening on :${PORT} (handler = unchanged api/media/[...url].mjs)`);
});
