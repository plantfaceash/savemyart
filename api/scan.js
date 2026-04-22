// api/scan.js — FINAL
// ENS: resolved via api.ensideas.com (no packages needed)
// CID: ChatGPT's verified CID_RE regex pattern
// Returns: has_cid + display_cid as single source of truth

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const input = address.trim();
  const isHex = /^0x[a-fA-F0-9]{40}$/.test(input);
  const isENS = /\.eth$/i.test(input);

  if (!isHex && !isENS) {
    return res.status(400).json({
      error: 'Invalid input. Enter a wallet address (0x...) or ENS name (name.eth)',
    });
  }

  const KEY = process.env.ALCHEMY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Not configured' });

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;

  // Resolve ENS to hex address
  let resolvedAddress = input;
  if (isENS) {
    try {
      const r = await fetch(`https://api.ensideas.com/ens/resolve/${encodeURIComponent(input)}`);
      if (!r.ok) throw new Error('not found');
      const d = await r.json();
      if (!d?.address) throw new Error('no address');
      resolvedAddress = d.address;
    } catch {
      return res.status(400).json({
        error: `Could not resolve ENS name "${input}". Try pasting the wallet address directly.`,
      });
    }
  }

  const addrLC = resolvedAddress.toLowerCase();
  const SHARED = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';
  const MARKETPLACE = new Set([
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
  ]);
  const results = new Map();

  try {
    // All ERC721 mints to artist — no contract filter (proven approach)
    const allMints = [];
    let pageKey = '';
    do {
      const params = {
        fromBlock: '0xB00000',
        toBlock: 'latest',
        fromAddress: '0x0000000000000000000000000000000000000000',
        toAddress: resolvedAddress,
        category: ['erc721'],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: '0x3e8',
      };
      if (pageKey) params.pageKey = pageKey;
      const data = await rpc(RPC, 'alchemy_getAssetTransfers', [params]);
      allMints.push(...(data?.transfers || []));
      pageKey = data?.pageKey || '';
    } while (pageKey);

    if (allMints.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // Group by contract
    const byContract = new Map();
    for (const tx of allMints) {
      const contract = tx.rawContract?.address?.toLowerCase();
      if (!contract) continue;
      const rawId = tx.erc721TokenId || tx.tokenId;
      const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
      if (!tokenId) continue;
      if (!byContract.has(contract)) byContract.set(contract, new Set());
      byContract.get(contract).add(tokenId);
    }

    const personalContracts = [...byContract.keys()].filter(c => c !== SHARED);
    const collectionOwners = {};

    // Enumerate all tokens in personal collections (batches of 5)
    for (let i = 0; i < personalContracts.length; i += 5) {
      await Promise.all(personalContracts.slice(i, i + 5).map(async contract => {
        let startToken = '';
        let hasMore = true;
        while (hasMore) {
          const url = `${NFT}/getNFTsForContract?contractAddress=${contract}`
            + `&withMetadata=true&limit=100`
            + (startToken ? `&startToken=${startToken}` : '');
          const data = await fetchJSON(url).catch(() => null);
          if (!data) break;
          for (const nft of (data?.nfts || [])) {
            const key = `${contract}-${nft.tokenId}`;
            if (!results.has(key)) results.set(key, fmtNFT(nft, contract));
          }
          startToken = data?.nextToken || '';
          hasMore = !!data?.nextToken;
        }

        try {
          const od = await fetchJSON(
            `${NFT}/getOwnersForContract?contractAddress=${contract}&withTokenBalances=true`
          );
          collectionOwners[contract] = {};
          for (const owner of (od?.owners || [])) {
            const ownerLC = (owner.ownerAddress || '').toLowerCase();
            for (const tb of (owner.tokenBalances || [])) {
              collectionOwners[contract][tb.tokenId] = ownerLC;
            }
          }
        } catch { /* status stays unknown */ }
      }));
    }

    // Apply status
    for (const [, nft] of results.entries()) {
      const owners = collectionOwners[nft.contract];
      if (!owners) continue;
      const owner = (owners[nft.tokenId] || '').toLowerCase();
      if (owner === addrLC)            nft.status = 'held';
      else if (MARKETPLACE.has(owner)) nft.status = 'listed';
      else if (owner)                  nft.status = 'sold';
    }

    // Shared contract tokens
    const sharedIds = [...(byContract.get(SHARED) || [])];
    for (let i = 0; i < sharedIds.length; i += 10) {
      await Promise.all(sharedIds.slice(i, i + 10).map(async tokenId => {
        const key = `${SHARED}-${tokenId}`;
        if (results.has(key)) return;
        try {
          const data = await fetchJSON(
            `${NFT}/getNFTMetadata?contractAddress=${SHARED}&tokenId=${tokenId}`
          );
          results.set(key, fmtNFT(data, SHARED, tokenId));
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId, contract: SHARED,
            chain: 'eth', cid_meta: null, cid_media: null,
            has_cid: false, display_cid: null, image: null, status: 'unknown',
          });
        }
      }));
    }

    // Status for shared contract
    try {
      const heldData = await fetchJSON(
        `${NFT}/getNFTsForOwner?owner=${encodeURIComponent(resolvedAddress)}`
        + `&contractAddresses[]=${SHARED}&withMetadata=false&limit=100`
      );
      const heldIds = new Set((heldData?.ownedNfts || []).map(n => n.tokenId));
      for (const tokenId of sharedIds) {
        const key = `${SHARED}-${tokenId}`;
        if (!results.has(key)) continue;
        const nft = results.get(key);
        if (nft.status === 'unknown') nft.status = heldIds.has(tokenId) ? 'held' : 'sold';
      }
    } catch { /* stays unknown */ }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

