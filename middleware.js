// Vercel Edge Middleware — runs BEFORE static files & rewrites, on every request.
// Lets a smart-link slug override even a REAL page folder (e.g. /ksa-22 → /ksa-20).
// If the slug isn't in the redirect map, the request passes through untouched.

export const config = {
  // run on real page paths only — skip api, /r, assets, and any file with an extension (.css/.js/.png…)
  matcher: ['/((?!api/|r/|assets/|shop/|_next/|.*\\.).+)']
};

let _cache = { at: 0, map: {} };
const TTL = 60_000;

async function loadMap() {
  if (Date.now() - _cache.at < TTL && Object.keys(_cache.map).length) return _cache.map;
  try {
    const base = process.env.GOOGLE_SCRIPT_URL;
    const token = process.env.SHEET_TOKEN || '';
    const r = await fetch(`${base}?action=redirects&token=${encodeURIComponent(token)}`);
    const data = await r.json();
    const map = {};
    (data.redirects || []).forEach(rd => { if (rd.slug) map[String(rd.slug).toLowerCase()] = rd.target; });
    _cache = { at: Date.now(), map };
  } catch (_) { /* keep stale cache on failure */ }
  return _cache.map;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')[0].toLowerCase();
  if (!slug) return; // homepage — never redirect

  const map = await loadMap();
  const target = map[slug];
  if (!target) return; // no smart-link → serve the real page/alias normally

  const dest = /^https?:\/\//.test(target)
    ? target
    : new URL(target.startsWith('/') ? target : '/' + target, url.origin).toString();

  return Response.redirect(dest, 302);
}
