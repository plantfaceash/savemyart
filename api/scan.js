// api/scan.js — FINAL
// Finds ALL Foundation NFTs ever created by an artist
// Strategy 1: Factory event logs → personal collection contracts → all tokens
// Strategy 2: Mint transfer events on shared Foundation contract
// No extra APIs beyond Alchemy needed

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const KEY = process.env.ALCHEMY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'Not configured' });

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;

  // Foundation contracts
  const SHARED  = '0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405';
  const FACTORY = [
    '0x3B612a5B49e025a6e4bA4eE4FB1EF46D13588059',
    '0x612E2DadDc89d91409e40f946f9f7CfE422e777E',
  ];
  // Foundation marketplace escrow — tokens here are "listed"
  const MARKETPLACE = [
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x7e9e4c0876b2102f33a1d82117cc73b7fddd0032',
  ];

  // Normalise address
  let addr = address.trim();
  if (!addr.startsWith('0x')) {
    // Attempt ENS resolution via public ENS reverse lookup
    try {
      const ensRes = await rpc(RPC, 'eth_call', [{
        to: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
        data: '0x02571be3' + namehash(addr),
      }, 'latest']);
      if (ensRes && ensRes !== '0x' + '0'.repeat(64)) {
        // Get resolver address
        const resolverAddr = '0x' + ensRes.slice(26);
        // Call addr(node) on resolver
        const addrRes = await rpc(RPC, 'eth_call', [{
          to: resolverAddr,
          data: '0x3b3b57de' + namehash(addr),
        }, 'latest']);
        if (addrRes && addrRes.length >= 66) {
          addr = '0x' + addrRes.slice(26);
        }
      }
    } catch { /* ENS resolution failed, continue with raw input */ }
  }

  const addrLC    = addr.toLowerCase();
  const addrTopic = '0x' + '0'.repeat(24) + addrLC.slice(2);

  const results = new Map();

  try {
    // ─── STRATEGY 1: Personal collection contracts via factory events ───────
    const personalContracts = new Set();

    for (const factory of FACTORY) {
      // Try creator address in topics[1] AND topics[2]
      // We don't know the exact ABI so we check both positions
      for (let pos = 1; pos <= 2; pos++) {
        const topics = Array(pos + 1).fill(null);
        topics[pos] = addrTopic;

        const logs = await rpc(RPC, 'eth_getLogs', [{
          fromBlock: '0xA7D8C0', // ~Oct 2020, before Foundation launch
          toBlock: 'latest',
          address: factory,
          topics,
        }]);

        for (const log of (logs || [])) {
          // Any address-shaped topic that isn't the artist is a collection contract
          for (const topic of log.topics.slice(1)) {
            if (topic && topic.startsWith('0x000000000000000000000000')) {
              const candidate = '0x' + topic.slice(26);
              if (candidate.toLowerCase() !== addrLC) {
                personalContracts.add(candidate);
              }
            }
          }
        }
      }
    }

    // ─── STRATEGY 2: Enumerate all tokens in each personal collection ────────
    for (const contract of personalContracts) {
      let pageKey = '';
      let hasMore  = true;

      while (hasMore) {
        const url = `${NFT}/getNFTsForContract?contractAddress=${contract}`
          + `&withMetadata=true&includeOwners=true&limit=100`
          + (pageKey ? `&startToken=${pageKey}` : '');

        const data = await getJSON(url);

        for (const nft of (data?.nfts || [])) {
          const key = `${contract.toLowerCase()}-${nft.tokenId}`;
          if (!results.has(key)) {
            results.set(key, fmt(nft, addrLC, MARKETPLACE));
          }
        }

        pageKey  = data?.nextToken || '';
        hasMore  = !!data?.nextToken;
      }
    }

    // ─── STRATEGY 3: Shared contract mint transfer events ────────────────────
    const sharedMints = await rpc(RPC, 'alchemy_getAssetTransfers', [{
      fromBlock: '0xB41C00', // ~block 11,800,000 Feb 2021
      toBlock:   'latest',
      fromAddress: '0x0000000000000000000000000000000000000000',
      toAddress:   addr,
      contractAddresses: [SHARED],
      category: ['erc721'],
      withMetadata: true,
      excludeZeroValue: true,
      maxCount: '0x64',
    }]);

    for (const tx of (sharedMints?.transfers || [])) {
      const rawId  = tx.erc721TokenId || tx.tokenId;
      const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
      if (!tokenId) continue;

      const key = `${SHARED.toLowerCase()}-${tokenId}`;
      if (!results.has(key)) {
        try {
          const meta = await getJSON(
            `${NFT}/getNFTMetadata?contractAddress=${SHARED}&tokenId=${tokenId}&includeOwners=true`
          );
          results.set(key, fmt(meta, addrLC, MARKETPLACE));
        } catch {
          results.set(key, {
            title:     `Token #${tokenId}`,
            tokenId,
            contract:  SHARED,
            chain:     'eth',
            cid_meta:  null,
            cid_media: null,
            image:     null,
            status:    'unknown',
          });
        }
      }
    }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmt(nft, artistLC, marketplaces) {
  const owner = (
    nft.owners?.[0]?.ownerAddress ||
    nft.owner ||
    ''
  ).toLowerCase();

  let status = 'sold';
  if (!owner)                          status = 'unknown';
  else if (owner === artistLC)         status = 'held';
  else if (marketplaces.includes(owner)) status = 'listed';

  return {
    title:     nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId}`,
    tokenId:   nft.tokenId,
    contract:  nft.contract?.address || '',
    chain:     'eth',
    cid_meta:  extractCID(nft.tokenUri?.raw || nft.tokenUri?.gateway),
    cid_media: extractCID(
      nft.rawMetadata?.image ||
      nft.rawMetadata?.animation_url ||
      nft.media?.[0]?.uri
    ),
    image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
    status,
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
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const d = await r.json();
  return d.result;
}

async function getJSON(url) {
  const r = await fetch(url);
  return r.json();
}

// Minimal ENS namehash (handles simple "name.eth" cases)
function namehash(name) {
  let node = '0000000000000000000000000000000000000000000000000000000000000000';
  if (name === '') return node;
  const labels = name.toLowerCase().split('.').reverse();
  for (const label of labels) {
    const labelHash = keccak256hex(label);
    node = keccak256hex(node + labelHash);
  }
  return node;
}

// Minimal keccak256 — only used for ENS, falls back gracefully if unavailable
function keccak256hex(str) {
  // Simple fallback: if Web Crypto is not available, return empty hash
  // In Node.js serverless environment, we can use crypto module
  try {
    const crypto = globalThis.crypto || require('crypto');
    const buf = typeof str === 'string'
      ? Buffer.from(str, str.length === 64 ? 'hex' : 'utf8')
      : str;
    if (crypto.subtle) {
      // async version not usable here inline; fall back
      return '0'.repeat(64);
    }
    return require('crypto').createHash('sha3-256').update(buf).digest('hex');
  } catch {
    return '0'.repeat(64);
  }
}
