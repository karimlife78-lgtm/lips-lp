// GCC countries allowed — add 'AE','KW','BH','QA','OM' when expanding
const ALLOWED = new Set(['SA']);

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
    const { name, phone, city, qty, total, upsells, currency } = req.body;
    const curr = currency || 'SAR';
    const url  = 'cosmarab.com'; // TODO: update to cosmarab.com/ksa18 later
    const now  = new Date().toLocaleString('ar-SA', { timeZone: 'Asia/Riyadh' });

    const rows = [];

    // Main product row — price = grand total (incl. upsells)
    rows.push([now, name, phone, city, url, 'COSLIP', 'Jinshan Lip Serum.1', qty, total, curr, '']);

    // Upsell rows — no price, note links them to the main order
    if (Array.isArray(upsells)) {
      for (const up of upsells) {
        rows.push([
          now, name, phone, city, url,
          UPSELL_SKUS[up.key] || 'TBD',
          up.name, 1, '', curr,
          'Upsell for COSLIP'
        ]);
      }
    }

    // 4. Forward rows to Google Sheet via Apps Script web app
    const scriptUrl = process.env.GOOGLE_SCRIPT_URL;
    if (scriptUrl) {
      const r = await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows })
      });
      if (!r.ok) console.error('[sheet-error]', await r.text());
    } else {
      // Log to Vercel function logs until sheet is connected
      console.log('[submit-order] LEAD:', JSON.stringify(rows));
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[submit-order]', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
