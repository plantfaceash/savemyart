// api/pin.js
// Auth: Bearer FILEBASE_IPFS_TOKEN (bucket-scoped IPFS pinning token)
// This is the token from Filebase dashboard > Buckets > savemyart-pins > IPFS RPC section
// NOT the access key:secret key combo — that's for S3, not IPFS pinning

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const IPFS_TOKEN = process.env.FILEBASE_IPFS_TOKEN;
  if (!IPFS_TOKEN) {
    console.error('FILEBASE_IPFS_TOKEN not set');
    return res.status(500).json({ error: 'Pinning not configured' });
  }

  const { cidMeta, cidMedia, name } = req.body || {};
  if (!cidMeta && !cidMedia) {
    return res.status(400).json({ error: 'No CID provided' });
  }

  const pinCID = async (cid, pinName) => {
    if (!cid) return { success: true, skipped: true };
    try {
      const response = await fetch('https://api.filebase.io/v1/ipfs/pins', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${IPFS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ cid, name: pinName }),
      });
      // 200 = already pinned, 202 = queued/in progress — both are success
      if (response.ok || response.status === 202) {
        const data = await response.json().catch(() => ({}));
        return { success: true, requestid: data.requestid };
      }
      const errText = await response.text().catch(() => 'Unknown error');
      console.error(`Pin failed [${response.status}]:`, errText);
      return { success: false, error: `Filebase ${response.status}: ${errText}` };
    } catch (err) {
      console.error('Pin fetch error:', err.message);
      return { success: false, error: err.message };
    }
  };

  try {
    const safeName = (name || 'untitled')
      .replace(/[^a-zA-Z0-9\s\-_]/g, '')
      .trim()
      .slice(0, 64) || 'untitled';

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
    console.error('Pin handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
