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

    // 3. Parse order body
    const { name, phone, city, qty, total, upsells, currency, src, product, note } = req.body;
    const orderNote = (note || '').toString().slice(0, 120); // call-time preference etc.
    const curr = currency || 'SAR';
    const source = (src || 'direct').toString().toLowerCase();

    // Resolve product — defaults to lip serum so ksa-18 keeps working unchanged
    const prod = product && product.sku ? product : DEFAULT_PRODUCT;
    const page = (product && product.page) || DEFAULT_PRODUCT.page;

    // TEMP: geo-block lifted for these pages to allow testing from outside KSA.
    // REMOVE each exception once testing is confirmed — everything else stays KSA-only.
    const TEMP_BYPASS_PAGES = new Set(['ksa-gluco', 'ksa-ceylora']);

    // 2. Block outside allowed region — allow empty country (local dev / header absent)
    if (country && !ALLOWED.has(country) && !TEMP_BYPASS_PAGES.has(page)) {
      return res.status(403).json({ error: 'region_blocked', country });
    }

    const countryLabel = COUNTRY_LABELS[country] || country;
    const url  = src ? 'cosmarab.com/' + source : 'cosmarab.com/' + page;
    const iso  = new Date().toISOString();

    const rows = [];

    // Surface upsells on the main order row too (not just their own row below) so
    // they're visible at a glance without scrolling to the next line in the sheet.
    const upsellNote = Array.isArray(upsells) && upsells.length
      ? 'Upsell: ' + upsells.map(function(u) { return (u.name || u.sku) + ' x' + (u.qty || 1); }).join(', ')
      : '';

    // Columns: OrderDate | country | name | phone | address | url | sku | Product | quantity | price | currency | notes
    const mainNote = [orderNote, upsellNote].filter(Boolean).join(' | ');
    rows.push([iso, countryLabel, name, phone, city, url, prod.sku, prod.name, qty, total, curr, mainNote]);

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

    // 4. Forward rows to Google Sheet via Apps Script web app.
    // ksa-calm / ksa-glow / ksa-gluco share the calm spreadsheet (GOOGLE_SCRIPT_URL_CALM), each in its own tab.
    // everything else → main sheet (GOOGLE_SCRIPT_URL), default 'Orders' tab.
    const CALM_SHEET_PAGES = new Set(['ksa-calm', 'ksa-glow', 'ksa-gluco', 'ksa-ceylora']);
    const TAB_BY_PAGE = { 'ksa-glow': 'Glow', 'ksa-gluco': 'Gluco', 'ksa-ceylora': 'Ceylora' }; // ksa-calm omits tab -> apps script defaults to 'Orders'
    const scriptUrl = CALM_SHEET_PAGES.has(page)
      ? (process.env.GOOGLE_SCRIPT_URL_CALM || process.env.GOOGLE_SCRIPT_URL)
      : process.env.GOOGLE_SCRIPT_URL;
    const tab = TAB_BY_PAGE[page];
    if (scriptUrl) {
      await fetch(scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, tab }),
        redirect: 'follow'
      }).catch(function(err) { console.error('[sheet-error]', err.message); });
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('[submit-order]', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
