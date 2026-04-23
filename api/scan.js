// api/scan.js — TOKEN-LEVEL PRECISION 
//
// The ONLY source of truth: ERC721 transfer events where
//   from = 0x000...000 (zero address = mint)
//   to   = wallet
//
// From those events we get exact (contract, tokenId) pairs.
// We ONLY show those pairs. Nothing else. Ever.
// No collection expansion. No factory checks. No getNFTsForContract.

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

  // ENS resolution
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

  // Known Foundation contracts — used only for shared contract handling
  const SHARED = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';

  // Known Foundation marketplace/escrow contracts
  const MARKETPLACE = new Set([
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
  ]);

  // ownerOf(uint256) ABI selector
  const OWNER_OF = '0x6352211e';

  try {
    // ── STAGE 1: Get exact minted (contract, tokenId) pairs ─────────────────
    // from=0x0 AND to=wallet = tokens minted directly to this wallet
    // This is the ONLY signal of "minted by this wallet"
    const mintedTokens = []; // [{contract, tokenId}]
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
      for (const tx of (data?.transfers || [])) {
        const contract = tx.rawContract?.address?.toLowerCase();
        if (!contract) continue;
        const rawId = tx.erc721TokenId || tx.tokenId;
        const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
        if (!tokenId) continue;
        mintedTokens.push({ contract, tokenId });
      }
      pageKey = data?.pageKey || '';
    } while (pageKey);

    if (mintedTokens.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // Deduplicate — same token can appear if transferred back and reminted
    const seen = new Set();
    const uniqueTokens = mintedTokens.filter(({ contract, tokenId }) => {
      const key = `${contract}-${tokenId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── STAGE 1b: Filter to Foundation contracts only ────────────────────────
    // Cache validation result per contract — one factory() call max per contract
    // Known Foundation factory addresses
    const FOUNDATION_FACTORIES = new Set([
      '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059',
      '0x612e2daddc89d91409e40f946f9f7cfe422e777e',
    ]);
    const FACTORY_SELECTOR = '0xc45a0155';

    const contractCache = new Map(); // contract -> true/false (is Foundation)
    contractCache.set(SHARED, true); // shared contract is always valid

    // Get unique contracts (excluding shared — already known valid)
    const uniqueContracts = [...new Set(uniqueTokens.map(t => t.contract))].filter(c => c !== SHARED);

    // Validate each contract once
    await Promise.all(uniqueContracts.map(async contract => {
      try {
        const result = await rpc(RPC, 'eth_call', [
          { to: contract, data: FACTORY_SELECTOR },
          'latest',
        ]);
        if (result && result.length >= 66) {
          const factoryAddr = '0x' + result.slice(26).toLowerCase();
          contractCache.set(contract, FOUNDATION_FACTORIES.has(factoryAddr));
        } else {
          contractCache.set(contract, false);
        }
      } catch {
        contractCache.set(contract, false);
      }
    }));

    // Keep only tokens from verified Foundation contracts
    const foundationTokens = uniqueTokens.filter(({ contract }) =>
      contractCache.get(contract) === true
    );

    if (foundationTokens.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // ── STAGE 2: Enrich — fetch metadata for exact tokens only ──────────────
    // One getNFTMetadata call per token. No collection expansion.
    const results = new Map();

    for (let i = 0; i < foundationTokens.length; i += 20) {
      await Promise.all(foundationTokens.slice(i, i + 20).map(async ({ contract, tokenId }) => {
        const key = `${contract}-${tokenId}`;
        try {
          const data = await fetchJSON(
            `${NFT}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}`
          );
          results.set(key, fmtNFT(data, contract, tokenId));
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`,
            tokenId,
            contract,
            chain: 'eth',
            cid_meta: null,
            cid_media: null,
            has_cid: false,
            display_cid: null,
            image: null,
            status: 'unknown',
          });
        }
      }));
    }

    // ── STAGE 3: Ownership — check current owner per exact token ────────────
    // ownerOf(tokenId) via eth_call — accurate, per-token, no collection calls
    for (let i = 0; i < foundationTokens.length; i += 20) {
      await Promise.all(foundationTokens.slice(i, i + 20).map(async ({ contract, tokenId }) => {
        const key = `${contract}-${tokenId}`;
        const nft = results.get(key);
        if (!nft) return;
        try {
          const tokenHex = BigInt(tokenId).toString(16).padStart(64, '0');
          const result = await rpc(RPC, 'eth_call', [
            { to: contract, data: OWNER_OF + tokenHex },
            'latest',
          ]);
          if (result && result.length >= 66) {
            const owner = ('0x' + result.slice(26)).toLowerCase();
            const ZERO = '0x0000000000000000000000000000000000000000';
            if (owner === addrLC)            nft.status = 'held';
            else if (MARKETPLACE.has(owner)) nft.status = 'listed';
            else if (owner !== ZERO)         nft.status = 'sold';
          }
        } catch { /* status stays unknown */ }
      }));
    }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

// ChatGPT-verified CID regex
const CID_RE = /(?:^|\/)(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?=$|[/?#])/i;

function extractCID(uri) {
  if (!uri) return null;
  if (typeof uri === 'object') uri = uri.raw || uri.gateway || '';
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    const v = uri.slice(7).split(/[/?#]/)[0];
    if (!v) return null;
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})$/i.test(v)) return v;
    return v.length >= 46 ? v : null;
  }
  const ipfsMatch = uri.match(/\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?=$|[/?#])/i);
  if (ipfsMatch) return ipfsMatch[1];
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
