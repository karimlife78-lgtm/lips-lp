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
//  FREE BY DESIGN. Google Search grounding is deliberately not used: it burns a
//  tiny free-tier allowance (gemini-2.5-flash is 20 requests a DAY) and was the
//  thing that kept failing. Instead every fact comes from a keyless public
//  endpoint — Google Autocomplete, Google Trends RSS, Amazon Best Sellers — and
//  is passed INTO the prompt. The model interprets real data; it never sources
//  it. That is both cheaper and more honest: each claim traces to something a
//  human can go and look at. Nothing here invents view counts or revenue.
// ============================================================================
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'cosadmin';

// Free-tier quotas are per-model and small (gemini-2.5-flash is 20 requests a
// DAY). So we never depend on one model: if a model is exhausted we fall to the
// next. Ordered best-quality first.
const MODEL_CHAIN = [
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemma-4-31b-it'
];

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

// Seeds matter more than anything else here. Mining the bare niche word gives
// junk — "beauty" returns "makeup not working bg3" (the video game). Concrete
// product-level seeds are what surface real buying and problem language.
const NICHES = {
  beauty:   { label: 'beauty, skincare, cosmetics',
              seeds: ['face serum', 'lip', 'acne', 'dark spots', 'dry skin'] },
  wellness: { label: 'health supplements, functional drinks, wellness',
              seeds: ['supplement', 'sleep aid', 'energy drink', 'gut health', 'bloating'] },
  hair:     { label: 'hair care',
              seeds: ['hair mask', 'dry hair', 'frizzy hair', 'dandruff', 'hair oil'] },
  home:     { label: 'home and kitchen gadgets',
              seeds: ['kitchen gadget', 'cleaning tool', 'organizer', 'storage'] },
  fitness:  { label: 'fitness and body care',
              seeds: ['body care', 'muscle recovery', 'posture', 'cellulite'] },
  baby:     { label: 'baby and mother care',
              seeds: ['baby skin', 'diaper rash', 'baby sleep', 'nursing'] },
  men:      { label: 'men grooming and performance',
              seeds: ['beard', 'men skincare', 'shaving', 'men energy'] },
  fashion:  { label: 'fashion accessories',
              seeds: ['accessories', 'jewelry', 'bag', 'watch'] }
};

// Autocomplete picks up whatever shares a word with the seed, including games,
// films and celebrities. Drop the obvious off-topic noise.
const NOISE = /\b(bg3|baldur|game|gaming|ps5|xbox|minecraft|roblox|fortnite|movie|film|anime|lyrics|song|meaning|定义|wiki|reddit|salary|jobs?|near me|stock|nfl|nba)\b/i;

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
async function callModel(model, prompt, key) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192 }
  };

  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  const data = await r.json();

  if (r.status === 429 || r.status === 404) {
    const e = new Error(r.status === 404 ? 'model_missing' : 'model_exhausted');
    e.tryNext = true;
    throw e;
  }
  if (!r.ok) throw new Error('gemini_' + r.status + '_' + ((data.error || {}).message || '').slice(0, 120));

  const cand = (data.candidates || [])[0];
  if (!cand) throw new Error('gemini_empty');
  return (cand.content && cand.content.parts || []).map(p => p.text || '').join('');
}

/**
 * Ungrounded only, by design.
 *
 * Grounded (google_search) calls burn a separate, tiny free-tier allowance and
 * were the thing that kept failing. Everything factual now comes from the free
 * data sources below and is passed INTO the prompt, so the model reasons over
 * real data instead of recalling it. That is cheaper and more trustworthy.
 *
 * Falls through MODEL_CHAIN so one exhausted model never breaks the app.
 */
