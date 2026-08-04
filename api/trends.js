// ============================================================================
//  Cosmarab Trends API  —  product discovery → GCC scoring → LP scaffold
//  Routes by ?action=  ·  Auth reuses the admin session cookie (see admin.js)
// ----------------------------------------------------------------------------
//  Required env vars:
//    ADMIN_SECRET   same secret admin.js signs sessions with (shared login)
//    GEMINI_KEY     Google AI Studio key — server-side only, never shipped to
//                   the browser. video-bot/index.html has one hardcoded in the
//                   client; that one is public and should be rotated.
// ----------------------------------------------------------------------------
//  Data honesty rule: every figure this file returns is either (a) fetched
//  live from Google Trends, or (b) produced by a Gemini call with Google
//  Search grounding attached, in which case the source URLs travel with it.
//  Nothing invents view counts or revenue. Ungrounded answers are labelled.
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'cosadmin';
const GEMINI_MODEL = 'gemini-2.5-flash';

// ---- auth (mirrors admin.js so one login covers both tools) ----------------
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

function requireAuth(req) {
  const secret = process.env.ADMIN_SECRET || '';
  if (!secret) return null;
  const raw = req.headers.cookie || '';
  const hit = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  const token = hit ? decodeURIComponent(hit.slice(COOKIE.length + 1)) : '';
  return verify(token, secret);
}

// ---- supported markets -----------------------------------------------------
// geo = Google Trends region code. Countries here are the ones the UI offers.
const MARKETS = {
  US: { name: 'United States', geo: 'US', lang: 'en' },
  CA: { name: 'Canada',        geo: 'CA', lang: 'en' },
  GB: { name: 'United Kingdom',geo: 'GB', lang: 'en' },
  FR: { name: 'France',        geo: 'FR', lang: 'fr' },
  ES: { name: 'Spain',         geo: 'ES', lang: 'es' },
  DE: { name: 'Germany',       geo: 'DE', lang: 'de' },
  AU: { name: 'Australia',     geo: 'AU', lang: 'en' },
  IT: { name: 'Italy',         geo: 'IT', lang: 'it' },
  SA: { name: 'Saudi Arabia',  geo: 'SA', lang: 'ar' },
  AE: { name: 'UAE',           geo: 'AE', lang: 'ar' },
  KW: { name: 'Kuwait',        geo: 'KW', lang: 'ar' },
  QA: { name: 'Qatar',         geo: 'QA', lang: 'ar' }
};

const NICHES = {
  beauty:   'beauty, skincare, cosmetics',
  wellness: 'health supplements, functional drinks, wellness',
  hair:     'hair care and hair growth',
  home:     'home and kitchen gadgets',
  fitness:  'fitness and body care',
  baby:     'baby and mother care',
  men:      'men grooming and performance',
  fashion:  'fashion accessories'
};

const PERIODS = {
  '7d':  { label: 'Last 7 days',   trendsWindow: 'now 7-d' },
  '30d': { label: 'Last 30 days',  trendsWindow: 'today 1-m' },
  '90d': { label: 'Last 90 days',  trendsWindow: 'today 3-m' },
  '12m': { label: 'Last 12 months',trendsWindow: 'today 12-m' }
};

// ============================================================================
//  GCC FIT SCORING  —  encodes the rules from GCC_WINNING_PRODUCTS_2026.md
//  This is deterministic and runs on our side, NOT invented by the model.
// ============================================================================

// Hard blockers — these lose money in GCC COD regardless of how well they trend
const GCC_BLOCKERS = [
  { re: /whiten|bleach|lighten|تبييض/i,        why: 'Body whitening — low confirmation, market burned' },
  { re: /bald|hair ?(loss|fall|regrow|growth)|regrow|minoxidil|صلع|تساقط ?الشعر/i,
                                               why: 'Hair growth/loss treatment — low delivery when oversold, dead in GCC' },
  { re: /weight ?loss|slim|fat ?burn|keto|diet pill/i, why: 'Weight-loss claims — Snap/TikTok ad disapproval' },
  { re: /cure|treat|heal|medical|disease|diabet/i,     why: 'Medical claims — banned by ad platforms' },
  { re: /alcohol|wine|beer|vodka|whisk/i,       why: 'Alcohol — illegal in KSA' },
  { re: /pork|bacon|ham\b|gelatin/i,            why: 'Non-halal ingredient — cultural blocker' },
  { re: /cbd|thc|cannabis|hemp|kratom/i,        why: 'Controlled substance — illegal in GCC' },
  { re: /vape|nicotine|e-?cig/i,                why: 'Vape/nicotine — ad platform ban + customs' },
  { re: /lingerie|sex ?toy|adult|vibrator/i,    why: 'Adult category — ad ban + customs seizure' }
];

// Saturation penalties — the "everyone already sells this" list
const GCC_SATURATED = [
  { re: /rosemary[\s\S]{0,20}oil|إكليل ?الجبل/i, why: 'Rosemary oil — 2.3B TikTok views, saturated in GCC too' },
  { re: /gua ?sha|face ?roller|jade/i,          why: 'Chinese beauty gadget — zero trust in GCC' },
  { re: /collagen (drink|powder|liquid)/i,      why: 'Collagen drinks already on Noon / Amazon.sa' },
  { re: /probiotic ?capsul|probiotic ?pill/i,   why: 'Probiotic capsules — commoditized by Almarai/Danone' },
  { re: /waist ?trainer|shapewear/i,            why: 'Shapewear — heavy returns, high refusal rate' },
  { re: /led ?mask/i,                           why: 'LED mask — high unit cost kills COD margin' }
];

// Positive signals drawn from the research doc's "why this wins" reasoning
const GCC_BOOSTERS = [
  { re: /sachet|powder|drink mix|stick pack/i,  pts: 18, why: 'Sachet format — the GCC-fresh format, feels like food not medicine' },
  { re: /saffron|زعفران|oud|عود|date|honey|عسل/i, pts: 12, why: 'Culturally trusted GCC ingredient — instant credibility' },
  { re: /sleep|calm|stress|انسوم|هدوء/i,        pts: 10, why: 'Universal daily problem, no ad-policy risk' },
  { re: /focus|energy|coffee|قهوة/i,            pts: 10, why: 'Fits Arabic coffee ritual — zero behavior change' },
  { re: /lip|شفاه/i,                            pts: 8,  why: 'Lip category already proven on your funnels' },
  { re: /foot|feet|peel|قدم/i,                  pts: 8,  why: 'Visible before/after — strong UGC material' },
  { re: /serum|oil|cream/i,                     pts: 4,  why: 'Familiar topical format, easy to demo on video' }
];

