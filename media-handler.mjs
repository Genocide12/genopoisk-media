// STREAMING MEDIA PROXY for the video CDN (v177) — SERVERLESS (Node) runtime.
//
// WHY: the video CDN (*.interkh.com) serves manifests (.mpd/.m3u8) and
// subtitles to any IP, but returns HTTP 410 Gone for MEDIA SEGMENTS
// requested from some IPs (measured 2026-09-25: RU residential → 410,
// Vercel EDGE PoP egress → 410, AWS us-east-1 serverless egress → 200,
// other datacenters vary). So this proxy runs on the SERVERLESS runtime
// (default region iad1, AWS egress — the egress the CDN allows) — the
// OPPOSITE of the embed proxy (api/embed-edge.js), because api.embess.ws
// blocks AWS lambdas but allows edge PoPs. Two channels, two egresses.
//
// URL SCHEME — SINGLE PATH SEGMENT, custom-encoded:
//   /api/media/<encodeURIComponent(upstream) with $ { } kept raw>
// e.g. /api/media/https%3A%2F%2Fcdn.interkh.com%2Fbase%2F1277863.mpd%3Ftok%3D1
//
// WHY THIS SHAPE (measured on Vercel prod, 2026-09-25):
//   - multi-segment paths (/api/media/a/b) DO NOT reach api/media/[...url].js
//     (Vercel routes only the single dynamic segment) → the upstream URL
//     must be ONE segment → slashes percent-encoded;
//   - raw 'https://' in the path is 308-redirected by Vercel's '//' collapse;
//   - '$' '{' '}' are kept raw so dash.js $Number$/$Time$/$RepresentationID$
//     templates and venoplayer ${spriteNum} substitution keep working.
// Consequence: relative segment URIs in MPD (they resolve against the
// manifest URL, which no longer carries the upstream path) MUST be
// pre-resolved to absolute wrapped URLs — see rewriteMpd(). m3u8 relative
// lines are pre-resolved the same way — see rewriteM3u8().
//
// SECURITY: strict host allowlist — only the video CDN and its embed API
// hosts can be proxied. Range headers are forwarded (byte-range DASH),
// statuses pass through (410/403/206 reach the player so its failover
// logic can react).
//
// NOTE: no `export const config` — the Node serverless runtime is the
// DEFAULT; an explicit `{ runtime: 'nodejs' }` config value breaks the
// Vercel build (valid values there are e.g. 'edge' or '@vercel/node@x').

import { Readable } from 'node:stream';

