module.exports = async function handler(req, res) {
  const url = process.env.GOOGLE_SCRIPT_URL;
  if (!url) return res.status(500).json({ error: 'GOOGLE_SCRIPT_URL not set' });

  const testRows = [[
    new Date().toISOString(),
    'Test Karim', '0600000000', 'Casablanca',
    'cosmarab.com/ksa-18', 'COSLIP', 'Jinshan Lip Serum.1',
    1, 199, 'SAR', '', 'test'
  ]];

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: testRows }),
      redirect: 'follow'
    });
    const text = await r.text();
    return res.status(200).json({ status: r.status, ok: r.ok, body: text.slice(0, 500) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
