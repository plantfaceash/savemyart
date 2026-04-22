// api/pin.js — Pinata free tier
// pinByHash requires paid plan, so we fetch content ourselves and upload it
// This works on Pinata free tier

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

  // IPFS gateways to try fetching content from
  const GATEWAYS = [
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
  ];

  const fetchFromIPFS = async (cid) => {
    for (const gateway of GATEWAYS) {
      try {
        const r = await fetch(`${gateway}${cid}`, {
          signal: AbortSignal.timeout(8000),
        });
        if (r.ok) return r;
      } catch { /* try next gateway */ }
    }
    throw new Error(`Could not fetch CID ${cid} from any gateway`);
  };

  const pinContent = async (cid, pinName) => {
    if (!cid) return { success: true, skipped: true };
    try {
      // Fetch content from IPFS
      const ipfsRes = await fetchFromIPFS(cid);
      const contentType = ipfsRes.headers.get('content-type') || 'application/octet-stream';
      const buffer = await ipfsRes.arrayBuffer();

      // Detect if it's JSON metadata
      const isJson = contentType.includes('json') ||
        pinName.includes('metadata') ||
        cid.startsWith('Qm') && buffer.byteLength < 50000;

      // Upload to Pinata
      const formData = new FormData();
      const blob = new Blob([buffer], { type: contentType });
      const filename = isJson ? `${pinName}.json` : `${pinName}`;
      formData.append('file', blob, filename);
      formData.append('pinataMetadata', JSON.stringify({ name: pinName }));
      formData.append('pinataOptions', JSON.stringify({ cidVersion: 1 }));

      const response = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${JWT}`,
        },
        body: formData,
      });

      if (response.ok) {
        const data = await response.json().catch(() => ({}));
        return { success: true, newCid: data.IpfsHash, originalCid: cid };
      }

      const errText = await response.text().catch(() => 'Unknown error');
      console.error(`Pinata upload failed [${response.status}]:`, errText);
      return { success: false, status: response.status, error: errText };

    } catch (err) {
      console.error('Pin error:', err.message);
      return { success: false, error: err.message };
    }
  };

  try {
    const [metaResult, mediaResult] = await Promise.all([
      pinContent(cidMeta,  `${safeName}-metadata`),
      pinContent(cidMedia, `${safeName}-media`),
    ]);

    const success = metaResult.success && mediaResult.success;
    res.status(success ? 200 : 500).json({ success, meta: metaResult, media: mediaResult });
  } catch (err) {
    console.error('Pin handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
