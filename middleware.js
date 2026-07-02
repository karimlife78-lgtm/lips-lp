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

// Real pages (folders) that must render INSTANTLY — they skip the Google Apps
// Script redirect lookup entirely, so no slow network call blocks their TTFB.
// Add any new page folder here so it stays fast. Smart-links (any slug NOT in
// this set) still consult the redirect map below.
const REAL_PAGES = new Set([
  'ksa-18','ksa-22','ksa-20','ksa-calm','ksa-feet','ksa-glow','ksa-gut',
  'video-bot','shop','privacy','terms','favicon.svg','favicon.ico'
]);

let _cache = { at: 0, map: {} };
const TTL = 300_000; // 5 min — the redirect map rarely changes; fewer slow GAS hits

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

  // --- anti-scraper gate: block obvious site-copiers / empty user agents ---
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BAD_UA.test(ua)) return blocked();

  const slug = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')[0].toLowerCase();
  if (!slug) return; // homepage — never redirect

  // known real page → render immediately, no slow redirect-map lookup
  if (REAL_PAGES.has(slug)) return;

  const map = await loadMap();
  const target = map[slug];
  if (!target) return; // no smart-link → serve the real page/alias normally

  const dest = /^https?:\/\//.test(target)
    ? target
    : new URL(target.startsWith('/') ? target : '/' + target, url.origin).toString();

  return Response.redirect(dest, 302);
}
