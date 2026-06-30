// ============================================================================
//  Cosmarab Smart-Link Redirect  —  /r/<slug>  →  302 to your real target
// ----------------------------------------------------------------------------
//  Put a STABLE link in your ad (e.g. cosmarab.com/r/snap-oct), then change
//  where it points anytime from the admin → no need to edit/relaunch the ad.
//  Reads the redirect map from your Apps Script, cached 60s to stay fast.
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

module.exports = async function handler(req, res) {
  const slug = String((req.query && req.query.s) || '').toLowerCase().trim();
  const fallback = process.env.REDIRECT_FALLBACK || '/';

  if (!slug) { res.statusCode = 302; res.setHeader('Location', fallback); return res.end(); }

  const map = await loadMap();
  let target = map[slug] || fallback;

  // forward utm/click params but strip internal routing params
  const extras = { ...(req.query || {}) };
  delete extras.s;
  delete extras.slug;
  const qs = new URLSearchParams(extras).toString();
  if (qs && target.indexOf('http') === 0) {
    target += (target.indexOf('?') < 0 ? '?' : '&') + qs;
  }

  res.statusCode = 302;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Location', target);
  res.end();
};
