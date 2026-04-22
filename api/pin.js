// api/pin.js — Pinata V3 API
// Uses /pinning/pinByHash which works with the JWT from V3 keys

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const JWT = process.env.PINATA_JWT;
  if (!JWT) {
    console.error('PINATA_JWT not set');
    return res.status(500).json({ error: 'Pinning not configured' });
  }

  const { cidMeta, cidMedia, name } = req.body || {};
  if (!cidMeta && !cidMedia) {
    return res.status(400).json({ error: 'No CID provided' });
  }

  const safeName = (name || 'untitled')
    .replace(/[^a-zA-Z0-9\s\-_]/g, '')
    .trim()
    .slice(0, 64) || 'untitled';

  const pinCID = async (cid, pinName) => {
    if (!cid) return { success: true, skipped: true };
    try {
      // Pinata V3 pin by CID endpoint
      const response = await fetch('https://api.pinata.cloud/v3/files/pin', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          cid,
          name: pinName,
        }),
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return { success: true, id: data?.data?.id };
      }

      // Fall back to V2 endpoint if V3 fails
      const v2response = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${JWT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          hashToPin: cid,
          pinataMetadata: { name: pinName },
        }),
      });

      if (v2response.ok) {
        const data = await v2response.json().catch(() => ({}));
        return { success: true, id: data.id };
      }

      const errText = await v2response.text().catch(() => 'Unknown error');
      console.error(`Pinata failed [${v2response.status}]:`, errText);
      return { success: false, status: v2response.status, error: errText };

    } catch (err) {
      console.error('Pin fetch error:', err.message);
      return { success: false, error: err.message };
    }
  };

  try {
    const [metaResult, mediaResult] = await Promise.all([
      pinCID(cidMeta,  `${safeName}-metadata`),
      pinCID(cidMedia, `${safeName}-media`),
    ]);

    const success = metaResult.success && mediaResult.success;
    res.status(success ? 200 : 500).json({ success, meta: metaResult, media: mediaResult });
  } catch (err) {
    console.error('Pin handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
