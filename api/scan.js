// api/scan.js
// Scans Foundation contracts for NFTs owned by a given wallet address
// Uses Alchemy NFT API — requires ALCHEMY_API_KEY environment variable

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
  if (!ALCHEMY_KEY) return res.status(500).json({ error: 'Scanner not configured' });

  // Foundation's main Ethereum contract addresses
  const FOUNDATION_CONTRACTS = [
    '0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405', // Foundation shared contract
    '0x68d0F6d1d99Bb830e17fFaA8ADB5BbeD9719A9dd', // Foundation drops v1
  ];

  try {
    const allNfts = [];

    for (const contract of FOUNDATION_CONTRACTS) {
      let pageKey = '';
      let hasMore = true;

      while (hasMore) {
        const params = new URLSearchParams({
          owner: address,
          'contractAddresses[]': contract,
          withMetadata: 'true',
          limit: '100',
        });
        if (pageKey) params.append('pageKey', pageKey);

        const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner?${params}`;
        const response = await fetch(url);

        if (!response.ok) {
          console.error('Alchemy error:', response.status);
          break;
        }

        const data = await response.json();
        const nfts = (data.ownedNfts || []).map(nft => ({
          title: nft.name || nft.rawMetadata?.name || `Token #${nft.tokenId}`,
          tokenId: nft.tokenId,
          contract: nft.contract?.address,
          chain: 'eth',
          cid_meta: extractCID(nft.tokenUri),
          cid_media: extractCID(nft.rawMetadata?.image || nft.rawMetadata?.animation_url),
          image: nft.image?.cachedUrl || nft.image?.originalUrl || null,
          listed: false, // Foundation listing status requires separate contract check
        }));

        allNfts.push(...nfts);
        pageKey = data.pageKey || '';
        hasMore = !!data.pageKey;
      }
    }

    // Deduplicate by tokenId + contract
    const seen = new Set();
    const unique = allNfts.filter(n => {
      const key = `${n.contract}-${n.tokenId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.status(200).json({ nfts: unique, count: unique.length });

  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

function extractCID(uri) {
  if (!uri) return null;
  // ipfs://QmXXX or ipfs://QmXXX/file.json
  if (uri.startsWith('ipfs://')) {
    return uri.replace('ipfs://', '').split('/')[0];
  }
  // https://ipfs.io/ipfs/QmXXX or https://fnd-collections.mypinata.cloud/ipfs/QmXXX
  const match = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}
