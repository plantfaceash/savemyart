// api/scan.js — DEFINITIVE VERSION
//
// Why previous versions failed:
// - getNFTsForOwner: only returns currently held tokens (misses listed/sold)
// - Factory eth_getLogs over 10M blocks: silently returns empty on Alchemy
// - getMintedNfts with contract filter: same ownership problem
//
// This version:
// 1. Gets ALL ERC721 mints to artist from 0x0 (no contract filter) via alchemy_getAssetTransfers
//    Foundation ALWAYS mints to artist wallet first, then artist lists.
//    So all 150 tokens will appear here regardless of current listing status.
// 2. Verifies each contract is Foundation via factory() call
// 3. For each personal collection found, enumerates ALL tokens via getNFTsForContract
// 4. Uses getOwnersForContract to determine held/listed/sold status

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const KEY = process.env.ALCHEMY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Not configured' });

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;

  const SHARED_CONTRACT    = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';
  const FOUNDATION_FACTORIES = new Set([
    '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059',
    '0x612e2daddc89d91409e40f946f9f7cfe422e777e',
  ]);
  // Foundation marketplace escrow — tokens held here are "listed"
  const MARKETPLACE_ADDRS = new Set([
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
  ]);

  const addrLC = address.toLowerCase();
  const results = new Map(); // key = "contract-tokenId" → nft object

  try {
    // ── STEP 1: Get ALL ERC721 mints ever sent to artist ─────────────────────
    // No contract filter = catches shared contract AND all personal collections
    // Foundation always mints to artist wallet first (even for "mint and list" flow)
    const allMintTransfers = [];
    let pageKey = '';
    do {
      const params = {
        fromBlock: '0xB00000', // block ~11.5M = Feb 2021, Foundation launch
        toBlock:   'latest',
        fromAddress: '0x0000000000000000000000000000000000000000',
        toAddress:   address,
        category: ['erc721'],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: '0x3e8', // max 1000 per page
      };
      if (pageKey) params.pageKey = pageKey;
      const data = await rpcCall(RPC, 'alchemy_getAssetTransfers', [params]);
      allMintTransfers.push(...(data?.transfers || []));
      pageKey = data?.pageKey || '';
    } while (pageKey);

    // Group tokenIds by contract
    const byContract = new Map();
    for (const tx of allMintTransfers) {
      const contract = tx.rawContract?.address?.toLowerCase();
      if (!contract) continue;
      const rawId  = tx.erc721TokenId || tx.tokenId;
      const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
      if (!tokenId) continue;
      if (!byContract.has(contract)) byContract.set(contract, new Set());
      byContract.get(contract).add(tokenId);
    }

    if (byContract.size === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // ── STEP 2: Identify which contracts are Foundation ───────────────────────
    // factory() selector = 0xc45a0155 (keccak256("factory()")[0:4])
    const foundationPersonalContracts = new Set();

    for (const contract of byContract.keys()) {
      if (contract === SHARED_CONTRACT) continue;
      try {
        const result = await rpcCall(RPC, 'eth_call', [
          { to: contract, data: '0xc45a0155' },
          'latest',
        ]);
        if (result && result.length >= 66) {
          const factoryAddr = '0x' + result.slice(26).toLowerCase();
          if (FOUNDATION_FACTORIES.has(factoryAddr)) {
            foundationPersonalContracts.add(contract);
          }
        }
      } catch { /* not a Foundation personal collection */ }
    }

    // ── STEP 3: For each personal collection, enumerate ALL tokens ────────────
    // getNFTsForContract returns all tokens regardless of who currently holds them
    for (const contract of foundationPersonalContracts) {
      let startToken = '';
      let hasMore    = true;

      while (hasMore) {
        const url = `${NFT}/getNFTsForContract?contractAddress=${contract}`
          + `&withMetadata=true&limit=100`
          + (startToken ? `&startToken=${startToken}` : '');
        const data = await getJSON(url);

        for (const nft of (data?.nfts || [])) {
          const key = `${contract}-${nft.tokenId}`;
          if (!results.has(key)) {
            results.set(key, fmtNFT(nft, contract));
          }
        }

        startToken = data?.nextToken || '';
        hasMore    = !!data?.nextToken;
      }

      // ── STEP 4: Determine status using owner data ─────────────────────────
      try {
        const ownersData = await getJSON(
          `${NFT}/getOwnersForContract?contractAddress=${contract}&withTokenBalances=true`
        );
        for (const owner of (ownersData?.owners || [])) {
          const ownerLC = (owner.ownerAddress || '').toLowerCase();
          for (const tb of (owner.tokenBalances || [])) {
            const key = `${contract}-${tb.tokenId}`;
            if (!results.has(key)) continue;
            const nft = results.get(key);
            if (ownerLC === addrLC)                       nft.status = 'held';
            else if (MARKETPLACE_ADDRS.has(ownerLC))      nft.status = 'listed';
            else                                           nft.status = 'sold';
          }
        }
      } catch { /* owner data unavailable, status stays 'unknown' */ }
    }

    // ── STEP 5: Process Foundation shared contract tokens ─────────────────────
    const sharedTokenIds = Array.from(byContract.get(SHARED_CONTRACT) || []);

    // Batch fetch metadata in groups of 10 to stay fast
    for (let i = 0; i < sharedTokenIds.length; i += 10) {
      const batch = sharedTokenIds.slice(i, i + 10);
      await Promise.all(batch.map(async tokenId => {
        const key = `${SHARED_CONTRACT}-${tokenId}`;
        if (results.has(key)) return;
        try {
          const data = await getJSON(
            `${NFT}/getNFTMetadata?contractAddress=${SHARED_CONTRACT}&tokenId=${tokenId}`
          );
          results.set(key, fmtNFT(data, SHARED_CONTRACT, tokenId));
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId,
            contract: SHARED_CONTRACT, chain: 'eth',
            cid_meta: null, cid_media: null, image: null, status: 'unknown',
          });
        }
      }));
    }

    // ── STEP 6: Determine status for shared contract tokens ───────────────────
    // Quick check: which tokens is artist currently holding on shared contract?
    try {
      const heldData = await getJSON(
        `${NFT}/getNFTsForOwner?owner=${address}`
        + `&contractAddresses[]=${SHARED_CONTRACT}`
        + `&withMetadata=false&limit=100`
      );
      const heldIds = new Set((heldData?.ownedNfts || []).map(n => n.tokenId));
      for (const tokenId of sharedTokenIds) {
        const key = `${SHARED_CONTRACT}-${tokenId}`;
        if (!results.has(key)) continue;
        const nft = results.get(key);
        if (nft.status === 'unknown') {
          nft.status = heldIds.has(tokenId) ? 'held' : 'sold';
        }
      }
    } catch { /* status stays unknown */ }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtNFT(nft, contractFallback, tokenIdFallback) {
  return {
    title:     nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId || tokenIdFallback}`,
    tokenId:   nft.tokenId || tokenIdFallback,
    contract:  (nft.contract?.address || contractFallback || '').toLowerCase(),
    chain:     'eth',
    cid_meta:  extractCID(nft.tokenUri?.raw || nft.tokenUri?.gateway),
    cid_media: extractCID(
      nft.rawMetadata?.image ||
      nft.rawMetadata?.animation_url ||
      nft.media?.[0]?.uri
    ),
    image:  nft.image?.cachedUrl || nft.image?.originalUrl || null,
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

async function rpcCall(url, method, params) {
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  if (d.error) throw new Error(d.error.message);
  return d.result;
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
