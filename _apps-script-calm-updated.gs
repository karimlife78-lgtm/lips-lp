var NOTIFY_EMAIL = 'ssellerleads@gmail.com';
var HEADERS = ['timestamp','country','name','phone','city','page','sku','product','qty','total','currency','note'];

// tab name -> friendly product label for the email subject/body
var PRODUCT_LABELS = {
  'ksa-calm': 'سُكون',
  'Glow':     'كولاجين جلو',
  'Gluco':    'جلوكو',
  'Ceylora':  'سيلورا',
  'NoorGlow': 'نورقلو'
};

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

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, added: body.rows.length, tab: tabName }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService
    .createTextOutput(JSON.stringify({ ok: false }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, status: 'cosmarab calm/glow sheet live' }))
    .setMimeType(ContentService.MimeType.JSON);
}