const ALLOWED_HOST = /^(?:[a-z0-9-]+\.)*(?:interkh\.com|embess\.ws|stiven-king\.com)$/i;
const PROXY_MARK = '/api/media/';
const ABS_MEDIA_URL_RE = /https?:\/\/[a-z0-9-]+\.interkh\.com\/[^\s"'<>\\]+/gi;
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ===== x-en-x cipher (reverse-engineered from api.embess.ws/cdn.js) =====
// cdn.js rewrites media URLs as <origin>/x-en-x/<hash> where
// hash = substitute(btoa(hourBucket + '/' + pathname + search)) with a
// fixed 52-char alphabet substitution. The service is bucket-tolerant, so
// we only need the REVERSE direction: decode the hash back to the upstream
// path+query and fetch it through the proxy (the /x-en-x/ edge geo-blocks
// RU IPs; our AWS egress passes).
const XENX_L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const XENX_E = 'DlChEXitLONYRkFjAsnBbymWzSHMqKPgQZpvwerofJTVdIuUcxaG';

function decodeXenx(origin, hash) {
  try {
    const rev = hash.split('').map(c => { const i = XENX_E.indexOf(c); return i > -1 ? XENX_L[i] : c; }).join('');
    const decoded = Buffer.from(rev, 'base64').toString('utf8'); // "<hour>//<path>?<query>"
    const m = decoded.match(/^\d+\/(\/.+)$/);
    if (!m) return null;
    const abs = origin + m[1];
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch (e) {
    return null;
  }
}

// Custom path-segment encoder: encodeURIComponent, but keeps $ { } raw
// (dash.js templates / venoplayer substitutions).
function encForPath(u) {
  return encodeURIComponent(u).replace(/%24/g, '$').replace(/%7B/g, '{').replace(/%7D/g, '}');
}

function wrapUpstream(u, origin) {
  return origin + PROXY_MARK + encForPath(u);
}

function isAllowedAbs(u) {
  try {
    return ALLOWED_HOST.test(new URL(u).hostname);
  } catch (e) {
    return false;
  }
}

// Decode XML entities and resolve against a base URL.
function resolveUp(u, base) {
  const s = String(u).replace(/&amp;/g, '&');
  try {
    const abs = new URL(s, base).href;
    return /^https?:\/\//i.test(abs) ? abs : null;
  } catch (e) {
    return null;
  }
}

function upstreamFromRequest(url) {
  // Primary: single encoded segment /api/media/<enc>
  if (url.pathname.indexOf(PROXY_MARK) === 0) {
    const seg = url.pathname.slice(PROXY_MARK.length);
    if (seg && seg.indexOf('/') === -1) {
      try {
        const decoded = decodeURIComponent(seg);
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch (e) { /* bad encoding — fall through */ }
    }
    // Legacy raw path-style (kept for local dev / other platforms).
    let raw = url.pathname.slice(PROXY_MARK.length) + url.search;
    raw = raw.replace(/^(https?):\/(?!\/)/i, '$1://');
    if (/^https?:\/\//i.test(raw)) return raw;
  }
  // Fallback: /api/media/<anything>?u=<encoded>
  const q = url.searchParams.get('u');
  if (q && /^https?:\/\//i.test(q)) return q;
  return null;
}

// MPD: wrap <BaseURL>, pre-resolve RELATIVE SegmentTemplate/SegmentURL
// attributes (initialization/media/source) against the ORIGINAL upstream
// base and wrap them absolute. $-templates stay raw after encForPath.
function rewriteMpd(text, manifestUrl, origin) {
  let firstBase = null;
  text = text.replace(/<BaseURL>([^<]*)<\/BaseURL>/g, function (m, inner) {
    const abs = resolveUp(inner, manifestUrl);
    if (!abs || !isAllowedAbs(abs)) return m;
    if (!firstBase) firstBase = abs;
    return '<BaseURL>' + wrapUpstream(abs, origin) + '</BaseURL>';
  });
  const effectiveBase = firstBase || manifestUrl;
  text = text.replace(/\b(initialization|media|source)="([^"]*)"/g, function (m, attr, val) {
    if (!val) return m;
    const abs = resolveUp(val, effectiveBase);
    if (!abs || !isAllowedAbs(abs)) return m;
    return attr + '="' + wrapUpstream(abs, origin) + '"';
  });
  // Remaining absolute interkh URLs anywhere else in the document.
  text = text.replace(ABS_MEDIA_URL_RE, function (m) {
    return wrapUpstream(m, origin);
  });
  return text;
}

// m3u8: rewrite URI="..." tag attributes and playlist lines. Relative
// lines resolve against the ORIGINAL upstream playlist URL, then wrap.
// Already-wrapped (proxied) lines are genopoisk URLs → not on the
// allowlist → left untouched (natural double-wrap guard).
function rewriteM3u8(text, playlistUrl, origin) {
  return text.split('\n').map(function (line) {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.charAt(0) === '#') {
      return line.replace(/URI="([^"]+)"/g, function (m, val) {
        const abs = resolveUp(val, playlistUrl);
        if (!abs || !isAllowedAbs(abs)) return m;
        return 'URI="' + wrapUpstream(abs, origin) + '"';
      });
    }
    const abs = resolveUp(trimmed, playlistUrl);
    if (!abs || !isAllowedAbs(abs)) return line;
    return wrapUpstream(abs, origin);
  }).join('\n');
}

function isManifestType(ct) {
  return /dash\+xml|mpegurl/i.test(ct || '');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length'
};