// ChatGPT's verified CID regex — handles CIDv0 (Qm) and CIDv1 (b...)
const CID_RE = /(?:^|\/)(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?=$|[/?#])/i;

function extractCID(uri) {
  if (!uri) return null;
  if (typeof uri === 'object') uri = uri.raw || uri.gateway || '';
  if (!uri) return null;

  // ipfs://Qm... or ipfs://bafy...
  if (uri.startsWith('ipfs://')) {
    const v = uri.slice(7).split(/[/?#]/)[0];
    if (!v) return null;
    // Validate: must look like a real CID (Qm... v0 or b... v1)
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/i.test(v)) return v;
    // Accept other long-form identifiers as a fallback
    return v.length >= 46 ? v : null;
  }

  // .../ipfs/{CID}
  const ipfsMatch = uri.match(
    /\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?=$|[/?#])/i
  );
  if (ipfsMatch) return ipfsMatch[1];

  // Bare CID in URL (Foundation CDN, etc.)
  const cidMatch = uri.match(CID_RE);
  if (cidMatch) return cidMatch[1];

  return null;
}

function fmtNFT(nft, contractFallback, tokenIdFallback) {
  const metaCID = extractCID(nft.tokenUri?.raw)
    || extractCID(nft.tokenUri?.gateway)
    || extractCID(nft.rawMetadata?.metadata_url)
    || null;

  const mediaCID = extractCID(nft.rawMetadata?.image)
    || extractCID(nft.rawMetadata?.animation_url)
    || extractCID(nft.media?.[0]?.uri)
    || extractCID(nft.media?.[0]?.raw)
    || extractCID(nft.image?.originalUrl)
    || extractCID(nft.image?.cachedUrl)
    || null;

  const hasCid = Boolean(metaCID || mediaCID);
  return {
    title: nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId || tokenIdFallback}`,
    tokenId: nft.tokenId || tokenIdFallback,
    contract: (nft.contract?.address || contractFallback || '').toLowerCase(),
    chain: 'eth',
    cid_meta: metaCID,
    cid_media: mediaCID,
    has_cid: hasCid,
    display_cid: metaCID || mediaCID || null,
    image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
    status: 'unknown',
  };
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d.result;
}

async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
