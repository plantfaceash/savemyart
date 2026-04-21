// api/scan.js
// Finds Foundation NFTs minted by a given wallet address
// Uses getMintedNfts which finds NFTs created by the address, not just owned

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
  if (!ALCHEMY_KEY) return res.status(500).json({ error: 'Scanner not configured' });

  // Foundation's main contract addresses
  const FOUNDATION_CONTRACTS = [
    '0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405',
    '0x68d0F6d1d99Bb830e17fFaA8ADB5BbeD9719A9dd',
  ];

  try {
    const allNfts = [];

    // Strategy 1: getMintedNfts — finds NFTs the address originally minted
    // This works even if the NFT is now in escrow or transferred
    const mintedUrl = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getMintedNfts?address=${encodeURIComponent(address)}&contractAddresses[]=${FOUNDATION_CONTRACTS[0]}&contractAddresses[]=${FOUNDATION_CONTRACTS[1]}&withMetadata=true&limit=100&tokenType=ERC721`;

    const mintedRes = await fetch(mintedUrl);
    if (mintedRes.ok) {
      const mintedData = await mintedRes.json();
      const minted = (mintedData.nfts || []).map(nft => formatNft(nft));
      allNfts.push(...minted);
    }

    // Strategy 2: also check what they currently own from Foundation contracts
    // (catches cases where they collected but didn't mint)
    for (const contract of FOUNDATION_CONTRACTS) {
      const ownedUrl = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}/getNFTsForOwner?owner=${encodeURIComponent(address)}&contractAddresses[]=${contract}&withMetadata=true&limit=100`;
      const ownedRes = await fetch(ownedUrl);
      if (ownedRes.ok) {
        const ownedData = await ownedRes.json();
        const owned = (ownedData.ownedNfts || []).map(nft => formatNft(nft));
        allNfts.push(...owned);
      }
    }

    // Deduplicate by contract + tokenId
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

function formatNft(nft) {
  return {
    title: nft.name || nft.title || nft.rawMetadata?.name || `Token #${nft.tokenId}`,
    tokenId: nft.tokenId,
    contract: nft.contract?.address,
    chain: 'eth',
    cid_meta: extractCID(nft.tokenUri),
    cid_media: extractCID(nft.rawMetadata?.image || nft.rawMetadata?.animation_url),
    image: nft.image?.cachedUrl || nft.image?.originalUrl || nft.media?.[0]?.gateway || null,
    listed: false,
  };
}

function extractCID(uri) {
  if (!uri) return null;
  if (typeof uri === 'object') uri = uri.raw || uri.gateway || '';
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '').split('/')[0];
  const match = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}
