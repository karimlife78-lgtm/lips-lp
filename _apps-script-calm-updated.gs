/* ===================================================================
   COSMARAB · CALM/GLOW SHEET Apps Script
   Paste over the existing script in THAT spreadsheet, then
   Deploy → Manage deployments → edit the active one → New version → Deploy.
   The web-app URL does not change.

   What changed
   ------------
   doGet only ever answered "sheet live", so the admin could not read a
   single order from this spreadsheet — every product living here
   (سُكون، جلو، جلوكو، رَواق، مَسار، صَفاء …) was invisible in the
   dashboard. It now answers action=orders the same way the main sheet
   does, merging every product tab and tagging each row with its tab.
=================================================================== */

var NOTIFY_EMAIL = 'ssellerleads@gmail.com';
var HEADERS = ['timestamp','country','name','phone','city','page','sku','product','qty','total','currency','note'];

// Reads are gated on the same token the admin already sends.
var READ_TOKEN = 'gHvlkNJfKAY4qmsVCQD6pESLyu7i3OTc';

// tab name -> friendly product label for the email subject/body
var PRODUCT_LABELS = {
  'ksa-calm': 'سُكون',
  'Glow':     'كولاجين جلو',
  'Gluco':    'جلوكو',
  'Ceylora':  'سيلورا',
  'NoorGlow': 'نورقلو',
  'Mullein':  'المولين',
  'Hair':     'لانثوم — سيروم الشعر',
  'Lung':     'نَفَس',
  'Masar':    'شاي مَسار',
  'Rawaq':    'رَواق',
  'RawaqTT':  'رَواق — تيك توك',
  'Safa':     'صَفاء',
  'Bath':     'حوض الأطفال',
  'Kidney':   'حصانة — الكلى',
  'KidneyUAE':'حصانة — الإمارات',
  'Waqar':    'وَقار — البروستاتا',
  'Eyes':     'ريم — جهاز العين',
  'Naseem':   'نسيم — سوار الغثيان',
  'Mizan':    'ميزان — الضغط',
  'MizanTT':  'ميزان — تيك توك'
};

// tabs that aren't orders, so the reader skips them
var NON_ORDER_TABS = { 'Sheet1': 1, 'Settings': 1, 'Notes': 1 };

function doPost(e) {
  var body = {};
  try { body = JSON.parse(e.postData.contents || '{}'); } catch (err) {}

  if (body.rows) {
    var tabName = body.tab || 'ksa-calm'; // no tab sent -> calm's own orders, same as before

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sh = ss.getSheetByName(tabName);
    if (!sh) {
      sh = ss.insertSheet(tabName);
      sh.appendRow(HEADERS);
    } else if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS);
    }
    body.rows.forEach(function(r) { sh.appendRow(r); });

    // Send email notification for first row (main order)
    try {
      var r = body.rows[0];
      var label = PRODUCT_LABELS[tabName] || tabName;
      var subject = '🔔 طلب جديد — ' + label + ' | ' + r[3] + ' — ' + r[4];
      var msg =
        '✅ طلب جديد — ' + label + '\n\n' +
        'الاسم: '    + r[2] + '\n' +
        'الجوال: '   + r[3] + '\n' +
        'المدينة: '  + r[4] + '\n' +
        'المنتج: '   + r[7] + '\n' +
        'الكمية: '   + r[8] + '\n' +
        'الإجمالي: ' + r[9] + ' ' + (r[10] || 'SAR') + '\n' +
        (r[11] ? 'ملاحظة: ' + r[11] + '\n' : '') +
        'الوقت: '    + r[0];
      GmailApp.sendEmail(NOTIFY_EMAIL, subject, msg);
    } catch (mailErr) {
      Logger.log('email error: ' + mailErr.message);
    }

    return json({ ok: true, added: body.rows.length, tab: tabName });
  }

  return json({ ok: false });
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  var action = p.action || 'status';

  if (action === 'orders') {
    if (p.token !== READ_TOKEN) return json({ ok: false, error: 'unauthorized' });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheets = ss.getSheets();
    var rows = [];

    for (var i = 0; i < sheets.length; i++) {
      var sh = sheets[i], name = sh.getName();
      if (NON_ORDER_TABS[name]) continue;
      if (p.tab && p.tab !== name) continue;      // ?tab=Safa reads one product
      if (sh.getLastRow() < 2) continue;          // header only

      var values = sh.getDataRange().getValues();
      for (var r = 1; r < values.length; r++) {
        var row = values[r];
        if (!row.join('')) continue;              // blank line
        // Date objects don't survive JSON cleanly — hand back a string.
        if (row[0] instanceof Date) row[0] = row[0].toISOString();
        rows.push(row.concat([name, PRODUCT_LABELS[name] || name]));
      }
    }

    return json({ ok: true, headers: HEADERS.concat(['tab', 'productLabel']), rows: rows });
  }

  if (action === 'tabs') {
    var names = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); });
    return json({ ok: true, tabs: names });
  }

  return json({ ok: true, status: 'cosmarab calm/glow sheet live' });
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/* Run once from the editor to confirm the reader sees your orders
   before relying on the dashboard. */
function testReadOrders() {
  var out = doGet({ parameter: { action: 'orders', token: READ_TOKEN } });
  var data = JSON.parse(out.getContent());
  Logger.log('ok=' + data.ok + '  rows=' + (data.rows ? data.rows.length : 0));
  if (data.rows && data.rows.length) Logger.log('newest tab: ' + data.rows[data.rows.length - 1].slice(-2).join(' / '));
}
