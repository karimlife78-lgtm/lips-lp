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
async function gemini(prompt, { grounded = true, json = false } = {}) {
  const key = process.env.GEMINI_KEY;
  if (!key) throw new Error('no_gemini_key');

  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (grounded) body.tools = [{ google_search: {} }];
  // Grounding and responseMimeType:json are mutually exclusive on this model,
  // so when grounded we ask for JSON in the prompt and parse it out of prose.
  if (json && !grounded) body.generationConfig = { responseMimeType: 'application/json' };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );

  const data = await r.json();
  if (!r.ok) throw new Error('gemini_' + r.status + '_' + (data.error && data.error.message || ''));

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

// Pull the first JSON array/object out of a model response that may wrap it in
// markdown fences or commentary.
function extractJson(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start < 0) throw new Error('no_json_found');
  const open = t[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (ch === '\\') { esc = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)); }
  }
  throw new Error('unterminated_json');
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

  // 3. Score each product with our own deterministic GCC rules
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
      // Explicit so the UI never implies precision we don't have
      dataNote: grounded
        ? 'Products researched via Google Search grounding. GCC scores computed locally from your 2026 research rules.'
        : 'WARNING: model answered without search grounding — treat product list as unverified.',
      generatedAt: new Date().toISOString()
    }
  });
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
        hasKey: !!process.env.GEMINI_KEY
      });
    }

    const sess = requireAuth(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    if (action === 'discover') return await actionDiscover(req, res);
    if (action === 'analyze')  return await actionAnalyze(req, res);
    if (action === 'buildLp')  return await actionBuildLp(req, res);

    return res.status(404).json({ error: 'unknown_action' });

  } catch (err) {
    console.error('[trends]', action, err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
};