// Price bands that work for COD in SAR. Outside these, COD economics break.
function priceBandScore(usd) {
  if (usd == null || isNaN(usd)) return { pts: 0, why: null };
  const sar = usd * 3.75;
  if (sar < 60)  return { pts: -15, why: 'Too cheap (<60 SAR) — COD fees eat the margin' };
  if (sar < 120) return { pts: 4,   why: 'Low-mid price — works but needs volume' };
  if (sar <= 400) return { pts: 15, why: 'Ideal COD price band (120-400 SAR)' };
  if (sar <= 700) return { pts: -8, why: 'High ticket (400-700 SAR) — confirmation rate drops sharply on COD' };
  return { pts: -20, why: 'Too expensive for COD — cash refusal at the door' };
}

/**
 * Score a product for GCC COD viability. Returns 0-100 plus the reasoning.
 * Deterministic: same input always gives the same score, and every point
 * added or removed is attributed to a named rule.
 */
function scoreGccFit(product) {
  const hay = [product.name, product.description, product.category, product.why_trending]
    .filter(Boolean).join(' ');

  const reasons = [];
  let score = 50; // neutral baseline

  // Hard blockers short-circuit to a fail
  for (const b of GCC_BLOCKERS) {
    if (b.re.test(hay)) {
      return {
        score: 0,
        verdict: 'BLOCKED',
        blocked: true,
        reasons: [{ kind: 'blocker', text: b.why, pts: null }]
      };
    }
  }

  for (const s of GCC_SATURATED) {
    if (s.re.test(hay)) { score -= 22; reasons.push({ kind: 'negative', text: s.why, pts: -22 }); }
  }

  const seen = new Set();
  for (const b of GCC_BOOSTERS) {
    if (b.re.test(hay) && !seen.has(b.why)) {
      seen.add(b.why);
      score += b.pts;
      reasons.push({ kind: 'positive', text: b.why, pts: b.pts });
    }
  }

  const band = priceBandScore(product.est_price_usd);
  if (band.why) { score += band.pts; reasons.push({ kind: band.pts >= 0 ? 'positive' : 'negative', text: band.why, pts: band.pts }); }

  // Shipping weight / fragility hurt COD dropshipping
  if (/glass|fragile|liquid ?filled|ceramic/i.test(hay)) {
    score -= 10; reasons.push({ kind: 'negative', text: 'Fragile — breakage on GCC last-mile delivery', pts: -10 });
  }
  if (/electronic|battery|lithium|device|machine/i.test(hay)) {
    score -= 12; reasons.push({ kind: 'negative', text: 'Electronics — customs friction + warranty claims on COD', pts: -12 });
  }

  score = Math.max(0, Math.min(100, score));

  let verdict;
  if (score >= 72)      verdict = 'STRONG';
  else if (score >= 55) verdict = 'WORTH TESTING';
  else if (score >= 38) verdict = 'RISKY';
  else                  verdict = 'AVOID';

  // No rule fired at all — the product is simply outside what our rules know.
  // Say that plainly instead of dressing a default 50 up as a real assessment.
  if (!reasons.length) {
    return {
      score, verdict: 'NO SIGNAL', blocked: false, unscored: true,
      reasons: [{ kind: 'neutral',
        text: 'None of the GCC rules matched — judge this one yourself, the score is just the baseline.',
        pts: null }]
    };
  }

  return { score, verdict, blocked: false, reasons };
}

// ============================================================================
//  GOOGLE TRENDS  —  real, free, live. RSS feed of trending searches per geo.
// ============================================================================
function decodeXml(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&')   // last, so &amp;#39; does not double-decode
    .trim();
}

async function fetchGoogleTrends(geo) {
  const url = `https://trends.google.com/trending/rss?geo=${encodeURIComponent(geo)}`;
  const r = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CosmarabTrends/1.0)' }
  });
  if (!r.ok) throw new Error('trends_http_' + r.status);
  const xml = await r.text();

  const items = [];
  const blocks = xml.split('<item>').slice(1);
  for (const b of blocks) {
    const title = decodeXml((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1]);
    const traffic = decodeXml((b.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/) || [])[1]);
    const picture = decodeXml((b.match(/<ht:picture>([\s\S]*?)<\/ht:picture>/) || [])[1]);
    const newsTitle = decodeXml((b.match(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/) || [])[1]);
    const newsUrl = decodeXml((b.match(/<ht:news_item_url>([\s\S]*?)<\/ht:news_item_url>/) || [])[1]);
    if (title) items.push({ query: title, traffic: traffic || null, picture: picture || null, newsTitle, newsUrl });
  }
  return items;
}

// ============================================================================
//  GEMINI  —  grounded product research. Search grounding is mandatory here;
//  if the response comes back ungrounded we mark it so the UI can warn.
// ============================================================================
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The free Gemini tier allows ~20 requests/minute. A deep search fires 7+ calls,
 * so bursts do hit the limit — and a 429 mid-pipeline would silently drop a
 * whole scout. Google tells us how long to wait, so wait that long and retry.
 */
