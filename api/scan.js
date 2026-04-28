// api/scan.js — v2.3
// Scans ETH + Base for ERC-721 NFTs minted to wallet (from=0x0).
// ERC-721 only — clean, simple, matches last confirmed working state.

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

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

  const RPC      = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT      = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;
  const RPC_BASE = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT_BASE = `https://base-mainnet.g.alchemy.com/nft/v3/${KEY}`;

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

  const MARKETPLACES = {
    eth: new Set([
      '0xcda72070e455bb31c7690a170224ce43623d0b6f',
      '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
    ]),
    base: new Set([
      '0x7b503e206db34148ad77e00afe214034edf9e3ff',
    ]),
  };

  const SHARED = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';
  const FOUNDATION_FACTORIES = new Set([
    '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059',
    '0x612e2daddc89d91409e40f946f9f7cfe422e777e',
  ]);
  const FACTORY_SELECTOR = '0xc45a0155';
  const OWNER_OF         = '0x6352211e';
  const ZERO             = '0x0000000000000000000000000000000000000000';
  const DEAD             = '0x000000000000000000000000000000000000dead';

  function normaliseTokenId(rawId) {
    if (!rawId) return null;
    try { return BigInt(rawId).toString(); } catch { return null; }
  }

  try {
    // STAGE 1: Collect ERC-721 mints (from=0x0) for ETH and Base
    const mintedTokens = [];

    for (const [rpcUrl, chain] of [[RPC, 'eth'], [RPC_BASE, 'base']]) {
      let pageKey = '';
      do {
        const params = {
          fromBlock: chain === 'base' ? '0x0' : '0xB00000',
          toBlock: 'latest',
          fromAddress: ZERO,
          toAddress: resolvedAddress,
          category: ['erc721'],
          withMetadata: false,
          excludeZeroValue: false,
          maxCount: '0x3e8',
        };
        if (pageKey) params.pageKey = pageKey;
        try {
          const data = await rpc(rpcUrl, 'alchemy_getAssetTransfers', [params]);
          for (const tx of (data?.transfers || [])) {
            const contract = tx.rawContract?.address?.toLowerCase();
            if (!contract) continue;
            const tokenId = normaliseTokenId(tx.erc721TokenId || tx.tokenId);
            if (!tokenId) continue;
            mintedTokens.push({ contract, tokenId, chain });
          }
          pageKey = data?.pageKey || '';
        } catch (err) {
          console.error(`Alchemy fetch failed [${chain}]:`, err.message);
          pageKey = '';
        }
      } while (pageKey);
    }

    if (mintedTokens.length === 0) {
      return res.status(200).json({ nfts: [], count: 0, address: resolvedAddress });
    }

    // Deduplicate
    const seen = new Set();
    const uniqueTokens = mintedTokens.filter(({ contract, tokenId, chain }) => {
      const key = `${contract}-${tokenId}-${chain}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // STAGE 2: Foundation factory tagging (soft signal, ETH only)
    const uniqueEthContracts = [...new Set(
      uniqueTokens.filter(t => t.chain === 'eth').map(t => t.contract)
    )];
    const isFoundationContract = new Map();
    isFoundationContract.set(SHARED, true);

    await Promise.all(uniqueEthContracts.map(async (contract) => {
      if (isFoundationContract.has(contract)) return;
      try {
        const result = await rpc(RPC, 'eth_call', [
          { to: contract, data: FACTORY_SELECTOR },
          'latest',
        ]);
        if (result && result.length >= 66) {
          const factoryAddr = '0x' + result.slice(26).toLowerCase();
          isFoundationContract.set(contract, FOUNDATION_FACTORIES.has(factoryAddr));
        } else {
          isFoundationContract.set(contract, false);
        }
      } catch {
        isFoundationContract.set(contract, false);
      }
    }));

    // STAGE 3: Fetch metadata
    const results = new Map();
    for (let i = 0; i < uniqueTokens.length; i += 20) {
      await Promise.all(uniqueTokens.slice(i, i + 20).map(async ({ contract, tokenId, chain }) => {
        const key = `${contract}-${tokenId}-${chain}`;
        const nftBase = chain === 'base' ? NFT_BASE : NFT;
        try {
          const data = await fetchJSON(
            `${nftBase}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}`
          );
          const nft = fmtNFT(data, contract, tokenId);
          nft.chain = chain;
          if (chain === 'eth' && isFoundationContract.get(contract) === true) {
            nft.isFoundation = true;
          }
          results.set(key, nft);
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId, contract,
            contractDeployer: '', chain,
            cid_meta: null, cid_media: null, has_cid: false, display_cid: null,
            image: null, animation_url: null, media_format: null, is_video: false,
            isFoundation: chain === 'eth' && isFoundationContract.get(contract) === true,
            status: 'unknown', isSpam: false, description: null,
          });
        }
      }));
    }

    // STAGE 4: Ownership check
    for (let i = 0; i < uniqueTokens.length; i += 20) {
      await Promise.all(uniqueTokens.slice(i, i + 20).map(async ({ contract, tokenId, chain }) => {
        const key = `${contract}-${tokenId}-${chain}`;
        const nft = results.get(key);
        if (!nft) return;
        const rpcUrl = chain === 'base' ? RPC_BASE : RPC;
        try {
          const tokenHex = BigInt(tokenId).toString(16).padStart(64, '0');
          const result = await rpc(rpcUrl, 'eth_call', [
            { to: contract, data: OWNER_OF + tokenHex },
            'latest',
          ]);
          if (result && result.length >= 66) {
            const owner = ('0x' + result.slice(26)).toLowerCase();
            const chainMarket = MARKETPLACES[chain] || new Set();
            if (owner === addrLC)              nft.status = 'held';
            else if (chainMarket.has(owner))   nft.status = 'listed';
            else if (owner === ZERO || owner === DEAD) nft.status = 'burned';
            else                               nft.status = 'sold';
          }
        } catch { /* stays unknown */ }
      }));
    }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length, address: resolvedAddress });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

const FOUNDATION_DOMAINS = [
  'fnd-collections.mypinata.cloud', 'fnd-collections2.mypinata.cloud',
  'fnd-collections3.mypinata.cloud', 'fnd-collections4.mypinata.cloud',
  'foundation.app', 'ipfs.foundation.app',
  'f8n-production-collection-assets.imgix.net', 'f8n-ipfs.mypinata.cloud',
];

function isFoundationNFT(nft) {
  const uris = [
    nft.tokenUri?.raw, nft.tokenUri?.gateway, nft.rawMetadata?.metadata_url,
    nft.rawMetadata?.image, nft.rawMetadata?.animation_url,
    nft.image?.originalUrl, nft.image?.cachedUrl,
  ].filter(Boolean).join(' ');
  return FOUNDATION_DOMAINS.some(d => uris.includes(d));
}

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
  const m = uri.match(/\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,})(?=$|[/?#])/i);
  if (m) return m[1];
  const c = uri.match(CID_RE);
  if (c) return c[1];
  return null;
}

function fmtNFT(nft, contractFallback, tokenIdFallback) {
  const metaCID  = extractCID(nft.tokenUri?.raw) || extractCID(nft.tokenUri?.gateway) || extractCID(nft.rawMetadata?.metadata_url) || null;
  const mediaCID = extractCID(nft.rawMetadata?.image) || extractCID(nft.rawMetadata?.animation_url) || extractCID(nft.media?.[0]?.uri) || extractCID(nft.media?.[0]?.raw) || extractCID(nft.image?.originalUrl) || extractCID(nft.image?.cachedUrl) || null;
  const hasCid = Boolean(metaCID || mediaCID);
  const animationUrl = nft.rawMetadata?.animation_url || null;
  const mediaFormat  = nft.media?.[0]?.format || nft.media?.[0]?.mimeType || nft.rawMetadata?.properties?.mime_type || nft.rawMetadata?.properties?.mimeType || '';
  const isVideo = /video/i.test(mediaFormat) || /\.(mp4|mov|webm|ogv|m4v)(\?|#|$)/i.test(animationUrl || '');
  const spamInfo = nft.contract?.spamInfo || {};
  const isSpam = spamInfo.isSpam === true || spamInfo.isSpam === 'true';
  return {
    title: nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId || tokenIdFallback}`,
    tokenId: nft.tokenId || tokenIdFallback,
    contract: (nft.contract?.address || contractFallback || '').toLowerCase(),
    contractDeployer: (nft.contract?.contractDeployer || '').toLowerCase(),
    chain: 'eth',
    cid_meta: metaCID, cid_media: mediaCID, has_cid: hasCid,
    display_cid: metaCID || mediaCID || null,
    image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
    animation_url: animationUrl, media_format: mediaFormat || null,
    is_video: isVideo, isFoundation: isFoundationNFT(nft),
    status: 'unknown', isSpam,
    description: nft.rawMetadata?.description || null,
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
