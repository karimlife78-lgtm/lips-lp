// GCC countries allowed — add 'AE','KW','BH','QA','OM' when expanding
const ALLOWED = new Set(['SA']); // KSA only — add 'AE','KW','BH','QA','OM' when expanding

// Upsell SKU map — update keys when real SKUs are provided
const UPSELL_SKUS = {
  boost: 'TBD-BOOST',
  balm:  'TBD-BALM',
  extra: 'COSLIP'    // extra lip serum unit = same SKU
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // 1. Get client IP (Vercel always sets x-forwarded-for)
    const ip = (req.headers['x-forwarded-for'] || '')
      .split(',')[0].trim() || req.socket?.remoteAddress || '';

    // 2. Geo-check — block outside GCC
    let country = '';
    try {
      const geo = await fetch(`https://ipapi.co/${ip}/json/`, {
        headers: { 'User-Agent': 'cosmarab-lp/1.0' }
      }).then(r => r.json());
      country = geo.country_code || '';
    } catch (_) {
      return res.status(403).json({ error: 'geo_unavailable' });
    }

    if (!ALLOWED.has(country)) {
      return res.status(403).json({ error: 'region_blocked', country });
    }

    // 3. Parse order body
    const { name, phone, city, qty, total, upsells, currency, src } = req.body;
    const curr = currency || 'SAR';
    const source = (src || 'direct').toString().toLowerCase();
    const url  = src ? 'cosmarab.com/' + source : 'cosmarab.com/ksa-18';
    const iso  = new Date().toISOString();
    const now  = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

    const rows = [];

    // Columns (must match apps-script.gs HEADERS + admin.html COLS):
    // timestamp | time_ksa | name | phone | city | page | sku | product | qty | total | currency | note | source

    // Main product row — price = grand total (incl. upsells)
    rows.push([iso, now, name, phone, city, url, 'COSLIP', 'Jinshan Lip Serum.1', qty, total, curr, '', source]);

    // Upsell rows — no price, note links them to the main order
    if (Array.isArray(upsells)) {
      for (const up of upsells) {
        rows.push([
          iso, now, name, phone, city, url,
          UPSELL_SKUS[up.key] || 'TBD',
          up.name, 1, '', curr,
          'Upsell for COSLIP', source
        ]);
      }
    }

    // 4. Forward rows to Google Sheet via Apps Script web app
    const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
    if (scriptUrl) {
      await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
        redirect: 'follow'
      }).catch(function(err) { console.error('[sheet-error]', err.message); });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[submit-order]', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
