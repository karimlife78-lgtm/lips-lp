// ============================================================================
//  Cosmarab Admin API  —  one serverless function, many actions
//  Routes by ?action=  ·  Auth via signed HttpOnly cookie (HMAC-SHA256)
// ----------------------------------------------------------------------------
//  Required env vars (set in Vercel → Project → Settings → Environment Variables):
//    ADMIN_USER        your login username        (e.g. cosmarab)
//    ADMIN_PASS        your login password         (pick something strong)
//    ADMIN_SECRET      random 32+ char string      (signs the session cookie)
//    GOOGLE_SCRIPT_URL your Apps Script web-app URL (same one submit-order uses)
//    SHEET_TOKEN       shared secret in the Apps Script (protects order reads)
// ============================================================================
const crypto = require('crypto');

const COOKIE = 'cosadmin';
const SESSION_HOURS = 12;

// ---- token helpers ---------------------------------------------------------
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return body + '.' + mac;
}

function verify(token, secret) {
  if (!token || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch (_) { return null; }
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); }
  catch (_) { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : '';
}

function requireAuth(req) {
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return null;
  return verify(readCookie(req, COOKIE), secret);
}

// constant-time string compare (avoids leaking length/timing on creds)
function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) { crypto.timingSafeEqual(ab, ab); return false; }
  return crypto.timingSafeEqual(ab, bb);
}

// ---- Apps Script bridge ----------------------------------------------------
async function scriptGet(params) {
  const base = process.env.GOOGLE_SCRIPT_URL;
  if (!base) throw new Error('no_sheet_url');
  const u = new URL(base);
  u.searchParams.set('token', process.env.SHEET_TOKEN || '');
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const r = await fetch(u.toString(), { redirect: 'follow' });
  return r.json();
}

async function scriptPost(body) {
  const base = process.env.GOOGLE_SCRIPT_URL;
  if (!base) throw new Error('no_sheet_url');
  const r = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: process.env.SHEET_TOKEN || '', ...body }),
    redirect: 'follow'
  });
  return r.json();
}

