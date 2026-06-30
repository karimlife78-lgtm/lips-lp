// ============================================================================
//  Cosmarab Custom-URL Alias  —  /<custom-path>  →  serves a real page
// ----------------------------------------------------------------------------
//  Lets you invent any clean URL from the admin (e.g. cosmarab.com/ksa-80)
//  that SERVES an existing page (e.g. /ksa-18) while KEEPING the custom URL
//  in the address bar (proxy, not redirect). Map lives in the Redirects sheet
//  — target stored as an internal path like "/ksa-18". External http targets
//  fall back to a 302 redirect. Cached 60s to stay fast.
// ============================================================================
let CACHE = { at: 0, map: {} };
const TTL = 60 * 1000;

async function loadMap() {
  if (Date.now() - CACHE.at < TTL && Object.keys(CACHE.map).length) return CACHE.map;
  const base = process.env.GOOGLE_SCRIPT_URL;
  if (!base) return CACHE.map;
  try {
    const u = new URL(base);
    u.searchParams.set('action', 'redirects');
    u.searchParams.set('token', process.env.SHEET_TOKEN || '');
    const data = await fetch(u.toString(), { redirect: 'follow' }).then(r => r.json());
    const map = {};
    (data.redirects || []).forEach(r => { if (r.slug) map[String(r.slug).toLowerCase()] = r.target; });
    CACHE = { at: Date.now(), map };
  } catch (_) { /* keep stale cache on failure */ }
  return CACHE.map;
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end('<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><title>404</title>'
    + '<body style="background:#0a0a0a;color:#fff;font-family:Tahoma;text-align:center;padding:80px 20px">'
    + '<div style="font-size:60px">🔍</div><h1>404 — الصفحة غير موجودة</h1>'
    + '<p style="color:#888"><a href="/" style="color:#e6c97a">العودة للرئيسية</a></p></body></html>');
}

module.exports = async function handler(req, res) {
  const path = String((req.query && req.query.path) || '')
    .toLowerCase().replace(/^\/+/, '').replace(/\/+$/, '').trim();

  if (!path) return notFound(res);

  const map = await loadMap();
  const target = map[path];

  if (!target) return notFound(res);

  // external URL → simple redirect
  if (target.indexOf('http') === 0) {
    res.statusCode = 302;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Location', target);
    return res.end();
  }

  // internal path → proxy the page so the custom URL stays in the address bar
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const dest  = target.indexOf('/') === 0 ? target : '/' + target;
  const url   = proto + '://' + host + dest;

  try {
    const upstream = await fetch(url, { headers: { 'user-agent': req.headers['user-agent'] || '' } });
    if (!upstream.ok) return notFound(res);
    const html = await upstream.text();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.end(html);
  } catch (e) {
    // fallback: redirect so the visitor still lands on the real page
    res.statusCode = 302;
    res.setHeader('Location', dest);
    return res.end();
  }
};