// Node serverless handler signature: (req, res) — NOT the Web (Request/
// Response) API, which only works on the Edge runtime. This function MUST
// stay on Node: the video CDN 410s edge-PoP egress but serves AWS egress.
export default async function handler(req, res) {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        ...CORS_HEADERS
      });
      return res.end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', ...CORS_HEADERS });
      return res.end('Method not allowed');
    }

    const host = req.headers.host || 'genopoisk.vercel.app';
    const url = new URL(req.url, 'https://' + host);
    const rawUpstream = upstreamFromRequest(url);
    if (!rawUpstream) { res.writeHead(400, CORS_HEADERS); return res.end('Bad proxy URL'); }

    let up;
    try {
      up = new URL(rawUpstream);
    } catch (e) {
      res.writeHead(400, CORS_HEADERS); return res.end('Bad upstream URL');
    }
    // x-en-x decode: /x-en-x/<hash> → the real upstream URL.
    const xenxMatch = up.pathname.match(/^\/x-en-x\/(.+)$/);
    if (xenxMatch) {
      const real = decodeXenx(up.origin, xenxMatch[1]);
      if (real) {
        try { up = new URL(real); } catch (e) { /* keep encoded form */ }
      }
    }
    if (!/^https?:$/.test(up.protocol)) { res.writeHead(400, CORS_HEADERS); return res.end('Bad protocol'); }
    if (!ALLOWED_HOST.test(up.hostname)) { res.writeHead(403, CORS_HEADERS); return res.end('Host not allowed'); }

    // ALWAYS send a browser UA — the video CDN 410s media requests with
    // non-browser User-Agents (measured: node/undici UA → 410, Chrome UA →
    // 200 from the same egress). No UA/IP consistency check, so a hardcoded
    // desktop Chrome UA is the safest uniform choice (also covers exotic
    // in-app webviews and HTTP clients).
    const reqHeaders = {
      'User-Agent': DEFAULT_UA,
      'Referer': 'https://api.embess.ws/',
      'Accept': '*/*',
      'Accept-Language': 'ru-RU,ru;q=0.9'
    };
    if (req.headers.range) reqHeaders['Range'] = req.headers.range;

    const upstream = await fetch(up.href, {
      method: req.method,
      headers: reqHeaders,
      redirect: 'follow'
    });

    const ct = upstream.headers.get('content-type') || '';

    // Manifests: read + rewrite so the whole chain stays inside the proxy.
    if (upstream.ok && req.method === 'GET') {
      const looksMpd = /dash\+xml/i.test(ct) || /\.mpd(?:[?#]|$)/i.test(up.pathname);
      const looksM3u8 = /mpegurl/i.test(ct) || /\.m3u8(?:[?#]|$)/i.test(up.pathname);
      if (looksMpd || looksM3u8 || isManifestType(ct)) {
        const text = await upstream.text();
        if (text.indexOf('<MPD') !== -1 || text.indexOf('#EXTM3U') !== -1) {
          const rewritten = text.indexOf('<MPD') !== -1
            ? rewriteMpd(text, up.href, url.origin)
            : rewriteM3u8(text, up.href, url.origin);
          res.writeHead(upstream.status, {
            'Content-Type': ct,
            'Cache-Control': 'no-store',
            ...CORS_HEADERS
          });
          return res.end(rewritten);
        }
      }
    }

    // Media (and manifest errors): stream the body through untouched.
    const h = { ...CORS_HEADERS };
    const passthrough = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified'];
    for (let i = 0; i < passthrough.length; i++) {
      const v = upstream.headers.get(passthrough[i]);
      if (v) h[passthrough[i]] = v;
    }
    // Segments are immutable per tokened URL — cache in the browser to save
    // function invocations on seeks and re-watches. Manifests are never cached.
    if (!h['cache-control']) h['Cache-Control'] = 'public, max-age=3600';

    res.writeHead(upstream.status, h);
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    // WHATWG (fetch) stream → Node stream.
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    try {
      if (!res.headersSent) res.writeHead(502, CORS_HEADERS);
      res.end('Upstream fetch failed');
    } catch (_) { /* socket gone */ }
  }
}