async function gemini(prompt) {
  const key = process.env.GEMINI_KEY;
  if (!key) throw new Error('no_gemini_key');

  let lastErr = null;
  for (const model of MODEL_CHAIN) {
    try {
      const text = await callModel(model, prompt, key);
      return { text, model };
    } catch (e) {
      lastErr = e;
      if (e.tryNext) continue;      // exhausted or missing — try the next model
      throw e;                       // a real error; do not mask it
    }
  }
  throw new Error('all_models_exhausted');
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
  const nicheDef = NICHES[niche] || { label: niche, seeds: [niche] };
  const nicheDesc = nicheDef.label;

  // 1. Live Google Trends for the market (real data, free)
  let trending = [];
  let trendsError = null;
  try {
    trending = await fetchGoogleTrends(m.geo);
  } catch (e) {
    trendsError = e.message;
  }

  // 2. Real demand + real bestsellers, straight from free public endpoints.
  const deep = !!(req.body && req.body.deep);
  const seeds = deep ? nicheDef.seeds : nicheDef.seeds.slice(0, 3);
  const [demand, bestsellers] = await Promise.all([
    mineDemand(seeds, m.geo.toLowerCase(), m.lang, { deep }),
    amazonBestsellers(niche, market)
  ]);

  const problems = demand.filter(d => d.intent === 'problem').slice(0, deep ? 25 : 15);
  const wants    = demand.filter(d => d.intent === 'demand' || d.intent === 'buy').slice(0, deep ? 25 : 15);
  const rivals   = demand.filter(d => d.intent === 'rival').slice(0, 10);

  // 3. One ungrounded call. The model gets REAL data and only has to interpret
  //    it — no browsing, no recall, so no grounding quota is touched.
  const prompt = `You are a product analyst for a cash-on-delivery dropshipping business selling to Saudi Arabia and the Gulf.

Below is REAL data collected just now from public sources for the "${nicheDesc}" category in ${m.name}.

=== WHAT PEOPLE SEARCH FOR (Google Autocomplete — these are real queries) ===
${wants.map(d => `- ${d.phrase}${d.hits > 1 ? ' [appears in ' + d.hits + ' probes]' : ''}`).join('\n') || '(none found)'}

=== PROBLEMS PEOPLE HAVE (real "why/how to fix" searches) ===
${problems.map(d => `- ${d.phrase}`).join('\n') || '(none found)'}

${rivals.length ? '=== COMPARISON / DUPE SEARCHES ===\n' + rivals.map(d => '- ' + d.phrase).join('\n') : ''}

${bestsellers.length ? '=== CURRENT AMAZON BEST SELLERS (' + (AMAZON_HOST[market] || AMAZON_HOST.US) + ') ===\n' + bestsellers.map(b => '- ' + b).join('\n') : ''}

${trending.length ? '=== TRENDING SEARCHES IN ' + m.name.toUpperCase() + ' TODAY ===\n' + trending.slice(0, 10).map(t => '- ' + t.query + (t.traffic ? ' (' + t.traffic + ')' : '')).join('\n') : ''}

TASK: From THIS DATA ONLY, identify 6-8 concrete product opportunities.

RULES — follow these exactly:
- Ground every opportunity in the data above. In "evidence", quote the actual search phrase or bestseller line that supports it.
- Prefer opportunities backed by a PROBLEM search — an unsolved complaint is demand nobody owns yet.
- A specific product, never a category. "Peel-off lip stain" yes; "beauty products" no.
- Do NOT invent view counts, revenue or rankings. You have no such data. Use null for anything you cannot support.
- est_price_usd: only if a typical price is genuinely well known to you; otherwise null.
- confidence: "high" only when several phrases in the data point the same way.

Return ONLY a JSON array:
[
  {
    "name": "specific product",
    "category": "sub-category",
    "description": "one sentence: what it is and who buys it",
    "why_trending": "what in the data above says demand exists",
    "evidence": "the exact search phrase or bestseller entry that supports this",
    "signal": "problem" | "demand" | "bestseller" | "trend",
    "est_price_usd": number or null,
    "confidence": "high" | "medium" | "low"
  }
]`;

  let products = [];
  let aiError = null;
  let usedModel = null;

  try {
    const out = await gemini(prompt);
    usedModel = out.model;
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

  // 4. Real saturation for every product. Autocomplete is free and ~0.4s, so
  //    there is no reason to make this a separate opt-in step.
  await Promise.all(products.map(async prod => {
    try { prod.sat = await saturationOf(prod.name, m); } catch (_) { prod.sat = null; }
  }));

  // 5. Score with our deterministic GCC rules, adjusted by that real data
  const scored = products.map(prod => ({
    ...prod,
    gcc: scoreWithSaturation(prod)
  })).sort((a, b) => b.gcc.score - a.gcc.score);

  return res.status(200).json({
    ok: true,
    market: m.name,
    marketCode: market,
    niche,
    period: p.label,
    products: scored,
    trending: trending.slice(0, 10),
    demand: {
      problems: problems.slice(0, 12),
      wants: wants.slice(0, 12),
      total: demand.length
    },
    bestsellers: bestsellers.slice(0, 12),
    meta: {
      trendsError,
      aiError,
      usedModel,
      imagesVerified,
      imagesTotal: scored.length,
      demandCount: demand.length,
      bestsellerCount: bestsellers.length,
      seeds,
      deep,
      free: true,
      dataNote: 'Search phrases come from Google Autocomplete, bestsellers from Amazon, '
        + 'trends from Google Trends — all fetched live just now. The model only interpreted '
        + 'that data; it did not browse or recall. GCC scores are computed locally.',
      generatedAt: new Date().toISOString()
    }
  });
}

// ============================================================================
//  FREE SIGNAL LAYER
//  Everything here is a real, public, keyless endpoint with no meaningful rate
//  limit. This is where the facts come from. The model never sources facts — it
//  only interprets what these return, which keeps us inside the free tier and
//  makes every claim traceable to something a human can go and look at.
// ============================================================================

// --- Google Autocomplete ----------------------------------------------------
// Autocomplete is real aggregated search demand: a phrase only appears because
// people actually type it. Free, fast, works in any language/country.
async function suggest(q, gl, hl) {
  try {
    const u = 'https://suggestqueries.google.com/complete/search'
      + `?client=firefox&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`
      + `&q=${encodeURIComponent(q)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(u, { headers: { 'User-Agent': BROWSER_UA }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    const parsed = JSON.parse(await r.text());
    return Array.isArray(parsed[1]) ? parsed[1] : [];
  } catch (_) { return []; }
}

// Probe patterns, grouped by the intent each one exposes.
const PROBES = {
  demand:  ['best {s}', 'top {s}', '{s} for'],
  problem: ['why does my {s}', 'why is my {s}', 'how to fix {s}', '{s} not working', '{s} keeps'],
  buy:     ['buy {s}', '{s} price', 'best {s} to buy'],
  rival:   ['{s} vs', '{s} alternative', '{s} dupe']
};
const ALPHA = 'abcdefghijklmnopqrstuvwxyz'.split('');

function classifyIntent(phrase) {
  if (/^why |^how (to|do|can)|not working|won'?t |keeps |problem|fix/i.test(phrase)) return 'problem';
  if (/^(buy|cheap|price|cost)|price|for sale|near me/i.test(phrase)) return 'buy';
  if (/ vs | versus |alternative|dupe|instead of/i.test(phrase)) return 'rival';
  if (/^best|^top|review/i.test(phrase)) return 'demand';
  return 'other';
}

/**
 * Expand a seed into real search phrases. Returns phrases with how many probes
 * surfaced each one — repetition across different probes is a decent proxy for
 * how central a phrase is to the topic.
 */
async function mineDemand(seeds, gl, hl, { deep = false } = {}) {
  const list = Array.isArray(seeds) ? seeds : [seeds];
  const probes = [];

  list.forEach(seed => {
    Object.values(PROBES).forEach(pats =>
      pats.forEach(p => probes.push({ q: p.replace('{s}', seed), seed })));
    // "seed a", "seed b" … — the classic alphabet-soup expansion.
    const letters = deep ? ALPHA : ALPHA.slice(0, 6);
    letters.forEach(c => probes.push({ q: seed + ' ' + c, seed }));
  });

  // Chunked so we never open 200 sockets at once.
  const out = [];
  for (let i = 0; i < probes.length; i += 25) {
    const chunk = probes.slice(i, i + 25);
    const res = await Promise.all(chunk.map(p => suggest(p.q, gl, hl)));
    res.forEach((phrases, j) => phrases.forEach(s => out.push({ s, seed: chunk[j].seed })));
  }

  const seedSet = new Set(list.map(s => s.toLowerCase()));
  const freq = {};
  out.forEach(({ s, seed }) => {
    const k = String(s).trim().toLowerCase();
    if (!k || seedSet.has(k) || NOISE.test(k)) return;
    if (!freq[k]) freq[k] = { hits: 0, seeds: new Set() };
    freq[k].hits++;
    freq[k].seeds.add(seed);
  });

  return Object.entries(freq)
    .map(([phrase, v]) => ({
      phrase, hits: v.hits, seeds: Array.from(v.seeds), intent: classifyIntent(phrase)
    }))
    .sort((a, b) => b.seeds.length - a.seeds.length || b.hits - a.hits);
}

// --- Amazon Best Sellers ----------------------------------------------------
// Real bestseller lists, no key. Product names come out of the image alt text,
// which survives their markup changes better than class-name scraping.
const AMAZON_HOST = {
  US: 'www.amazon.com', CA: 'www.amazon.ca', GB: 'www.amazon.co.uk',
  FR: 'www.amazon.fr', ES: 'www.amazon.es', DE: 'www.amazon.de',
  IT: 'www.amazon.it', AU: 'www.amazon.com.au',
  SA: 'www.amazon.sa', AE: 'www.amazon.ae'
};
const AMAZON_NODE = {
  beauty:   'beauty', wellness: 'hpc', hair: 'beauty', fitness: 'sports',
  home:     'home-garden', baby: 'baby-products', men: 'beauty', fashion: 'fashion'
};

async function amazonBestsellers(niche, market) {
  const host = AMAZON_HOST[market] || AMAZON_HOST.US;
  const node = AMAZON_NODE[niche] || 'beauty';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(`https://${host}/gp/bestsellers/${node}`, {
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.9' },
      redirect: 'follow', signal: ctrl.signal
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const html = await r.text();
    if (/captcha|Robot Check|api-services-support@amazon/i.test(html)) return [];

    const seen = new Set();
    return [...html.matchAll(/alt="([^"]{15,110})"/g)]
      .map(m => decodeXml(m[1]))
      .filter(x => x && !/logo|icon|sprite|star|rating|prime|banner|amazon/i.test(x))
      .filter(x => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 25);
  } catch (_) { return []; }
}

// ============================================================================
//  ACTION: saturation  —  the red-team check, rebuilt on free data.
//
//  The old version asked a grounded model "is this saturated?". This measures
//  it instead: if a product name autocompletes in Saudi Arabia, Saudis are
//  already searching it, so the novelty is gone. If "<product> dupe" or
//  "<product> alternative" autocompletes, many sellers already compete.
//  Deterministic, instant, and costs no model quota at all.
// ============================================================================
function overlapCount(list, name) {
  const t = new Set(tokensOf(name));
  if (!t.size) return 0;
  return list.filter(s => {
    const st = new Set(tokensOf(s));
    let hit = 0; t.forEach(x => { if (st.has(x)) hit++; });
    return hit / t.size >= 0.5;
  }).length;
}

function tokensOf(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
    .split(/\s+/).filter(w => w.length > 2);
}

async function saturationOf(name, m) {
  const [home, ksaEn, ksaAr, dupe, alt] = await Promise.all([
    suggest(name, m.geo.toLowerCase(), m.lang),
    suggest(name, 'sa', 'en'),
    suggest(name, 'sa', 'ar'),
    suggest(name + ' dupe', m.geo.toLowerCase(), m.lang),
    suggest(name + ' alternative', m.geo.toLowerCase(), m.lang)
  ]);

  const homeHits  = overlapCount(home, name);
  const gccHits   = overlapCount(ksaEn, name) + overlapCount(ksaAr, name);
  const rivalHits = dupe.length + alt.length;

  // A descriptive concept ("non-sticky face serum") has no search footprint
  // anywhere, which is not the same as being undiscovered. Say so rather than
  // rewarding it for looking "fresh".
  const noFootprint = homeHits === 0 && gccHits === 0 && rivalHits === 0;

  let gccStatus, gccPts, gccWhy;
  if (noFootprint)       { gccStatus = 'no search footprint'; gccPts = 0;   gccWhy = 'Descriptive concept, not a known product name — saturation cannot be measured this way'; }
  else if (gccHits >= 4) { gccStatus = 'well known in GCC';   gccPts = -16; gccWhy = 'Saudi autocomplete already completes this — the novelty is gone'; }
  else if (gccHits >= 1) { gccStatus = 'some GCC awareness';  gccPts = -6;  gccWhy = 'Some Saudi search awareness already exists'; }
  else                   { gccStatus = 'unknown in GCC';      gccPts = 10;  gccWhy = 'Searched in the source market but not in Saudi — still fresh in the Gulf'; }

  let rivalStatus, rivalPts, rivalWhy;
  if (noFootprint)         { rivalStatus = 'unmeasured';        rivalPts = 0;   rivalWhy = null; }
  else if (rivalHits >= 8) { rivalStatus = 'heavy competition'; rivalPts = -12; rivalWhy = 'Many "dupe"/"alternative" searches — crowded with sellers'; }
  else if (rivalHits >= 3) { rivalStatus = 'some competition';  rivalPts = 0;   rivalWhy = null; }
  else                     { rivalStatus = 'little competition'; rivalPts = 6;  rivalWhy = 'Almost no dupe/alternative searches — few sellers so far'; }

  const demandStatus = noFootprint ? 'unmeasured'
                     : homeHits >= 4 ? 'strong search demand'
                     : homeHits >= 1 ? 'some search demand' : 'little search demand';
  const demandPts = noFootprint ? 0 : homeHits >= 4 ? 8 : homeHits >= 1 ? 0 : -8;

  return {
    gccStatus, gccHits, gccWhy, gccPts,
    rivalStatus, rivalHits, rivalWhy, rivalPts,
    demandStatus, homeHits, demandPts, noFootprint,
    evidence: {
      gcc: ksaEn.concat(ksaAr).slice(0, 6),
      rivals: dupe.concat(alt).slice(0, 6),
      home: home.slice(0, 6)
    }
  };
}

/** GCC rules first, then the real autocomplete evidence as visible adjustments. */
function scoreWithSaturation(product) {
  const gcc = scoreGccFit(product);
  if (gcc.blocked || !product.sat) return gcc;

  const s = product.sat;
  const extra = [];
  let score = gcc.score;

  [[s.gccPts, s.gccWhy], [s.rivalPts, s.rivalWhy]].forEach(([pts, why]) => {
    if (pts && why) { score += pts; extra.push({ kind: pts > 0 ? 'positive' : 'negative', pts, text: why }); }
  });

  if (s.demandPts) {
    score += s.demandPts;
    extra.push({
      kind: s.demandPts > 0 ? 'positive' : 'negative', pts: s.demandPts,
      text: s.demandPts > 0
        ? 'Real search demand in ' + s.homeHits + ' autocomplete matches'
        : 'Barely searched in the source market'
    });
  }

  if (s.noFootprint) {
    extra.push({ kind: 'neutral', pts: null,
      text: 'No search footprint — this is a concept, so saturation is unmeasured. Judge it yourself.' });
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 72 ? 'STRONG' : score >= 55 ? 'WORTH TESTING'
                : score >= 38 ? 'RISKY' : 'AVOID';

  return { score, verdict, blocked: false, unscored: false,
           reasons: gcc.reasons.filter(r => r.kind !== 'neutral').concat(extra) };
}

async function actionSaturation(req, res) {
  const { name, market = 'US' } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const m = MARKETS[market] || MARKETS.US;
  return res.status(200).json({
    ok: true, name,
    saturation: await saturationOf(name, m),
    meta: { free: true, cost: 'none — Google Autocomplete only' }
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

  // Real GCC awareness data, fetched free, so the model is told the answer
  // rather than asked to guess or browse for it.
  const [ksaEn, ksaAr, dupe] = await Promise.all([
    suggest(product.name, 'sa', 'en'),
    suggest(product.name, 'sa', 'ar'),
    suggest(product.name + ' dupe', m.geo.toLowerCase(), m.lang)
  ]);
  const gccHits = overlapCount(ksaEn.concat(ksaAr), product.name);

  const prompt = `You are advising a Saudi-based COD dropshipping brand (Cosmarab) that sells via Snapchat and TikTok ads to KSA and the wider GCC.

PRODUCT UNDER CONSIDERATION: ${product.name}
What it is: ${product.description || 'n/a'}
Why it trends in ${m.name}: ${product.why_trending || 'n/a'}

=== REAL SATURATION DATA (Google Autocomplete, fetched just now) ===
Saudi autocomplete matches for this product: ${gccHits}
${ksaEn.concat(ksaAr).length ? 'Saudi suggestions seen: ' + ksaEn.concat(ksaAr).slice(0, 8).join(' | ') : 'No Saudi suggestions at all — unknown there.'}
"dupe" searches in ${m.name}: ${dupe.length ? dupe.slice(0, 5).join(' | ') : 'none'}
Use THIS for gcc_saturation: 4+ Saudi matches = "heavy", 1-3 = "some", 0 = "none". Do not guess beyond it.

BRAND CONTEXT — the strategy that has worked for this brand:
- Take a problem that is oversold in Western/Chinese markets, but deliver it in a format that feels NEW in the GCC.
- Drink sachets outperform capsules: they feel like food, not medicine, and fit Arabic coffee ritual.
- Culturally trusted ingredients (saffron, dates, honey, oud) add instant credibility.
- Price band that works on COD: 120-400 SAR.
- Avoid: whitening, balding, weight-loss claims, medical claims — these kill ad approval and delivery rate.

Return ONLY JSON in this shape:
{
  "gcc_saturation": "none" | "some" | "heavy",
  "saturation_evidence": "state what the autocomplete data above shows — do not claim to have checked Noon or Amazon.sa, you have not",
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

  let analysis = null, aiError = null, usedModel = null;
  try {
    const out = await gemini(prompt);
    usedModel = out.model;
    analysis = extractJson(out.text);
  } catch (e) {
    aiError = e.message;
  }

  return res.status(200).json({
    ok: true,
    product: product.name,
    gcc,
    analysis,
    saturationData: {
      gccHits,
      gccSuggestions: ksaEn.concat(ksaAr).slice(0, 8),
      dupeSearches: dupe.slice(0, 5)
    },
    meta: { aiError, usedModel, free: true, generatedAt: new Date().toISOString() }
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
        niches: Object.entries(NICHES).map(([code, n]) => ({ code, label: n.label })),
        periods: Object.entries(PERIODS).map(([code, p]) => ({ code, label: p.label })),
        free: true,
        hasKey: !!process.env.GEMINI_KEY
      });
    }

    const sess = requireAuth(req);
    if (!sess) return res.status(401).json({ error: 'unauthorized' });

    if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

    if (action === 'discover') return await actionDiscover(req, res);
    if (action === 'saturation') return await actionSaturation(req, res);
    if (action === 'analyze')  return await actionAnalyze(req, res);
    if (action === 'buildLp')  return await actionBuildLp(req, res);

    return res.status(404).json({ error: 'unknown_action' });

  } catch (err) {
    console.error('[trends]', action, err);
    return res.status(500).json({ error: 'server_error', detail: err.message });
  }
};
