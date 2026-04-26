// api/pin.js — v2.1
// Fetches IPFS content and uploads to Pinata.
// Gateways are raced in PARALLEL (not serial) so we get the fastest one.
// pinByHash is skipped — it's a paid-only Pinata feature and wastes time on free tier.

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

  // Gateways raced in parallel — fastest wins.
  // cloudflare-ipfs.com removed (shut down 2023).
  const GATEWAYS = [
    'https://ipfs.foundation.app/ipfs/',
    'https://d2ybmb80bbm9ts.cloudfront.net/',
    'https://ipfs.io/ipfs/',
    'https://gateway.pinata.cloud/ipfs/',
    'https://dweb.link/ipfs/',
  ];

  // Race all gateways — return first successful fetch.
  // Each gateway gets GATEWAY_TIMEOUT ms before being abandoned.
  const GATEWAY_TIMEOUT = 9000;

  const fetchFromGateways = async (cid) => {
    const controllers = GATEWAYS.map(() => new AbortController());

    const attempts = GATEWAYS.map((gateway, i) =>
      fetch(gateway + cid, {
        signal: controllers[i].signal,
        headers: { 'Accept': '*/*' },
      }).then(async (r) => {
        if (!r.ok) throw new Error(`${gateway} returned ${r.status}`);
        const contentType = r.headers.get('content-type') || 'application/octet-stream';
        const buffer = await r.arrayBuffer();
        if (buffer.byteLength === 0) throw new Error(`${gateway} returned empty body`);
        // Cancel all other in-flight requests
        controllers.forEach((c, j) => { if (j !== i) c.abort(); });
        return { buffer, contentType, gateway };
      })
    );

    // Overall race with a hard ceiling slightly under Vercel's function timeout
    const timeout = new Promise((_, reject) =>
      setTimeout(() => {
        controllers.forEach(c => c.abort());
        reject(new Error('All gateways timed out'));
      }, GATEWAY_TIMEOUT)
    );

    return Promise.any([...attempts, timeout.then(() => { throw new Error('timeout'); })]);
  };

  const uploadToPinata = async (buffer, contentType, pinName) => {
    const formData = new FormData();
    const ext = contentType.includes('json') ? '.json' : '';
    formData.append('file', new Blob([buffer], { type: contentType }), pinName + ext);
    formData.append('pinataMetadata', JSON.stringify({ name: pinName }));

    const r = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${JWT}` },
      body: formData,
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      throw new Error(`Pinata upload failed [${r.status}]: ${errText}`);
    }

    const data = await r.json().catch(() => ({}));
    return data.IpfsHash;
  };

  // pinByHash: paid Pinata feature — Pinata fetches the CID themselves, zero bandwidth cost.
  // Much faster than fetch+upload. Falls back to gateway race if it fails.
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
        signal: AbortSignal.timeout(8000),
      });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        return { success: true, method: 'pinByHash', newCid: cid, id: data.id };
      }
    } catch {
      // fall through to gateway fetch
    }
    return null;
  };

  const pinCID = async (cid, pinName) => {
    if (!cid) return { success: true, skipped: true };

    // Try pinByHash first (paid tier — fastest, no bandwidth)
    const hashResult = await tryPinByHash(cid, pinName);
    if (hashResult?.success) return hashResult;

    // Fall back to parallel gateway race + upload
    try {
      const { buffer, contentType, gateway } = await fetchFromGateways(cid);
      const newCid = await uploadToPinata(buffer, contentType, pinName);
      return { success: true, method: 'fetchAndPin', gateway, newCid };
    } catch (err) {
      const msg = err?.message || 'Unknown error';
      console.error(`Pin failed for ${cid}:`, msg);
      return { success: false, error: msg };
    }
  };

  try {
    const [metaResult, mediaResult] = await Promise.all([
      pinCID(cidMeta,  `${safeName}-metadata`),
      pinCID(cidMedia, `${safeName}-media`),
    ]);

    const success = metaResult.success && mediaResult.success;

    if (!success) {
      const errMsg = (!metaResult.success ? metaResult.error : mediaResult.error) || 'Unknown error';
      const isTimeout = errMsg.includes('timed out') || errMsg.includes('timeout');
      console.error('Pin failed:', errMsg);
      return res.status(500).json({
        success: false,
        error: isTimeout
          ? 'IPFS gateways are slow right now. Please try again in a few minutes.'
          : 'IPFS network busy. Please try again.',
        meta: metaResult,
        media: mediaResult,
      });
    }

    // Return IpfsHash at the top level so the frontend can confirm a real CID
    const IpfsHash = metaResult.newCid || mediaResult.newCid || null;
    res.status(200).json({ success: true, IpfsHash, meta: metaResult, media: mediaResult });

  } catch (err) {
    console.error('Pin handler error:', err);
    res.status(500).json({ error: err.message });
  }
}