async function gemini(prompt, { grounded = true, json = false, retries = 2 } = {}) {
  const key = process.env.GEMINI_KEY;
  if (!key) throw new Error('no_gemini_key');

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192 }
  };
  if (grounded) body.tools = [{ google_search: {} }];
  // Grounding and responseMimeType:json are mutually exclusive on this model,
  // so when grounded we ask for JSON in the prompt and parse it out of prose.
  if (json && !grounded) body.generationConfig = { responseMimeType: 'application/json' };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  const data = await r.json();

  if (r.status === 429) {
    const details = (data.error || {}).details || [];
    const violations = details.flatMap(d => d.violations || []);
    // Two very different failures share the 429 status:
    //   PerDay  — the daily free-tier allowance is gone. Retrying cannot help;
    //             waiting 35s twice just burns a minute for the same error.
    //   PerMinute — a burst. Worth honouring the retryDelay.
    const daily = violations.some(v => /PerDay/i.test(v.quotaId || ''));
    const limit = (violations[0] || {}).quotaValue || null;
    if (daily) throw new Error('quota_daily_exhausted' + (limit ? '_' + limit : ''));

    if (retries > 0) {
      const info = details.find(d => (d['@type'] || '').includes('RetryInfo'));
      const parsed = info && /([\d.]+)s/.exec(info.retryDelay || '');
      const waitMs = Math.min(Math.max((parsed ? parseFloat(parsed[1]) : 15) * 1000, 3000), 20000);
      await sleep(waitMs);
      return gemini(prompt, { grounded, json, retries: retries - 1 });
    }
    throw new Error('rate_limited');
  }

  if (!r.ok) {
    const msg = (data.error && data.error.message) || '';
    throw new Error('gemini_' + r.status + '_' + msg.slice(0, 120));
  }

  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error('gemini_empty');

  const text = (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
  const gm = cand.groundingMetadata || null;
  const sources = gm && gm.groundingChunks
    ? gm.groundingChunks
        .map(c => c.web ? { title: c.web.title, url: c.web.uri } : null)
        .filter(Boolean)
    : [];

  return { text, sources, grounded: !!gm, queries: (gm && gm.webSearchQueries) || [] };
}

// Scan a string for every balanced JSON array/object and return them all.
function scanJson(t) {
  const found = [];
  for (let i = 0; i < t.length; i++) {
    const open = t[i];
    if (open !== '[' && open !== '{') continue;
    const close = open === '[' ? ']' : '}';
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < t.length; j++) {
      const ch = t[j];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          try { found.push(JSON.parse(t.slice(i, j + 1))); } catch (_) { /* not valid, skip */ }
          i = j;                       // don't rescan the inside of what we just took
          break;
        }
      }
    }
  }
  return found;
}

/**
 * Pull JSON out of a model response.
 *
 * Grounded responses routinely contain MORE THAN ONE json block — typically a
 * truncated first attempt followed by the real, complete answer. Taking the
 * first match silently returns a 1-item array where 12 were expected, so we
 * parse every candidate and keep the richest one.
 */
function extractJson(text) {
  const t = String(text || '').trim();
  const all = scanJson(t);
  if (!all.length) throw new Error('no_json_found');

  const arrays = all.filter(Array.isArray);
  if (arrays.length) {
    return arrays.reduce((best, a) => (a.length > best.length ? a : best), arrays[0]);
  }
  // No arrays — take the object with the most keys.
  return all.reduce((best, o) =>
    (Object.keys(o || {}).length > Object.keys(best || {}).length ? o : best), all[0]);
}

// ============================================================================
//  PRODUCT IMAGES
//  Gemini cannot see images, so it gives us a product page URL and we pull the
//  Open Graph image from that page ourselves. Many big retailers (Sephora,
//  Amazon) block datacenter IPs, so this is best-effort by design: a product
//  with no image renders a placeholder rather than a broken <img>.
// ============================================================================
const IMG_TIMEOUT = 6000;
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// Only allow real image URLs over https — never data:, never javascript:.
function safeImageUrl(raw, base) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw).trim(), base); } catch (_) { return null; }
  if (u.protocol !== 'https:') return null;           // http images break on our HTTPS page
  if (/\.(svg)(\?|$)/i.test(u.pathname)) return null; // svg logos are usually not the product
  return u.toString();
}

