// api/scan.js — v2.1 
// Token-level precision + factory() contract verification
// Only shows NFTs minted to wallet from Foundation contracts

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

  const RPC      = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT      = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;
  const RPC_BASE = `https://base-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT_BASE = `https://base-mainnet.g.alchemy.com/nft/v3/${KEY}`;

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

  const MARKETPLACES = {
    eth: new Set([
      '0xcda72070e455bb31c7690a170224ce43623d0b6f',
      '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
    ]),
    base: new Set([
      '0x7b503e206db34148ad77e00afe214034edf9e3ff',
    ]),
  };

  // Foundation shared contract (early mints) — always valid
  const SHARED = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';

  // Foundation factory contracts — personal collections deployed by these are valid
  const FOUNDATION_FACTORIES = new Set([
    '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059',
    '0x612e2daddc89d91409e40f946f9f7cfe422e777e',
  ]);

  // Foundation Base contracts
  const FOUNDATION_BASE_SHARED = new Set([
    '0x7b503e206db34148ad77e00afe214034edf9e3ff', // Base marketplace (also proxy)
  ]);

  const FACTORY_SELECTOR = '0xc45a0155'; // factory()
  const OWNER_OF         = '0x6352211e'; // ownerOf(uint256)

  function normaliseTokenId(rawId) {
    if (!rawId) return null;
    try { return BigInt(rawId).toString(); } catch { return null; }
  }

  try {
    // ── STAGE 1: Get minted tokens ────────────────────────────────────────────
    const mintedTokens = [];

    async function fetchMints(rpcUrl, chain) {
      let pageKey = '';
      do {
        const params = {
          fromBlock: chain === 'base' ? '0x0' : '0xB00000',
          toBlock: 'latest',
          fromAddress: '0x0000000000000000000000000000000000000000',
          toAddress: resolvedAddress,
          category: ['erc721'],
          withMetadata: false,
          excludeZeroValue: false,
          maxCount: '0x3e8',
        };
        if (pageKey) params.pageKey = pageKey;
        const data = await rpc(rpcUrl, 'alchemy_getAssetTransfers', [params]);
        for (const tx of (data?.transfers || [])) {
          const contract = tx.rawContract?.address?.toLowerCase();
          if (!contract) continue;
          const tokenId = normaliseTokenId(tx.erc721TokenId || tx.tokenId);
          if (!tokenId) continue;
          mintedTokens.push({ contract, tokenId, chain });
        }
        pageKey = data?.pageKey || '';
      } while (pageKey);
    }

    await fetchMints(RPC, 'eth');
    await fetchMints(RPC_BASE, 'base');

    if (mintedTokens.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // Deduplicate
    const seen = new Set();
    const uniqueTokens = mintedTokens.filter(({ contract, tokenId, chain }) => {
      const key = `${contract}-${tokenId}-${chain}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // ── STAGE 2: Verify contracts are Foundation ──────────────────────────────
    // One factory() call per unique ETH contract, cached
    const uniqueEthContracts = [...new Set(
      uniqueTokens.filter(t => t.chain === 'eth').map(t => t.contract)
    )];

    const contractCache = new Map();
    // Shared contract is always valid
    contractCache.set(SHARED, true);

    await Promise.all(uniqueEthContracts.map(async (contract) => {
      if (contractCache.has(contract)) return;
      if (contract === SHARED) { contractCache.set(contract, true); return; }
      try {
        // Check 1: is this a Foundation contract via factory()?
        const factoryResult = await rpc(RPC, 'eth_call', [
          { to: contract, data: FACTORY_SELECTOR },
          'latest',
        ]);
        let isFoundationContract = false;
        if (factoryResult && factoryResult.length >= 66) {
          const factoryAddr = '0x' + factoryResult.slice(26).toLowerCase();
          isFoundationContract = FOUNDATION_FACTORIES.has(factoryAddr);
        }
        if (!isFoundationContract) { contractCache.set(contract, false); return; }

        // Check 2: did THIS wallet deploy the contract? (artist vs collector)
        const meta = await fetchJSON(
          `${NFT}/getContractMetadata?contractAddress=${contract}`
        );
        const deployer = (meta?.contract?.contractDeployer || '').toLowerCase();
        // If deployer matches wallet = artist's own contract
        // If no deployer info = can't tell, include it (better to show than hide)
        contractCache.set(contract, !deployer || deployer === addrLC);
      } catch {
        contractCache.set(contract, false);
      }
    }));

    // For Base: use tokenURI domain check since factory() isn't reliable cross-chain
    // Base NFTs pass through — we accept some noise on Base, better than missing art
    const foundationTokens = uniqueTokens.filter(({ contract, chain }) => {
      if (chain === 'base') return true; // accept all Base mints, filter client-side
      return contractCache.get(contract) === true;
    });

    if (foundationTokens.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // ── STAGE 3: Fetch metadata ───────────────────────────────────────────────
    const results = new Map();
    for (let i = 0; i < foundationTokens.length; i += 20) {
      await Promise.all(foundationTokens.slice(i, i + 20).map(async ({ contract, tokenId, chain }) => {
        const key = `${contract}-${tokenId}-${chain}`;
        const nftBase = chain === 'base' ? NFT_BASE : NFT;
        try {
          const data = await fetchJSON(
            `${nftBase}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}`
          );
          const nft = fmtNFT(data, contract, tokenId);
          nft.chain = chain;
          results.set(key, nft);
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId, contract,
            chain, cid_meta: null, cid_media: null,
            has_cid: false, display_cid: null, image: null,
            animation_url: null, media_format: null, is_video: false,
            isFoundation: chain !== 'base' ? true : false,
            status: 'unknown', isSpam: false, spamReasons: [],
          });
        }
      }));
    }

    // ── STAGE 3b: Filter by contractDeployer — creator vs collector ─────────
    // If Alchemy returns contractDeployer and it doesn't match the scanned wallet,
    // the artist collected this from Foundation primary sale, not created it.
    // Move these to a secondary flag rather than removing (Base deployer unreliable).
    for (const [key, nft] of results.entries()) {
      const deployer = nft.contractDeployer || '';
      if (deployer && nft.chain === 'eth' && deployer !== addrLC) {
        nft.isCollected = true; // collected from Foundation, not created
      }
    }

    // ── STAGE 4: Ownership check ──────────────────────────────────────────────
    for (let i = 0; i < foundationTokens.length; i += 20) {
      await Promise.all(foundationTokens.slice(i, i + 20).map(async ({ contract, tokenId, chain }) => {
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
            const ZERO = '0x0000000000000000000000000000000000000000';
            const DEAD = '0x000000000000000000000000000000000000dead';
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
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

const FOUNDATION_DOMAINS = [
  'fnd-collections.mypinata.cloud',
  'fnd-collections2.mypinata.cloud',
  'fnd-collections3.mypinata.cloud',
  'fnd-collections4.mypinata.cloud',
  'foundation.app',
  'ipfs.foundation.app',
  'f8n-production-collection-assets.imgix.net',
  'f8n-ipfs.mypinata.cloud',
];

function isFoundationNFT(nft) {
  const uris = [
    nft.tokenUri?.raw,
    nft.tokenUri?.gateway,
    nft.rawMetadata?.metadata_url,
    nft.rawMetadata?.image,
    nft.rawMetadata?.animation_url,
    nft.image?.originalUrl,
    nft.image?.cachedUrl,
  ].filter(Boolean).join(' ');
  return FOUNDATION_DOMAINS.some(d => uris.includes(d));
}

const KNOWN_SPAM_TOKENS = new Set([
  'jup', 'jup airdrop', 'jup voucher', 'jup token',
  'arb airdrop', 'op airdrop', 'strk airdrop',
  'ens airdrop', 'uni airdrop', 'blur airdrop',
  'zk airdrop', 'eigen airdrop', 'w airdrop',
  'layerzero airdrop', 'zro airdrop', '$jup', '$arb', '$op',
]);

function scoreMetadataSpam(nft) {
  let score = 0;
  const reasons = [];
  const title = (nft.title || '').toLowerCase().trim();
  const desc = (nft.description || '').toLowerCase();
  if (KNOWN_SPAM_TOKENS.has(title)) { return { score: 100, reasons: ['Known spam token'] }; }
  if (!title || title.length < 2) { score += 15; reasons.push('Missing title'); }
  if (/\bclaim\b|\bairdrop\b|\breward\b|\bvoucher\b|\bbonus\b|free mint|\bvisit\b|\bdrop\b/i.test(title)) {
    score += 25; reasons.push('Spam wording in title');
  }
  if (/\$[a-z]{2,10}/i.test(title)) { score += 30; reasons.push('Token symbol in title'); }
  if (/https?:\/\//i.test(desc)) { score += 15; reasons.push('External links in description'); }
  if (!nft.image && !nft.cid_media) { score += 20; reasons.push('No image or media'); }
  return { score, reasons };
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

  const animationUrl = nft.rawMetadata?.animation_url || null;
  const mediaFormat  = nft.media?.[0]?.format
    || nft.media?.[0]?.mimeType
    || nft.rawMetadata?.properties?.mime_type
    || nft.rawMetadata?.properties?.mimeType
    || '';
  const isVideo = /video/i.test(mediaFormat)
    || /\.(mp4|mov|webm|ogv|m4v)(\?|#|$)/i.test(animationUrl || '');

  const spamInfo = nft.contract?.spamInfo || {};
  const isSpam = spamInfo.isSpam === true || spamInfo.isSpam === 'true';
  const isFoundation = isFoundationNFT(nft);

  return {
    title: nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId || tokenIdFallback}`,
    tokenId: nft.tokenId || tokenIdFallback,
    contract: (nft.contract?.address || contractFallback || '').toLowerCase(),
    contractDeployer: (nft.contract?.contractDeployer || '').toLowerCase(),
    chain: 'eth',
    cid_meta: metaCID,
    cid_media: mediaCID,
    has_cid: hasCid,
    display_cid: metaCID || mediaCID || null,
    image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
    animation_url: animationUrl,
    media_format: mediaFormat || null,
    is_video: isVideo,
    isFoundation,
    status: 'unknown',
    isSpam,
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
