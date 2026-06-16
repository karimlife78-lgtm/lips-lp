module.exports = async function handler(req, res) {
  const base = process.env.GOOGLE_SCRIPT_URL;
  const tok  = process.env.SHEET_TOKEN || '';
  if (!base) return res.status(500).json({ error: 'no url' });
  const u = new URL(base);
  u.searchParams.set('token', tok);
  u.searchParams.set('action', 'orders');
  try {
    const r    = await fetch(u.toString(), { redirect: 'follow' });
    const text = await r.text();
    return res.status(200).json({ status: r.status, body: text.slice(0, 800) });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
