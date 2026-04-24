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

  const RPC     = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT     = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;
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

  const MARKETPLACE = new Set([
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
  ]);

  const OWNER_OF = '0x6352211e';

  try {
    // Get exact minted (contract, tokenId) pairs — from=0x0 means minted to wallet
    // Run Ethereum and Base in parallel
    const mintedTokens = [];

    async function fetchMints(rpcUrl, chain) {
      let pageKey = '';
      do {
        const params = {
          // Eth: Foundation launched ~block 11.5M. Base: launched ~block 1 (Aug 2023 = ~0x0)
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
          const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
          if (!tokenId) continue;
          mintedTokens.push({ contract, tokenId, chain });
        }
        pageKey = data?.pageKey || '';
      } while (pageKey);
    }

    await Promise.all([
      fetchMints(RPC, 'eth'),
      fetchMints(RPC_BASE, 'base'),
    ]);

    if (mintedTokens.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // Deduplicate — key includes chain so same tokenId on eth+base both show
    const seen = new Set();
    const uniqueTokens = mintedTokens.filter(({ contract, tokenId, chain }) => {
      const key = `${contract}-${tokenId}-${chain}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Fetch metadata for each exact token only
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
            has_cid: false, display_cid: null, image: null, status: 'unknown',
          });
        }
      }));
    }

    // Check current owner per token via ownerOf()
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
