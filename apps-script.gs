/***************************************************************************
 *  Cosmarab — Google Apps Script backend  (deploy as Web App)
 *  ------------------------------------------------------------------------
 *  Handles 3 things for your admin + landing page:
 *    1. POST {rows:[...]}            → append orders  (used by /api/submit-order)
 *    2. GET  ?action=orders          → read all orders  (used by admin)
 *    3. GET/POST redirects           → manage ad smart-links (used by admin + /r)
 *
 *  SETUP (one time):
 *    1. Open your Google Sheet → Extensions → Apps Script.
 *    2. Delete any existing code, paste ALL of this file, Save.
 *    3. Edit SHEET_TOKEN below to a long random secret (same value you put
 *       in Vercel env var SHEET_TOKEN).
 *    4. Deploy → New deployment → type "Web app".
 *         Execute as: Me      Who has access: Anyone
 *    5. Copy the Web App URL → that's your GOOGLE_SCRIPT_URL (Vercel env var).
 *    6. Re-deploy whenever you change this code (Deploy → Manage → edit → new version).
 ***************************************************************************/

var SHEET_TOKEN   = 'gHvlkNJfKAY4qmsVCQD6pESLyu7i3OTc';   // ← MUST match Vercel SHEET_TOKEN (verified 2026-08-26)
var ORDERS_SHEET  = 'Orders';
var TG_TOKEN      = '8356739743:AAHxxDKkBGaXjcvnQtWCcfDngs1_NxaHENg';
var TG_CHAT       = '8988230851';

// Canonical order columns — keep in sync with api/submit-order.js
var HEADERS = ['timestamp','time_ksa','name','phone','city','page','sku','product','qty','total','currency','note','source'];

/* ----------------------------- POST ----------------------------- */
function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) {}

  // --- append orders (no action key) ---
  if (body.rows && !body.action) {
    var tabName = body.tab || ORDERS_SHEET;
    var sh = sheet(tabName, HEADERS);
    body.rows.forEach(function(r){ sh.appendRow(r); });
    return json({ ok: true, added: body.rows.length });
  }

  // everything else needs the token
  if (body.token !== SHEET_TOKEN) return json({ ok:false, error:'unauthorized' });

  if (body.action === 'saveRedirect') {
    var props = PropertiesService.getScriptProperties();
    var all = JSON.parse(props.getProperty('REDIRECTS') || '{}');
    all[body.slug] = { slug: body.slug, target: body.target, note: body.note || '', updated: new Date().toISOString() };
    props.setProperty('REDIRECTS', JSON.stringify(all));
    return json({ ok:true });
  }

  if (body.action === 'deleteRedirect') {
    var props = PropertiesService.getScriptProperties();
    var all = JSON.parse(props.getProperty('REDIRECTS') || '{}');
    delete all[body.slug];
    props.setProperty('REDIRECTS', JSON.stringify(all));
    return json({ ok:true });
  }

  return json({ ok:false, error:'unknown_action' });
}

/* ----------------------------- GET ------------------------------ */
function doGet(e) {
  var p = (e && e.parameter) || {};

  // redirects are read by /api/go too — require token
  if (p.action === 'redirects') {
    if (p.token !== SHEET_TOKEN) return json({ ok:false, error:'unauthorized' });
    var props = PropertiesService.getScriptProperties();
    var all = JSON.parse(props.getProperty('REDIRECTS') || '{}');
    var out = Object.values(all).filter(function(r){ return r.slug; });
    return json({ ok:true, redirects: out });
  }

  if (p.action === 'orders') {
    if (p.token !== SHEET_TOKEN) return json({ ok:false, error:'unauthorized' });
    var sh = sheet(ORDERS_SHEET, HEADERS);
    var values = sh.getDataRange().getValues();
    var headers = values.length ? values[0] : HEADERS;
    var rows = values.slice(1);
    return json({ ok:true, headers: headers, rows: rows });
  }

  return json({ ok:true, status:'cosmarab backend live' });
}

/* -------- daily 9am reminder for video scripts -------- */
function dailyReminder() {
  var msg = '🎬 *وقت Video Bot!*\n\nحان الوقت لإنشاء النصوص اليومية 📝\n\nhttps://cosmarab.com/video-bot';
  UrlFetchApp.fetch('https://api.telegram.org/bot' + TG_TOKEN + '/sendMessage', {
    method:'post',
    payload:{chat_id:TG_CHAT, text:msg, parse_mode:'Markdown'},
    muteHttpExceptions:true
  });
}

/* --------------------------- helpers ---------------------------- */
function sheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.appendRow(headers); }
  else if (sh.getLastRow() === 0) { sh.appendRow(headers); }
  return sh;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
