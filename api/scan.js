// api/scan.js — v1.12
// Fixes in this version:
// 1. BigInt tokenId normalisation (prevents precision loss on large token IDs)
// 2. is_video + media_format detected server-side
// 3. Spam: reads contract.isSpam from getNFTMetadata response + metadata scoring (no extra API calls)
//    + lightweight metadata scoring
// 4. animation_url returned for frontend video detection fallback

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
      '0x7b503e206db34148ad77e00afe214034edf9e3ff', // Foundation: NFT Market (Proxy) on Base
    ]),
  };

  const OWNER_OF = '0x6352211e';

  // FIX 1: BigInt token ID normalisation — prevents precision loss on large token IDs
  function normaliseTokenId(rawId) {
    if (!rawId) return null;
    try {
      return BigInt(rawId).toString();
    } catch {
      return null;
    }
  }

  try {
    // ── STAGE 1: Get minted (contract, tokenId, chain) pairs ─────────────────
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
          const rawId = tx.erc721TokenId || tx.tokenId;
          const tokenId = normaliseTokenId(rawId); // FIX 1 applied here
          if (!tokenId) continue;
          mintedTokens.push({ contract, tokenId, chain });
        }
        pageKey = data?.pageKey || '';
      } while (pageKey);
    }

    // Sequential to avoid timeout on large wallets
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

    // ── STAGE 2: Fetch metadata per exact token ───────────────────────────────
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
          results.set(key, nft);
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId, contract,
            chain, cid_meta: null, cid_media: null,
            has_cid: false, display_cid: null, image: null,
            animation_url: null, media_format: null, is_video: false,
            status: 'unknown', isSpam: false, spamReasons: [],
          });
        }
      }));
    }

    // ── STAGE 3: Spam detection — no extra API calls, uses metadata + scoring ──
    // isSpamContract checks removed: too many extra calls, timeout risk on large wallets.
    // Spam signals come from: Alchemy's spamInfo in getNFTMetadata + metadata scoring.
    for (const [, nft] of results.entries()) {
      const metaScore = scoreMetadataSpam(nft);
      if (!nft.isSpam && metaScore.score >= 40) {
        nft.isSpam = true;
        nft.spamReasons = metaScore.reasons;
      } else if (nft.isSpam) {
        nft.spamReasons = [...(nft.spamReasons||[]), ...metaScore.reasons];
      }
    }

    // ── STAGE 4: Ownership check per token ───────────────────────────────────
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

// FIX 5: Lightweight metadata spam scoring
// Known spam token names — instant flag, score 100
const KNOWN_SPAM_TOKENS = new Set([
  'jup', 'jup airdrop', 'jup voucher', 'jup token',
  'arb airdrop', 'op airdrop', 'strk airdrop',
  'ens airdrop', 'uni airdrop', 'blur airdrop',
  'zk airdrop', 'eigen airdrop', 'w airdrop',
  'layerzero airdrop', 'zro airdrop',
  '$jup', '$arb', '$op',
]);

function scoreMetadataSpam(nft) {
  let score = 0;
  const reasons = [];
  const title = (nft.title || '').toLowerCase().trim();
  const desc = (nft.description || '').toLowerCase();

  // Instant flag for known spam token names
  if (KNOWN_SPAM_TOKENS.has(title)) {
    score += 100; reasons.push('Known spam token name');
    return { score, reasons };
  }

  if (!title || title.length < 2) {
    score += 15; reasons.push('Missing or weak title');
  }
  if (/\b(claim|airdrop|reward|voucher|free|bonus|prize|visit|mint now)\b/i.test(title)) {
    score += 25; reasons.push('Claim/reward wording in title');
  }
  if (/https?:\/\//i.test(desc)) {
    score += 15; reasons.push('External links in description');
  }
  if (!nft.image && !nft.cid_media) {
    score += 20; reasons.push('No image or media');
  }
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

// Foundation gateway domains — if tokenURI comes from these, it's a Foundation NFT
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

  // FIX 4: is_video detected server-side using animation_url + media format hints
  const animationUrl = nft.rawMetadata?.animation_url || null;
  const mediaFormat  = nft.media?.[0]?.format
    || nft.media?.[0]?.mimeType
    || nft.rawMetadata?.properties?.mime_type
    || nft.rawMetadata?.properties?.mimeType
    || nft.rawMetadata?.properties?.type
    || '';
  const isVideo = /video/i.test(mediaFormat)
    || /\.(mp4|mov|webm|ogv|m4v)(\?|#|$)/i.test(animationUrl || '');

  // Spam: read from Alchemy's contract-level spamInfo in metadata response
  const spamInfo = nft.contract?.spamInfo || {};
  const isSpam = spamInfo.isSpam === true || spamInfo.isSpam === 'true';

  const isFoundation = isFoundationNFT(nft);

  return {
    title: nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId || tokenIdFallback}`,
    tokenId: nft.tokenId || tokenIdFallback,
    contract: (nft.contract?.address || contractFallback || '').toLowerCase(),
    contractDeployer: (nft.contract?.contractDeployer || '').toLowerCase(),
    chain: 'eth', // overridden after call with actual chain
    isFoundation,
    cid_meta: metaCID,
    cid_media: mediaCID,
    has_cid: hasCid,
    display_cid: metaCID || mediaCID || null,
    image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
    animation_url: animationUrl,
    media_format: mediaFormat || null,
    is_video: isVideo,
    status: 'unknown',
    isSpam,
    spamReasons: isSpam ? ['Alchemy metadata flag'] : [],
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
