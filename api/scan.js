// api/scan.js — FINAL WORKING VERSION
//
// Root cause of all previous failures identified via debug endpoint:
// alchemy_getAssetTransfers(from=0x0, to=artist, NO_contract_filter) returns
// ALL 163 mint transfers across 18 contracts. We already have everything.
//
// Previous versions then tried eth_getLogs for factory scanning which fails
// on Alchemy free tier (10 block limit). Removing that entirely.
//
// Strategy: get all mint transfers → group by contract →
// for each personal collection call getNFTsForContract (gets all tokens
// regardless of current owner) → status via getOwnersForContract.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const KEY = process.env.ALCHEMY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Not configured' });

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;

  const SHARED_CONTRACT = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';
  const MARKETPLACE_ADDRS = new Set([
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
  ]);
  const addrLC = address.toLowerCase();
  const results = new Map();

  try {
    // ── STEP 1: Get ALL ERC721 mints to artist (no contract filter) ──────────
    // This returns mints across ALL contracts: shared Foundation + every
    // personal collection. Debug confirmed: 163 transfers, 18 contracts.
    // No factory scanning needed — we have the addresses right here.
    const allMintTransfers = [];
    let pageKey = '';
    do {
      const params = {
        fromBlock: '0xB00000',
        toBlock: 'latest',
        fromAddress: '0x0000000000000000000000000000000000000000',
        toAddress: address,
        category: ['erc721'],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: '0x3e8',
      };
      if (pageKey) params.pageKey = pageKey;
      const data = await rpc(RPC, 'alchemy_getAssetTransfers', [params]);
      allMintTransfers.push(...(data?.transfers || []));
      pageKey = data?.pageKey || '';
    } while (pageKey);

    if (allMintTransfers.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // ── STEP 2: Group tokenIds by contract ───────────────────────────────────
    const byContract = new Map();
    for (const tx of allMintTransfers) {
      const contract = tx.rawContract?.address?.toLowerCase();
      if (!contract) continue;
      const rawId = tx.erc721TokenId || tx.tokenId;
      const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
      if (!tokenId) continue;
      if (!byContract.has(contract)) byContract.set(contract, new Set());
      byContract.get(contract).add(tokenId);
    }

    // ── STEP 3: Personal collection contracts → get ALL tokens ───────────────
    // getNFTsForContract returns every token regardless of current owner,
    // so we get listed AND sold AND held pieces.
    const personalContracts = [...byContract.keys()].filter(c => c !== SHARED_CONTRACT);

    // Fetch all tokens in parallel (10 at a time)
    const collectionOwners = {};
    for (let i = 0; i < personalContracts.length; i += 10) {
      const batch = personalContracts.slice(i, i + 10);
      await Promise.all(batch.map(async contract => {
        // Get all tokens in collection
        let startToken = '';
        let hasMore = true;
        while (hasMore) {
          const url = `${NFT}/getNFTsForContract?contractAddress=${contract}`
            + `&withMetadata=true&limit=100`
            + (startToken ? `&startToken=${startToken}` : '');
          const data = await fetchJSON(url).catch(() => null);
          if (!data) { hasMore = false; break; }
          for (const nft of (data?.nfts || [])) {
            const key = `${contract}-${nft.tokenId}`;
            if (!results.has(key)) {
              results.set(key, fmtNFT(nft, contract));
            }
          }
          startToken = data?.nextToken || '';
          hasMore = !!data?.nextToken;
        }

        // Get owner data for status detection
        try {
          const od = await fetchJSON(`${NFT}/getOwnersForContract?contractAddress=${contract}&withTokenBalances=true`);
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

    // Apply status to personal collection tokens
    for (const [key, nft] of results.entries()) {
      const owners = collectionOwners[nft.contract];
      if (!owners) continue;
      const owner = (owners[nft.tokenId] || '').toLowerCase();
      if (owner === addrLC)                      nft.status = 'held';
      else if (MARKETPLACE_ADDRS.has(owner))     nft.status = 'listed';
      else if (owner)                            nft.status = 'sold';
    }

    // ── STEP 4: Shared contract tokens → fetch metadata individually ─────────
    const sharedIds = [...(byContract.get(SHARED_CONTRACT) || [])];
    for (let i = 0; i < sharedIds.length; i += 10) {
      const batch = sharedIds.slice(i, i + 10);
      await Promise.all(batch.map(async tokenId => {
        const key = `${SHARED_CONTRACT}-${tokenId}`;
        if (results.has(key)) return;
        try {
          const data = await fetchJSON(`${NFT}/getNFTMetadata?contractAddress=${SHARED_CONTRACT}&tokenId=${tokenId}`);
          results.set(key, fmtNFT(data, SHARED_CONTRACT, tokenId));
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId, contract: SHARED_CONTRACT,
            chain: 'eth', cid_meta: null, cid_media: null, image: null, status: 'unknown',
          });
        }
      }));
    }

    // ── STEP 5: Status for shared contract tokens ─────────────────────────────
    try {
      const heldData = await fetchJSON(
        `${NFT}/getNFTsForOwner?owner=${address}&contractAddresses[]=${SHARED_CONTRACT}&withMetadata=false&limit=100`
      );
      const heldIds = new Set((heldData?.ownedNfts || []).map(n => n.tokenId));
      for (const tokenId of sharedIds) {
        const key = `${SHARED_CONTRACT}-${tokenId}`;
        if (!results.has(key)) continue;
        const nft = results.get(key);
        if (nft.status === 'unknown') nft.status = heldIds.has(tokenId) ? 'held' : 'sold';
      }
    } catch { /* status stays unknown */ }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

function fmtNFT(nft, contractFallback, tokenIdFallback) {
  return {
    title: nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId || tokenIdFallback}`,
    tokenId: nft.tokenId || tokenIdFallback,
    contract: (nft.contract?.address || contractFallback || '').toLowerCase(),
    chain: 'eth',
    cid_meta: extractCID(nft.tokenUri?.raw || nft.tokenUri?.gateway),
    cid_media: extractCID(nft.rawMetadata?.image || nft.rawMetadata?.animation_url),
    image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
    status: 'unknown',
  };
}

function extractCID(uri) {
  if (!uri) return null;
  if (typeof uri === 'object') uri = uri.raw || uri.gateway || '';
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '').split('/')[0];
  const m = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
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
