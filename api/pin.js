// api/pin.js
// Pins Foundation NFT CIDs to Filebase IPFS storage using Basic Auth
// Requires FILEBASE_ACCESS_TOKEN and FILEBASE_SECRET_KEY environment variables

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ACCESS_TOKEN = process.env.FILEBASE_ACCESS_TOKEN;
  const SECRET_KEY = process.env.FILEBASE_SECRET_KEY;

  if (!ACCESS_TOKEN || !SECRET_KEY) {
    return res.status(500).json({ error: 'Pinning not configured' });
  }

  // Filebase uses HTTP Basic Auth: base64(accessToken:secretKey)
  const credentials = Buffer.from(`${ACCESS_TOKEN}:${SECRET_KEY}`).toString('base64');
  const authHeader = `Basic ${credentials}`;

  const { cidMeta, cidMedia, name } = req.body;
  if (!cidMeta && !cidMedia) {
    return res.status(400).json({ error: 'At least one CID required' });
  }

  const pinCID = async (cid, pinName) => {
    if (!cid) return { success: true, skipped: true };

    const response = await fetch('https://api.filebase.io/v1/ipfs/pins', {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ cid, name: pinName }),
    });

    if (response.ok || response.status === 202) {
      const data = await response.json().catch(() => ({}));
      return { success: true, requestid: data.requestid };
    }

    const errorText = await response.text().catch(() => 'Unknown error');
    console.error(`Pin failed for ${cid}:`, response.status, errorText);
    return { success: false, error: errorText };
  };

  try {
    const safeName = (name || 'untitled').replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();

    const [metaResult, mediaResult] = await Promise.all([
      pinCID(cidMeta, `${safeName}-metadata`),
      pinCID(cidMedia, `${safeName}-media`),
    ]);

    const success = metaResult.success && mediaResult.success;

    res.status(success ? 200 : 500).json({
      success,
      meta: metaResult,
      media: mediaResult,
    });

  } catch (err) {
    console.error('Pin error:', err);
    res.status(500).json({ error: 'Pinning failed. Please try again.' });
  }
}
