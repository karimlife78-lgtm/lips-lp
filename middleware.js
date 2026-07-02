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
  'video-bot','shop','privacy','terms','favicon.svg','favicon.ico','robots.txt','sitemap.xml'
]);

let _cache = { at: 0, map: {} };
const TTL = 300_000; // 5 min — once an edge isolate is warm it serves the map from memory (fast)

async function loadMap() {
  // serve from memory within TTL — cache EMPTY maps too, so pages with no active
  // redirect don't re-hit slow GAS on every request (the old bug that made TTFB ~1.7s)
  if (_cache.at && Date.now() - _cache.at < TTL) return _cache.map;
  try {
    const base = process.env.GOOGLE_SCRIPT_URL;
    const token = process.env.SHEET_TOKEN || '';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500); // don't let a slow GAS hang the page
    const r = await fetch(`${base}?action=redirects&token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
    clearTimeout(t);
    const data = await r.json();
    const map = {};
    (data.redirects || []).forEach(rd => { if (rd.slug) map[String(rd.slug).toLowerCase()] = rd.target; });
    _cache = { at: Date.now(), map };
  } catch (_) { _cache.at = Date.now(); /* cache the failure briefly to avoid hammering GAS */ }
  return _cache.map;
}

export default async function middleware(request) {
  const url = new URL(request.url);

  // --- anti-scraper gate: block obvious site-copiers / empty user agents ---
  const ua = request.headers.get('user-agent') || '';
  if (!ua || BAD_UA.test(ua)) return blocked();

  const slug = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/')[0].toLowerCase();
  if (!slug) return; // homepage — never redirect

  // utility page that's never redirected → render immediately
  if (NEVER_REDIRECT.has(slug)) return;

  const map = await loadMap();
  const target = map[slug];
  if (!target) return; // no smart-link → serve the real page/alias normally

  const dest = /^https?:\/\//.test(target)
    ? target
    : new URL(target.startsWith('/') ? target : '/' + target, url.origin).toString();

  return Response.redirect(dest, 302);
}