function extractOgImage(html, pageUrl) {
  // og:image / twitter:image, attribute order agnostic
  const patterns = [
    /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*property=["']og:image(?::secure_url)?["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*name=["']twitter:image["']/i
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m && m[1]) {
      const url = safeImageUrl(decodeXml(m[1]), pageUrl);
      if (url) return url;
    }
  }
  // JSON-LD Product.image as a fallback
  const ld = html.match(/"image"\s*:\s*"(https:\/\/[^"]+)"/i);
  if (ld && ld[1]) return safeImageUrl(ld[1].replace(/\\\//g, '/'), pageUrl);
  return null;
}

async function fetchProductImage(pageUrl) {
  if (!pageUrl) return null;
  let target;
  try { target = new URL(pageUrl); } catch (_) { return null; }
  if (target.protocol !== 'https:') return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMG_TIMEOUT);
  try {
    const r = await fetch(target.toString(), {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': BROWSER_UA, 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!r.ok) return null;
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html/i.test(ct)) return null;
    // Only need the <head>; cap the read so a huge page cannot stall the request.
    const html = (await r.text()).slice(0, 200000);
    return extractOgImage(html, r.url || target.toString());
  } catch (_) {
    return null;                       // blocked, timed out, or no OG tag — fine
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bing's thumbnail service renders an image for a plain search term. No key, no
 * HTML scraping, no bot-protection to fight — and because the browser loads the
 * URL directly, it adds nothing to this request's latency.
 * The trade-off is honest and worth stating in the UI: it is a *search result*
 * for the product name, not a verified photo of that exact SKU.
 */
function bingThumbUrl(query, size) {
  const s = size || 400;
  return 'https://tse2.mm.bing.net/th?q=' + encodeURIComponent(query)
    + '&w=' + s + '&h=' + s + '&c=7&rs=1&p=0&dpr=2&pid=1.7';
}

/**
 * Attach a thumbnail to every product immediately, then try to upgrade to a real
 * Open Graph photo from the product page. OG is the better image when we can get
 * it (it is the actual SKU), but most large retailers serve JS shells with no OG
 * tag, so it only lands maybe a third of the time — hence thumb-first.
 */
async function attachImages(products) {
  // 1. Guaranteed baseline for every product, costs no time.
  products.forEach(p => {
    p.image_url = bingThumbUrl(p.name);
    p.image_source = 'search';
  });

  // 2. Opportunistic upgrade, hard-capped so slow retailers cannot stall us.
  const budget = new Promise(resolve => setTimeout(resolve, 7000));
  await Promise.race([
    Promise.allSettled(products.map(async p => {
      const og = await fetchProductImage(p.product_url);
      if (og) { p.image_url = og; p.image_source = 'og'; }
    })),
    budget
  ]);

  return products;
}

// ============================================================================
//  ACTION: discover  —  trending products for a market + niche + period
// ============================================================================
async function actionDiscover(req, res) {
  const { market = 'US', niche = 'beauty', period = '30d' } = req.body || {};
  const m = MARKETS[market];
  const p = PERIODS[period];
  if (!m) return res.status(400).json({ error: 'bad_market' });
  if (!p) return res.status(400).json({ error: 'bad_period' });
  const nicheDesc = NICHES[niche] || niche;

  // 1. Live Google Trends for the market (real data, free)
  let trending = [];
  let trendsError = null;
  try {
    trending = await fetchGoogleTrends(m.geo);
  } catch (e) {
    trendsError = e.message;
  }

  // 2. Grounded product research
  const prompt = `You are a product research analyst for a cash-on-delivery dropshipping business.

TASK: Find real physical products currently trending in the "${nicheDesc}" category in ${m.name} over ${p.label.toLowerCase()}.

Use Google Search to check current sources such as TikTok Shop bestseller roundups, Amazon Movers & Shakers / Best Sellers, retail trend reports, and recent news. Only report products you actually found evidence for in search results.

RULES:
- Report between 5 and 8 products.
- Every product must be a specific physical product, not a broad category. "Peel-off lip stain" is good; "beauty products" is not.
- For any number you give (price, popularity), it must come from a source you found. If you did not find a number, use null. NEVER estimate a view count or revenue figure.
- "evidence" must quote or closely paraphrase what the source actually said.
- confidence: "high" if multiple sources agree, "medium" if one decent source, "low" if only indirect signal.

Return ONLY a JSON array, no commentary, in this exact shape:
[
  {
    "name": "specific product name",
    "category": "sub-category",
    "description": "one sentence on what it is and who buys it",
    "why_trending": "the actual reason demand is rising right now",
    "evidence": "what the source said, briefly",
    "est_price_usd": number or null,
    "product_url": "a real retailer or brand product page URL for THIS product that you actually found in search results, or null",
    "confidence": "high" | "medium" | "low"
  }
]`;

  let products = [];
  let sources = [];
  let grounded = false;
  let aiError = null;

  try {
    const out = await gemini(prompt, { grounded: true });
    grounded = out.grounded;
    sources = out.sources;
    const parsed = extractJson(out.text);
    products = Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    aiError = e.message;
  }

  // 3. Product photos: search thumbnail for all, upgraded to the real product
  //    page image where the retailer exposes one.
  let imagesVerified = 0;
  try {
    products = await attachImages(products);
    imagesVerified = products.filter(p => p.image_source === 'og').length;
  } catch (_) { /* images are a nicety — never fail the whole request */ }

  // 4. Score each product with our own deterministic GCC rules
  const scored = products.map(prod => ({
    ...prod,
    gcc: scoreGccFit(prod)
  })).sort((a, b) => b.gcc.score - a.gcc.score);

  return res.status(200).json({
    ok: true,
    market: m.name,
    marketCode: market,
    niche,
    period: p.label,
    products: scored,
    trending: trending.slice(0, 10),
    sources,
    meta: {
      grounded,
      trendsError,
      aiError,
      imagesVerified,
      imagesTotal: scored.length,
      // Explicit so the UI never implies precision we don't have
      dataNote: grounded
        ? 'Products researched via Google Search grounding. GCC scores computed locally from your 2026 research rules.'
        : 'WARNING: model answered without search grounding — treat product list as unverified.',
      generatedAt: new Date().toISOString()
    }
  });
}

// ============================================================================
//  DEEP SEARCH
//  One broad question gets you one shallow answer. Instead we send five
//  specialists at the market from different directions, then judge a product by
//  how many of them independently arrived at it. A product that TikTok, Meta's
//  ad library AND Amazon rank data all surface is a far stronger signal than
//  one that shows up once.
//
//  The scouts run as separate requests from the browser, staggered. That is not
//  cosmetic: five concurrent calls on one Gemini key get throttled (measured:
//  111s for five at once vs 6s for one), and it lets the UI show live progress.
// ============================================================================
const SCOUTS = {
  tiktok: {
    label: 'TikTok Shop',
    icon: '🎵',
    hint: 'viral products + sales rank',
    prompt: (n, m, p) => `Search TikTok Shop ${m} bestseller lists, TikTok Creative Center trend pages, and recent TikTok trend roundups for "${n}" products selling well over ${p}.
Focus on products with real sales traction on TikTok Shop, not just viral videos.`
  },
  meta: {
    label: 'Meta ads',
    icon: '📘',
    hint: 'ad longevity = profit proof',
    prompt: (n, m, p) => `Search the Facebook/Meta Ad Library, ad-spy reports, and dropshipping ad breakdowns for "${n}" products being advertised heavily on Facebook and Instagram in ${m} over ${p}.
CRITICAL: ad longevity is the strongest available proxy for profitability — an ad running for many months is running because it makes money. Where a source states how long a campaign has been running, report it in "evidence".`
  },
  retail: {
    label: 'Retail rank',
    icon: '📦',
    hint: 'Amazon movers & shakers',
    prompt: (n, m, p) => `Search Amazon ${m} Movers & Shakers, Best Sellers, and retail trend reports for "${n}" products climbing sales rank over ${p}.
Prefer products whose RANK IS MOVING UP fast over products merely sitting at a high rank.`
  },
  problem: {
    label: 'Problem mining',
    icon: '🔎',
    hint: 'unsolved complaints',
    prompt: (n, m, p) => `Search forums, Reddit threads, YouTube comments and 1-3 star product reviews for the most common UNSOLVED complaints and frustrations in the "${n}" category in ${m} during ${p}.
Report the PROBLEM as the "name" (e.g. "cracked heels that come back in a week"), not a brand. For each, note in "evidence" what people say existing products get wrong.
This finds demand before a product owns it.
For these findings set "est_price_usd" and "product_url" to null — a problem has no price or product page. Still return the same JSON shape.`
  },
  emerging: {
    label: 'Early signal',
    icon: '🌱',
    hint: 'before it saturates',
    prompt: (n, m, p) => `Search for "${n}" products in ${m} that are JUST STARTING to gain traction in ${p} — early growth, low competition, not yet mainstream.
Explicitly EXCLUDE anything already saturated or widely known. Prefer products with rising search interest but few sellers.`
  }
};

function scoutPrompt(type, nicheDesc, marketName, periodLabel) {
  const s = SCOUTS[type];
  return `You are a ${s.label} research specialist for a cash-on-delivery dropshipping business.

${s.prompt(nicheDesc, marketName, periodLabel.toLowerCase())}

RULES — these matter more than being helpful:
- Report 4 to 6 findings. Each must be specific, not a category.
- Use Google Search. Only report what you actually found evidence for.
- If you did not find a figure, use null. NEVER invent a view count, revenue or rank.
- "evidence" must reflect what the source really said.
- "trajectory": "rising" if evidence shows growth, "peaked" if it looks like it already crested, "unknown" if you cannot tell. Be honest — "unknown" is a valid answer.

Return ONLY a JSON array:
[
  {
    "name": "specific product (or, for problem mining, the problem)",
    "category": "sub-category",
    "description": "one sentence: what it is and who buys it",
    "why_trending": "the real reason demand is moving now",
    "evidence": "what the source said, briefly",
    "est_price_usd": number or null,
    "product_url": "a real product page URL you found, or null",
    "trajectory": "rising" | "peaked" | "unknown",
    "confidence": "high" | "medium" | "low"
  }
]`;
}

async function actionScout(req, res) {
  const { type, market = 'US', niche = 'beauty', period = '30d' } = req.body || {};
  const s = SCOUTS[type];
  if (!s) return res.status(400).json({ error: 'bad_scout' });
  const m = MARKETS[market] || MARKETS.US;
  const p = PERIODS[period] || PERIODS['30d'];
  const nicheDesc = NICHES[niche] || niche;

  let items = [], sources = [], grounded = false, aiError = null;
  try {
    const out = await gemini(scoutPrompt(type, nicheDesc, m.name, p.label), { grounded: true });
    grounded = out.grounded;
    sources = out.sources;
    const parsed = extractJson(out.text);
    items = (Array.isArray(parsed) ? parsed : []).map(x => ({ ...x, scout: type }));
  } catch (e) {
    aiError = e.message;
  }

  return res.status(200).json({
    ok: true, scout: type, label: s.label, icon: s.icon,
    items, sources, meta: { grounded, aiError }
  });
}

// ---- triangulation ---------------------------------------------------------
// Fuzzy-match product names across scouts. Independent corroboration is the
// whole point of running five of them, so the matching has to be forgiving
// enough to see that "Bio-Collagen Real Deep Mask" and "Biodance Collagen Mask"
// are the same product, without collapsing genuinely different ones.
const STOP = new Set(['the','a','an','and','for','with','of','in','on','to','by','plus',
  'new','best','set','pack','kit','original','premium','pro','max','oz','ml','g','count']);

function tokens(name) {
  return String(name || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && w.length > 2 && !STOP.has(w));
}

function similarity(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  ta.forEach(t => { if (tb.has(t)) inter++; });
  // Overlap coefficient, not Jaccard: a short name that is fully contained in a
  // longer one ("Mighty Patch" vs "Hero Cosmetics Mighty Patch Original") should
  // count as the same product.
  return inter / Math.min(ta.size, tb.size);
}

const MERGE_THRESHOLD = 0.6;

// ---- concept clustering ----------------------------------------------------
// Merging by name only ever catches the same SKU, and scouts rarely name the
// same SKU — so name-matching alone reports "no corroboration" even when four
// scouts all found collagen masks from four different brands. For someone
// sourcing their own product the concept IS the signal, so we cluster on
// product type + attribute and count how many independent scouts hit each one.
const TYPE_WORDS = ['mask','serum','stick','pad','pads','patch','patches','oil','cream','balm',
  'sunscreen','sunstick','tint','stain','gloss','lipstick','blush','powder','sachet','drink',
  'gummy','gummies','capsule','supplement','toner','cleanser','essence','moisturizer','spray',
  'mist','shampoo','conditioner','peel','socks','roller','wand','pen','gel','lotion','scrub',
  'wipes','strips','device','tool','brush','primer','concealer','foundation','mascara','liner'];

const ATTR_WORDS = ['collagen','retinol','peptide','niacinamide','hyaluronic','vitamin','spf',
  'pore','lip','brow','lash','hair','foot','feet','face','eye','neck','body','glow','bright',
  'acne','pimple','wrinkle','aging','anti-aging','hydrating','exfoliating','contour','sleep',
  'calm','energy','focus','gut','probiotic','saffron','caffeine','snail','mucin','ceramide'];

/**
 * The attribute (collagen, retinol, pore, brow) is the axis that actually
 * distinguishes a trend; the format (serum, cream) is near-universal inside a
 * niche. So the attribute is the cluster key when present, and a format-only
 * cluster is flagged weak — "three scouts found serums" is noise in skincare,
 * "three scouts found collagen products" is a signal.
 */
function conceptKey(name) {
  const t = tokens(name);
  const type = t.find(w => TYPE_WORDS.includes(w));
  const attr = t.find(w => ATTR_WORDS.includes(w));
  if (!type && !attr) return null;              // nothing recognisable — no cluster
  return { key: attr || type, weak: !attr, label: [attr, type].filter(Boolean).join(' ') };
}

/**
 * Group the merged shortlist into concepts and record, per product, how many
 * DISTINCT scouts landed on that concept. This is the number that actually
 * deserves to move a score.
 */
function clusterConcepts(merged) {
  const clusters = {};
  merged.forEach(p => {
    const ck = conceptKey(p.name) || conceptKey(p.category || '');
    p.concept = ck ? ck.label : null;
    p.conceptWeak = ck ? ck.weak : true;
    if (!ck) return;
    if (!clusters[ck.key]) clusters[ck.key] = { key: ck.key, weak: ck.weak, scouts: new Set(), products: [] };
    clusters[ck.key].weak = clusters[ck.key].weak && ck.weak;
    (p.scouts || []).forEach(s => clusters[ck.key].scouts.add(s));
    clusters[ck.key].products.push(p.name);
  });
  merged.forEach(p => {
    const ck = conceptKey(p.name) || conceptKey(p.category || '');
    const c = ck && clusters[ck.key];
    p.conceptScouts = c && !c.weak ? Array.from(c.scouts) : [];
    p.conceptSize = c ? c.products.length : 0;
  });
  return Object.values(clusters)
    .map(c => ({ key: c.key, weak: c.weak, scouts: Array.from(c.scouts),
                 count: c.products.length, products: c.products }))
    .filter(c => !c.weak && (c.scouts.length >= 2 || c.count >= 2))
    .sort((a, b) => (b.scouts.length - a.scouts.length) || (b.count - a.count));
}

function mergeCandidates(groups) {
  const merged = [];
  for (const [scoutType, items] of Object.entries(groups)) {
    for (const it of (items || [])) {
      if (!it || !it.name) continue;
      const hit = merged.find(m => similarity(m.name, it.name) >= MERGE_THRESHOLD);
      if (hit) {
        if (!hit.scouts.includes(scoutType)) hit.scouts.push(scoutType);
        hit.evidence_all.push({ scout: scoutType, evidence: it.evidence, url: it.product_url });
        // Keep the richest description and any price/url we did not have yet.
        if ((it.description || '').length > (hit.description || '').length) hit.description = it.description;
        if (!hit.est_price_usd && it.est_price_usd) hit.est_price_usd = it.est_price_usd;
        if (!hit.product_url && it.product_url) hit.product_url = it.product_url;
        if (it.trajectory && it.trajectory !== 'unknown' && hit.trajectory === 'unknown') hit.trajectory = it.trajectory;
      } else {
        merged.push({
          name: it.name,
          category: it.category,
          description: it.description,
          why_trending: it.why_trending,
          evidence: it.evidence,
          est_price_usd: it.est_price_usd,
          product_url: it.product_url,
          trajectory: it.trajectory || 'unknown',
          confidence: it.confidence,
          scouts: [scoutType],
          evidence_all: [{ scout: scoutType, evidence: it.evidence, url: it.product_url }]
        });
      }
    }
  }
  return merged;
}

// ============================================================================
//  ACTION: verify  —  adversarial pass. We ask the model to ATTACK the
//  shortlist, not confirm it. Asking "is this good?" invites agreement; asking
//  "prove this is already dead" surfaces the saturation and decline that would
//  otherwise cost real ad budget to discover.
// ============================================================================
async function actionVerify(req, res) {
  const { candidates, market = 'US' } = req.body || {};
  if (!Array.isArray(candidates) || !candidates.length) {
    return res.status(400).json({ error: 'no_candidates' });
  }
  const m = MARKETS[market] || MARKETS.US;

  // Verifying 12 at once took ~91s in testing and a batch of 6 hit 65s — both
  // past Vercel's function limit. The browser sends small batches instead.
  const batch = candidates.slice(0, 4);
  const list = batch
    .map((c, i) => `${i}. ${c.name}${c.category ? ' (' + c.category + ')' : ''}`).join('\n');

  const prompt = `You are a skeptical analyst. Your job is to find reasons NOT to sell these products. Assume each is a trap until the evidence says otherwise.

MARKET: ${m.name}
SHORTLIST:
${list}

For each item, use Google Search to establish:
1. TRAJECTORY — is interest genuinely still rising, or did it already peak? A trend that peaked 6 months ago is a money loser no matter how big it was. Check search interest, recent coverage dates, and whether commentary reads as "the next big thing" or "remember when".
2. SATURATION — how many sellers/brands already compete? Is it on Amazon, Noon, Temu, in supermarkets?
3. GCC AVAILABILITY — is it already easy to buy in Saudi Arabia or the wider Gulf? (search Noon, Amazon.sa, local retail)
4. RED FLAGS — anything that kills it for cash-on-delivery: fragile, heavy, electronic, needs sizing, high return rate, ad-policy risk, requires trust in a brand name.

Be blunt. If something is a bad idea, say so plainly.

Return ONLY a JSON array, one object per shortlist item, in the SAME ORDER:
[
  {
    "index": 0,
    "trajectory": "rising" | "plateau" | "declining" | "unknown",
    "trajectory_evidence": "what told you this, with timing",
    "saturation": "none" | "some" | "heavy",
    "gcc_available": true | false | null,
    "red_flags": ["short phrases"],
    "kill_reason": "the single strongest reason to skip this, or null if none",
    "keep_reason": "the single strongest reason to try it anyway"
  }
]`;

  let verdicts = [], sources = [], grounded = false, aiError = null;
  try {
    const out = await gemini(prompt, { grounded: true });
    grounded = out.grounded;
    sources = out.sources;
    const parsed = extractJson(out.text);
    // Tag each verdict with the product NAME it belongs to. Index alone is
    // unsafe: merge re-sorts by score, so positions shift once verdicts land.
    verdicts = (Array.isArray(parsed) ? parsed : []).map((v, i) => {
      const idx = typeof v.index === 'number' ? v.index : i;
      const src = batch[idx] || batch[i];
      return { ...v, name: src ? src.name : null };
    }).filter(v => v.name);
  } catch (e) {
    aiError = e.message;
  }

  return res.status(200).json({
    ok: true, verdicts, sources, meta: { grounded, aiError }
  });
}

// ============================================================================
//  ACTION: merge  —  fold the scout results into one ranked shortlist.
//  Split out from the scouts so the browser can run them progressively and
//  still get server-side dedup, scoring and images in one place.
// ============================================================================
async function actionMerge(req, res) {
  const { groups, verdicts, market = 'US' } = req.body || {};
  if (!groups || typeof groups !== 'object') return res.status(400).json({ error: 'no_groups' });

  let merged = mergeCandidates(groups);

  // Attach red-team verdicts by product name — order-independent, so re-running
  // merge after scores change cannot scramble them.
  if (Array.isArray(verdicts)) {
    verdicts.forEach(v => {
      if (!v || !v.name) return;
      const hit = merged.find(m => m.name === v.name)
        || merged.find(m => similarity(m.name, v.name) >= 0.8);
      if (hit) hit.verdict = v;
    });
  }

  // Cluster before scoring — concept corroboration feeds the composite score.
  const concepts = clusterConcepts(merged);

  merged.forEach(p => { p.gcc = compositeScore(p); });
  merged.sort((a, b) => b.gcc.score - a.gcc.score);

  let imagesVerified = 0;
  try {
    merged = await attachImages(merged);
    imagesVerified = merged.filter(p => p.image_source === 'og').length;
  } catch (_) { /* never fail the request over images */ }

  const scoutsUsed = Object.keys(groups).filter(k => (groups[k] || []).length);
  const rawCount = scoutsUsed.reduce((n, k) => n + groups[k].length, 0);

  return res.status(200).json({
    ok: true,
    products: merged,
    concepts: concepts.slice(0, 8),
    marketCode: market,
    market: (MARKETS[market] || MARKETS.US).name,
    meta: {
      scoutsUsed,
      rawCount,
      mergedCount: merged.length,
      corroborated: merged.filter(p => (p.scouts || []).length >= 2
        || (p.conceptScouts || []).length >= 2).length,
      verified: Array.isArray(verdicts) && verdicts.length > 0,
      imagesVerified,
      imagesTotal: merged.length,
      generatedAt: new Date().toISOString()
    }
  });
}

// ---- composite scoring -----------------------------------------------------
// GCC fit answers "does this suit our market". It does not answer "is this
// still alive" or "did anyone else see it". Those are separate axes, so they
// get separate, visible adjustments rather than being blended invisibly.
const TRAJECTORY_PTS = { rising: 14, plateau: 0, unknown: 0, peaked: -16, declining: -24 };
const SATURATION_PTS = { none: 10, some: 0, heavy: -18 };

function compositeScore(product) {
  const gcc = scoreGccFit(product);
  if (gcc.blocked) return { ...gcc, composite: 0 };

  const extra = [];
  let score = gcc.score;

  // Corroboration. Exact-SKU agreement is rare and strong; concept agreement is
  // commoner and is what actually matters when you are sourcing your own version.
  const n = (product.scouts || []).length;
  if (n >= 2) {
    const pts = n >= 3 ? 16 : 10;
    score += pts;
    extra.push({ kind: 'positive', pts, text: `Same product found by ${n} independent scouts` });
  }

  const cn = (product.conceptScouts || []).length;
  if (cn >= 3) { score += 12; extra.push({ kind: 'positive', pts: 12, text: `"${product.concept}" surfaced by ${cn} scouts — the category is moving, not just one SKU` }); }
  else if (cn === 2) { score += 6; extra.push({ kind: 'positive', pts: 6, text: `"${product.concept}" surfaced by 2 scouts` }); }
  else if (n === 1 && cn <= 1) { extra.push({ kind: 'neutral', pts: null, text: 'Single source, no category echo — a lead, not a finding' }); }

  const v = product.verdict || {};
  const traj = v.trajectory || product.trajectory || 'unknown';
  if (TRAJECTORY_PTS[traj]) {
    const pts = TRAJECTORY_PTS[traj];
    score += pts;
    extra.push({ kind: pts > 0 ? 'positive' : 'negative', pts,
      text: 'Trend is ' + traj + (v.trajectory_evidence ? ' — ' + v.trajectory_evidence : '') });
  }

  if (v.saturation && SATURATION_PTS[v.saturation] !== undefined && SATURATION_PTS[v.saturation] !== 0) {
    const pts = SATURATION_PTS[v.saturation];
    score += pts;
    extra.push({ kind: pts > 0 ? 'positive' : 'negative', pts, text: v.saturation + ' competition in market' });
  }

  if (v.gcc_available === true) {
    score -= 14;
    extra.push({ kind: 'negative', pts: -14, text: 'Already buyable in KSA/GCC — no novelty left' });
  }

  (v.red_flags || []).slice(0, 3).forEach(f => {
    score -= 5;
    extra.push({ kind: 'negative', pts: -5, text: 'Red flag: ' + f });
  });

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict;
  if (score >= 72)      verdict = 'STRONG';
  else if (score >= 55) verdict = 'WORTH TESTING';
  else if (score >= 38) verdict = 'RISKY';
  else                  verdict = 'AVOID';

  return {
    score, verdict, blocked: false,
    unscored: false,
    reasons: gcc.reasons.filter(r => r.kind !== 'neutral').concat(extra)
  };
}

// ============================================================================
//  ACTION: analyze  —  deep dive on one product + Arabic brand names
// ============================================================================
async function actionAnalyze(req, res) {
  const { product, market = 'US' } = req.body || {};
  if (!product || !product.name) return res.status(400).json({ error: 'missing_product' });
  const m = MARKETS[market] || MARKETS.US;

  const gcc = scoreGccFit(product);

  const prompt = `You are advising a Saudi-based COD dropshipping brand (Cosmarab) that sells via Snapchat and TikTok ads to KSA and the wider GCC.

PRODUCT UNDER CONSIDERATION: ${product.name}
What it is: ${product.description || 'n/a'}
Why it trends in ${m.name}: ${product.why_trending || 'n/a'}

BRAND CONTEXT — the strategy that has worked for this brand:
- Take a problem that is oversold in Western/Chinese markets, but deliver it in a format that feels NEW in the GCC.
- Drink sachets outperform capsules: they feel like food, not medicine, and fit Arabic coffee ritual.
- Culturally trusted ingredients (saffron, dates, honey, oud) add instant credibility.
- Price band that works on COD: 120-400 SAR.
- Avoid: whitening, balding, weight-loss claims, medical claims — these kill ad approval and delivery rate.

Use Google Search to check whether this product is already widely sold in KSA/GCC (search Noon, Amazon.sa, local retail). Saturation there is a serious negative.

Return ONLY JSON in this shape:
{
  "gcc_saturation": "none" | "some" | "heavy",
  "saturation_evidence": "what you actually found searching Noon/Amazon.sa/GCC retail",
  "reformat_idea": "how to change the FORMAT so it feels fresh in GCC — the core play",
  "target_customer": "who buys this in KSA, specifically",
  "main_objection": "the #1 reason a Saudi buyer would refuse at the door",
  "objection_answer": "how the landing page should defeat that objection",
  "ad_policy_risk": "low" | "medium" | "high",
  "ad_policy_note": "what could get the ad rejected on Snap/TikTok",
  "suggested_price_sar": number,
  "cost_estimate_usd": number or null,
  "names": [
    { "ar": "Arabic brand name", "translit": "latin transliteration", "en": "english meaning", "why": "why it lands with a Saudi buyer" }
  ],
  "angles": ["3 ad angles that would work in KSA"],
  "verdict": "one blunt sentence: should they run this or not, and why"
}

Give exactly 4 names. Arabic names must be real, natural Arabic that a Saudi reads as premium — not translated English.`;

  let analysis = null, sources = [], grounded = false, aiError = null;
  try {
    const out = await gemini(prompt, { grounded: true });
    grounded = out.grounded;
    sources = out.sources;
    analysis = extractJson(out.text);
  } catch (e) {
    aiError = e.message;
  }

  return res.status(200).json({
    ok: true,
    product: product.name,
    gcc,
    analysis,
    sources,
    meta: { grounded, aiError, generatedAt: new Date().toISOString() }
  });
}

// ============================================================================
//  ACTION: buildLp  —  clone the proven ksa-22 funnel into a new draft folder
//  Draft only: writes to /drafts/<slug>/ which is gitignored-by-convention and
//  NOT linked anywhere. Nothing goes live until you move it and push.
// ============================================================================
const TEMPLATE_PAGE = 'ksa-22';

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

async function actionBuildLp(req, res) {
  const { slug, productName, arabicName, priceSar, sku, headline, subheadline, benefits, market } = req.body || {};

  const clean = slugify(slug);
  if (!clean) return res.status(400).json({ error: 'bad_slug' });

  const root = path.resolve(__dirname, '..');
  const templatePath = path.join(root, TEMPLATE_PAGE, 'index.html');
  if (!fs.existsSync(templatePath)) {
    return res.status(500).json({ error: 'template_missing', detail: TEMPLATE_PAGE });
  }

  // Vercel's filesystem is read-only at runtime, so on production we return the
  // generated HTML for download instead of writing it. Locally we write a draft.
  const isServerless = !!process.env.VERCEL;

  let html = fs.readFileSync(templatePath, 'utf8');

  const price = Number(priceSar) || 199;
  const was = Math.round(price * 1.6);
  const p2 = Math.round(price * 1.5), p2was = price * 2;
  const p3 = Math.round(price * 2),   p3was = price * 3;

  const arName = (arabicName || productName || 'منتج جديد').toString();
  const skuCode = (sku || ('COS-' + clean.toUpperCase().replace(/-/g, '').slice(0, 8))).toString();

  // --- swap the template's product identity -------------------------------
  html = html.replace(
    /<title>[\s\S]*?<\/title>/,
    `<title>${arName} | Cosmarab</title>`
  );

  // Offer tiers. Done in ONE pass per pattern: chained global replaces are unsafe
  // here because a value we write (e.g. 299) can be re-matched by the next rule
  // when the new price collides with a template price.
  const TIER_PRICE = { 199: price, 299: p2, 398: p3 };   // template tier → new tier
  const TIER_WAS   = { 299: was, 598: p2was, 897: p3was }; // template was → new was

  html = html.replace(/data-price="(199|299|398)"/g,
    (m, old) => `data-price="${TIER_PRICE[old]}"`);

  html = html.replace(
    /(<div class="offer-price"><span class="now">)(199|299|398)(<\/span><span class="cur">ر\.س<\/span><span class="was">)(299|598|897)( ر\.س<\/span>)/g,
    (m, a, now, b, wasOld, c) => a + TIER_PRICE[now] + b + TIER_WAS[wasOld] + c
  );

  // Order payload → new SKU, name and page slug so the sheet routes correctly
  html = html.replace(
    /product:\{sku:'COSLIP',name:'Jinshan Lip Serum',page:'ksa-22'\}/,
    `product:{sku:'${skuCode}',name:${JSON.stringify(productName || arName)},page:'${clean}'}`
  );
  html = html.replace(/content_id:'lip-serum'/g, `content_id:'${clean}'`);

  // Drop the lip-serum upsell — it will not match a new product
  html = html.replace(
    /var UPSELLS=\{[\s\S]*?\};/,
    'var UPSELLS={};'
  );

  const notes = [
    'Cloned from ' + TEMPLATE_PAGE + ' — pricing, SKU, title and tracking IDs swapped.',
    'STILL TO DO BY HAND: hero image, product photos, all Arabic body copy, review section, upsell block, and the Snap pixel content_id if you want a separate one.',
    'The upsell block was emptied — the old lip-serum upsell would not match this product.'
  ];

  if (isServerless) {
    return res.status(200).json({
      ok: true,
      mode: 'download',
      slug: clean,
      filename: clean + '/index.html',
      html,
      notes: notes.concat('Running on Vercel (read-only filesystem) — file returned for download rather than written.')
    });
  }

  const draftDir = path.join(root, 'drafts', clean);
  const draftFile = path.join(draftDir, 'index.html');
  if (fs.existsSync(draftFile) && !req.body.overwrite) {
    return res.status(409).json({ error: 'draft_exists', slug: clean, path: `drafts/${clean}/index.html` });
  }
  fs.mkdirSync(draftDir, { recursive: true });
  fs.writeFileSync(draftFile, html, 'utf8');

  return res.status(200).json({
    ok: true,
    mode: 'written',
    slug: clean,
    path: `drafts/${clean}/index.html`,
    notes: notes.concat('Draft written. Review it, then move the folder to the project root and push to publish.')
  });
}

// ============================================================================
module.exports = async function handler(req, res) {
  const action = (req.query && req.query.action) || '';

  try {
    if (action === 'config') {
      // Public-ish: still behind auth, used to populate the UI dropdowns
      if (!requireAuth(req)) return res.status(401).json({ error: 'unauthorized' });
      return res.status(200).json({
        ok: true,
        markets: Object.entries(MARKETS).map(([code, m]) => ({ code, name: m.name })),
        niches: Object.entries(NICHES).map(([code, label]) => ({ code, label })),
        periods: Object.entries(PERIODS).map(([code, p]) => ({ code, label: p.label })),
        scouts: Object.entries(SCOUTS).map(([code, s]) => ({ code, label: s.label, icon: s.icon, hint: s.hint })),
        hasKey: !!process.env.GEMINI_KEY
      });
    }

    const sess = requireAuth(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    if (action === 'discover') return await actionDiscover(req, res);
    if (action === 'scout')    return await actionScout(req, res);
    if (action === 'merge')    return await actionMerge(req, res);
    if (action === 'verify')   return await actionVerify(req, res);
    if (action === 'analyze')  return await actionAnalyze(req, res);
    if (action === 'buildLp')  return await actionBuildLp(req, res);

    return res.status(404).json({ error: 'unknown_action' });

  } catch (err) {
    console.error('[trends]', action, err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
};
