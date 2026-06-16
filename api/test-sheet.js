module.exports = async function handler(req, res) {
  const scriptUrl = process.env.GOOGLE_SCRIPT_URL;

  if (!scriptUrl) {
    return res.status(200).json({ error: 'GOOGLE_SCRIPT_URL not set' });
  }

  try {
    const testRows = [[
      new Date().toISOString(),
      'TEST NAME', '0512345678', 'Test City',
      'cosmarab.com', 'COSLIP', 'Jinshan Lip Serum.1',
      1, 199, 'SAR', 'TEST ROW - DELETE'
    ]];

    const r = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: testRows }),
      redirect: 'follow'
    });

    const text = await r.text();
    return res.status(200).json({
      scriptUrlSet: true,
      scriptUrlPrefix: scriptUrl.slice(0, 50) + '...',
      sheetStatus: r.status,
      sheetResponse: text.slice(0, 300)
    });
  } catch (err) {
    return res.status(200).json({
      scriptUrlSet: true,
      error: err.message
    });
  }
};
