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
        return res.status(200).json({ ok: true, redirects: data.redirects || [] });
      } catch (e) {
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
      return res.status(200).json({ ok: true, ...data });
    }

    // -------- REDIRECTS: delete --------------------------------------------
    if (action === 'deleteRedirect' && req.method === 'POST') {
      const { slug } = req.body || {};
      if (!slug) return res.status(400).json({ error: 'missing_slug' });
      const data = await scriptPost({ action: 'deleteRedirect', slug });
      return res.status(200).json({ ok: true, ...data });
    }

    return res.status(404).json({ error: 'unknown_action' });

  } catch (err) {
    console.error('[admin]', action, err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
};
