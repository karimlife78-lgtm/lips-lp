// GCC countries allowed — add 'AE','KW','BH','QA','OM' when expanding
const ALLOWED = new Set(['SA']); // KSA only — add 'AE','KW','BH','QA','OM' when expanding

// Map ISO codes to friendly labels written to the sheet
const COUNTRY_LABELS = { SA: 'KSA', AE: 'UAE', KW: 'Kuwait', BH: 'Bahrain', QA: 'Qatar', OM: 'Oman' };

// Legacy upsell SKU map (ksa-18 lip serum funnel) — kept for backward compatibility
const UPSELL_SKUS = {
  boost: 'TBD-BOOST',
  balm:  'TBD-BALM',
  extra: 'COSLIP'    // extra lip serum unit = same SKU
};

// Default product = ksa-18 lip serum, so existing campaign is untouched if no product sent
const DEFAULT_PRODUCT = { sku: 'COSLIP', name: 'Jinshan Lip Serum.1', page: 'ksa-18' };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    // 1. Geo-check via Vercel's built-in header (free, no rate-limit, no API call)
    //    Falls back to x-vercel-ip-country-region or allows through if header missing (dev/local)
    const country = (req.headers['x-vercel-ip-country'] || '').toUpperCase();

    // 2. Block outside allowed region — allow empty country (local dev / header absent)
    if (country && !ALLOWED.has(country)) {
      return res.status(403).json({ error: 'region_blocked', country });
    }

    const countryLabel = COUNTRY_LABELS[country] || country;

    // 3. Parse order body
    const { name, phone, city, qty, total, upsells, currency, src, product } = req.body;
    const curr = currency || 'SAR';
    const source = (src || 'direct').toString().toLowerCase();

    // Resolve product — defaults to lip serum so ksa-18 keeps working unchanged
    const prod = product && product.sku ? product : DEFAULT_PRODUCT;
    const page = (product && product.page) || DEFAULT_PRODUCT.page;
    const url  = src ? 'cosmarab.com/' + source : 'cosmarab.com/' + page;
    const iso  = new Date().toISOString();

    const rows = [];

    // Columns: OrderDate | country | name | phone | address | url | sku | Product | quantity | price | currency | notes
    rows.push([iso, countryLabel, name, phone, city, url, prod.sku, prod.name, qty, total, curr, '']);

    // Upsell rows — no price column, note links them to the main order.
    // Prefer an explicit sku/name from the page (cross-sell products), fall back to legacy map.
    if (Array.isArray(upsells)) {
      for (const up of upsells) {
        rows.push([
          iso, countryLabel, name, phone, city, url,
          up.sku || UPSELL_SKUS[up.key] || 'TBD',
          up.name, up.qty || 1, '', curr,
          'Upsell for ' + prod.sku
        ]);
      }
    }

    // 4. Forward rows to Google Sheet via Apps Script web app
    // ksa-calm → its own separate sheet (GOOGLE_SCRIPT_URL_CALM)
    // everything else → main sheet (GOOGLE_SCRIPT_URL)
    const scriptUrl = page === 'ksa-calm'
      ? (process.env.GOOGLE_SCRIPT_URL_CALM || process.env.GOOGLE_SCRIPT_URL)
      : process.env.GOOGLE_SCRIPT_URL;
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
