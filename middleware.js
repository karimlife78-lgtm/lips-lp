// Vercel Edge Middleware — runs BEFORE static files & rewrites, on every request.
// Lets a smart-link slug override even a REAL page folder (e.g. /ksa-22 → /ksa-20).
// If the slug isn't in the redirect map, the request passes through untouched.

export const config = {
  // run on real page paths only — skip api, /r, assets, and any file with an extension (.css/.js/.png…)
  matcher: ['/((?!api/|r/|assets/|shop/|_next/|.*\\.).+)']
};

// Known site-copiers / scrapers / scanners to block (LP-theft tools).
// NOTE: ad-platform preview crawlers (facebookexternalhit, tiktok, snapchat,
// whatsapp, googlebot, bingbot…) are NOT in this list — they must stay allowed
// so ad review can fetch the page and approve your campaigns.
const BAD_UA = /(httrack|wget|curl|python-requests|python-urllib|aiohttp|scrapy|go-http-client|libwww-perl|\blwp\b|okhttp|apache-httpclient|java\/|phantomjs|headlesschrome|puppeteer|playwright|selenium|node-fetch|axios|masscan|nikto|sqlmap|zgrab|nuclei|semrushbot|ahrefsbot|mj12bot|dotbot|dataforseo|serpstat|petalbot)/i;

function blocked() {
  return new Response('403 Forbidden', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

// Utility pages that are NEVER redirected — they skip the redirect lookup so
// they stay instant. ALL ksa-* product pages are intentionally NOT here: they
// must remain redirectable via smart-links (important business feature).
const NEVER_REDIRECT = new Set([
  'video-bot','shop','privacy','terms','favicon.svg','favicon.ico','robots.txt','sitemap.xml',
  'ksa-22'
]);

// ── redirect map cache — "stale-while-revalidate" ──────────────────────────
// FRESH window is short so your admin changes (add/remove a smart-link) show up
// in ~10s instead of up to 5 min. But we NEVER make a visitor wait for Google:
// once we have a map, a stale one is served instantly while a fresh copy is
// fetched in the background (event.waitUntil). Result: snappy changes AND fast pages.
let _cache = { at: 0, map: {} };
let _refreshAt = 0;                 // guards against duplicate/stuck background refreshes
const FRESH = 10_000;              // serve from memory with no refresh for 10s
const REFRESH_GUARD = 5_000;      // max time a single background refresh may hold the lock

async function fetchMap() {
  const base = process.env.GOOGLE_SCRIPT_URL;
  const token = process.env.SHEET_TOKEN || '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500); // don't let a slow GAS hang the page
  const r = await fetch(`${base}?action=redirects&token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
  clearTimeout(t);
  const data = await r.json();
  const map = {};
  (data.redirects || []).forEach(rd => { if (rd.slug) map[String(rd.slug).toLowerCase()] = rd.target; });
  return map;
}

function refresh(event) {
  // one refresh in flight at a time; auto-release the lock after REFRESH_GUARD
  // so a suspended isolate can't wedge refreshes forever.
  if (Date.now() - _refreshAt < REFRESH_GUARD) return _cache._p;
  _refreshAt = Date.now();
  const p = fetchMap()
    .then(map => { _cache = { at: Date.now(), map }; })
    .catch(() => { _cache = { at: Date.now(), map: _cache.map }; }) // keep old map, back off ~FRESH
    .finally(() => { _refreshAt = 0; });
  _cache._p = p;
  if (event && typeof event.waitUntil === 'function') { try { event.waitUntil(p); } catch (_) {} }
  return p;
}

async function loadMap(event) {
  const age = Date.now() - _cache.at;
  if (_cache.at && age < FRESH) return _cache.map;   // fresh → instant
  if (!_cache.at) { await refresh(event); return _cache.map; } // first-ever load must block
  refresh(event);                                    // stale → refresh in background, serve stale now
  return _cache.map;
}

export default async function middleware(request, event) {
  const url = new URL(request.url);

  // --- anti-scraper gate: block obvious site-copiers / empty user agents ---
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BAD_UA.test(ua)) return blocked();

  const slug = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')[0].toLowerCase();
  if (!slug) return; // homepage — never redirect

  // utility page that's never redirected → render immediately
  if (NEVER_REDIRECT.has(slug)) return;

  const map = await loadMap(event);
  const target = map[slug];
  if (!target) return; // no smart-link → serve the real page/alias normally

  const dest = /^https?:\/\//.test(target)
    ? target
    : new URL(target.startsWith('/') ? target : '/' + target, url.origin).toString();

  return Response.redirect(dest, 302);
}
