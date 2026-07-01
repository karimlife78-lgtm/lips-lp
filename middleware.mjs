// Vercel Edge Middleware — runs before static files
// Checks smart-links redirect map; if slug matches, redirects to target.
// Non-matching requests pass through to normal routing (static files, alias, etc.)

let _cache = { at: 0, map: {} };
const TTL = 60_000;

export const config = {
  matcher: ['/((?!api/|r/|assets/|_next/).+)']
};

export default async function middleware(request) {
  const url = new URL(request.url);
  const slug = url.pathname.replace(/^\/+/, '').split('/')[0].toLowerCase();
  if (!slug) return;

  if (Date.now() - _cache.at > TTL) {
    try {
      const base = process.env.GOOGLE_SCRIPT_URL;
      const token = process.env.SHEET_TOKEN;
      const r = await fetch(`${base}?action=redirects&token=${encodeURIComponent(token)}`);
      const data = await r.json();
      const map = {};
      (data.redirects || []).forEach(rd => {
        if (rd.slug) map[rd.slug.toLowerCase()] = rd.target;
      });
      _cache = { at: Date.now(), map };
    } catch (_) {}
  }

  const target = _cache.map[slug];
  if (!target) return; // no match → serve normally (static file, alias, etc.)

  const dest = target.startsWith('http')
    ? target
    : new URL(target.startsWith('/') ? target : '/' + target, url.origin).toString();

  return Response.redirect(dest, 302);
}