// ============================================================================
module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || '';

  try {
    // -------- LOGIN ---------------------------------------------------------
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
      const { user, pass } = req.body || {};
      const U = process.env.ADMIN_USER, P = process.env.ADMIN_PASS, S = process.env.ADMIN_SECRET;
      if (!U || !P || !S) return res.status(500).json({ error: 'not_configured' });
      if (!safeEqual(user || '', U) || !safeEqual(pass || '', P)) {
        return res.status(401).json({ error: 'bad_credentials' });
      }
      const token = sign({ u: U, exp: Date.now() + SESSION_HOURS * 3600e3 }, S);
      res.setHeader('Set-Cookie',
        `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`);
      return res.status(200).json({ ok: true, user: U });
    }

    // -------- LOGOUT --------------------------------------------------------
    if (action === 'logout') {
      res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
      return res.status(200).json({ ok: true });
    }

    // -------- SESSION CHECK -------------------------------------------------
    if (action === 'session') {
      const s = requireAuth(req);
      if (!s) return res.status(401).json({ ok: false });
      return res.status(200).json({ ok: true, user: s.u });
    }

    // ===== everything below requires a valid session ========================
    const sess = requireAuth(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });

    // -------- ORDERS (read sheet) ------------------------------------------
    if (action === 'orders') {
      try {
        const data = await scriptGet({ action: 'orders' });
        return res.status(200).json({ ok: true, ...data });
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message, rows: [] });
      }
    }

    // -------- REDIRECTS: list ----------------------------------------------
    if (action === 'redirects' && req.method === 'GET') {
      try {
        const data = await scriptGet({ action: 'redirects' });
        console.log('[redirects] reply=' + JSON.stringify(data).slice(0, 300));
        // don't mask a backend failure as an empty list — it looks like "no links yet"
        if (data && data.ok === false) {
          return res.status(200).json({ ok: false, error: data.error || 'sheet_error', redirects: [] });
        }
        return res.status(200).json({ ok: true, redirects: data.redirects || [] });
      } catch (e) {
        console.log('[redirects] threw ' + e.message);
        return res.status(200).json({ ok: false, error: e.message, redirects: [] });
      }
    }

    // -------- REDIRECTS: save (create/update) ------------------------------
    if (action === 'saveRedirect' && req.method === 'POST') {
      const { slug, target, note } = req.body || {};
      if (!slug || !target) return res.status(400).json({ error: 'missing_fields' });
      const clean = String(slug).toLowerCase().replace(/[^a-z0-9-_]/g, '');
      if (!clean) return res.status(400).json({ error: 'bad_slug' });
      const data = await scriptPost({ action: 'saveRedirect', slug: clean, target, note: note || '' });
      console.log('[saveRedirect] slug=' + clean + ' target=' + target + ' reply=' + JSON.stringify(data));
      return res.status(200).json({ ok: true, ...data });
    }

    // -------- REDIRECTS: delete --------------------------------------------
    if (action === 'deleteRedirect' && req.method === 'POST') {
      const { slug } = req.body || {};
      if (!slug) return res.status(400).json({ error: 'missing_slug' });
      // normalise exactly as saveRedirect does, otherwise the key never matches
      const clean = String(slug).toLowerCase().replace(/[^a-z0-9-_]/g, '');
      if (!clean) return res.status(400).json({ error: 'bad_slug' });
      const data = await scriptPost({ action: 'deleteRedirect', slug: clean });
      return res.status(200).json({ ok: true, ...data });
    }

    // -------- PAGES: auto-detect all HTML files in the project ---------------
    if (action === 'pages') {
      const fs = require('fs');
      const path = require('path');
      const root = path.resolve(__dirname, '..');
      const SKIP = new Set(['admin.html']);

      // page metadata: name, icon, description keyed by path
      const META = {
        '/':            { name: 'Homepage',              icon: '🏠', desc: 'Product menu & brand hub' },
        '/ksa-18':      { name: 'Lip Serum — KSA',      icon: '💄', desc: 'Main COD sales funnel (KSA)' },
        '/ksa-calm':    { name: 'Sukoon — Sleep Sachet', icon: '🌙', desc: 'Sleep & calm drink sachet' },
        '/ksa-20':      { name: 'Zebra T-Shirt',        icon: '🦓', desc: 'TikTok clean LP' },
        '/ksa-22':      { name: 'Lip Serum — TikTok',   icon: '💋', desc: 'Copy of ksa-18 for TikTok ads' },
        '/ksa-feet':    { name: 'Silky Feet',           icon: '🦶', desc: 'Foot peel socks LP' },
        '/ksa-glow':    { name: 'Collagen Glow',        icon: '✨', desc: 'Collagen sachet LP' },
        '/ksa-gut':     { name: 'Gut Glow',             icon: '🌿', desc: 'Probiotic sachet LP' },
        '/video-bot':   { name: 'Video Script Bot',     icon: '🎬', desc: 'AI script generator' },
        '/trends':      { name: 'Product Radar',        icon: '📡', desc: 'Trend discovery + GCC scoring + LP builder' },
        '/privacy':     { name: 'Privacy Policy',        icon: '🔒', desc: 'Required for ad approval' },
        '/terms':       { name: 'Terms & Conditions',    icon: '📄', desc: 'Required for ad approval' },
      };

      const pages = [];

      // root .html files
      const rootFiles = fs.readdirSync(root).filter(f => f.endsWith('.html') && !SKIP.has(f));
      rootFiles.forEach(f => {
        const slug = f === 'index.html' ? '/' : '/' + f.replace(/\.html$/, '');
        pages.push({ path: slug, ...(META[slug] || { name: slug, icon: '📄', desc: 'Published page' }) });
      });

      // sub-folder index.html files (e.g. ksa-18/index.html)
      const dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.') && !['api','assets','node_modules'].includes(d.name));
      dirs.forEach(d => {
        const idx = path.join(root, d.name, 'index.html');
        if (fs.existsSync(idx)) {
          const slug = '/' + d.name;
          if (!pages.find(p => p.path === slug)) {
            pages.push({ path: slug, ...(META[slug] || { name: d.name, icon: '📄', desc: 'Published page' }) });
          }
        }
      });

      // sort: root first, then alphabetical
      pages.sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.path.localeCompare(b.path)));
      return res.status(200).json({ ok: true, pages });
    }

    return res.status(404).json({ error: 'unknown_action' });

  } catch (err) {
    console.error('[admin]', action, err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
};
