// api/pin.js — Robust pinning with smart fallback strategy
// Strategy (per ChatGPT's correct diagnosis):
// 1. Try Pinata pinByHash first (fastest, no bandwidth needed)
// 2. If CID not reachable, fetch from Foundation gateway first, then others
// 3. Upload fetched content to Pinata
// 4. Retry with backoff on transient failures

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

  // Gateway priority: Foundation first (still up until 2027), then public
  const GATEWAYS = [
    'https://ipfs.foundation.app/ipfs/',
    'https://d2ybmb80bbm9ts.cloudfront.net/',  // Foundation CDN
    'https://ipfs.io/ipfs/',
    'https://cloudflare-ipfs.com/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://dweb.link/ipfs/',
  ];

  // Step 1: Try Pinata pinByHash (paid feature but worth trying — may work on some plans)
  const tryPinByHash = async (cid, pinName) => {
    try {
      const r = await fetch('https://api.pinata.cloud/pinning/pinByHash', {
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
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        return { success: true, method: 'pinByHash', id: data.id };
      }
      return null; // fall through to fetch method
    } catch {
      return null;
    }
  };

  // Step 2: Fetch from gateway + upload to Pinata
  const fetchAndPin = async (cid, pinName) => {
    let lastErr = '';

    for (const gateway of GATEWAYS) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await sleep(1500 * attempt);

          const url = gateway + cid;
          const r = await fetch(url, {
            signal: AbortSignal.timeout(25000),
            headers: { 'Accept': '*/*' },
          });

          if (!r.ok) {
            lastErr = `${gateway} returned ${r.status}`;
            continue;
          }

          const contentType = r.headers.get('content-type') || 'application/octet-stream';
          const buffer = await r.arrayBuffer();

          if (buffer.byteLength === 0) {
            lastErr = `${gateway} returned empty body`;
            continue;
          }

          // Upload to Pinata
          const formData = new FormData();
          const ext = contentType.includes('json') ? '.json' : '';
          formData.append('file', new Blob([buffer], { type: contentType }), pinName + ext);
          formData.append('pinataMetadata', JSON.stringify({ name: pinName }));

          const uploadRes = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${JWT}` },
            body: formData,
          });

          if (uploadRes.ok) {
            const data = await uploadRes.json().catch(() => ({}));
            return { success: true, method: 'fetchAndPin', gateway, newCid: data.IpfsHash };
          }

          const errText = await uploadRes.text().catch(() => '');
          lastErr = `Pinata upload failed [${uploadRes.status}]: ${errText}`;

        } catch (err) {
          lastErr = `${gateway} error: ${err.message}`;
        }
      }
    }

    return { success: false, error: `Could not fetch CID from any gateway. ${lastErr}` };
  };

  const pinCID = async (cid, pinName) => {
    if (!cid) return { success: true, skipped: true };

    // Try pinByHash first (zero bandwidth if it works)
    const hashResult = await tryPinByHash(cid, pinName);
    if (hashResult?.success) return hashResult;

    // Fall back to fetch + upload
    return fetchAndPin(cid, pinName);
  };

  try {
    const [metaResult, mediaResult] = await Promise.all([
      pinCID(cidMeta,  `${safeName}-metadata`),
      pinCID(cidMedia, `${safeName}-media`),
    ]);

    const success = metaResult.success && mediaResult.success;

    if (!success) {
      const errMsg = (!metaResult.success ? metaResult.error : mediaResult.error) || 'Unknown error';
      const isGatewayError = errMsg.includes('Could not fetch');
      console.error('Pin failed:', errMsg);
      return res.status(500).json({
        success: false,
        error: isGatewayError
          ? 'IPFS network is busy right now. Please try again in a few minutes.'
          : errMsg,
        meta: metaResult,
        media: mediaResult,
      });
    }

    res.status(200).json({ success: true, meta: metaResult, media: mediaResult });
  } catch (err) {
    console.error('Pin handler error:', err);
    res.status(500).json({ error: err.message });
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
