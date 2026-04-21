// api/scan.js
// Finds ALL Foundation NFTs ever minted by a wallet address
// Uses alchemy_getAssetTransfers to find mint events (transfer from 0x0 to artist)
// This works regardless of whether NFTs are listed, sold, or still held by artist

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const ALCHEMY_KEY = process.env.ALCHEMY_API_KEY;
  if (!ALCHEMY_KEY) return res.status(500).json({ error: 'Scanner not configured' });

  const RPC_URL = `https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}`;
  const NFT_URL = `https://eth-mainnet.g.alchemy.com/nft/v3/${ALCHEMY_KEY}`;
  const FOUNDATION_CONTRACT = '0x3B3ee1931Dc30C1957379FAc9aba94D1C48a5405';

  try {
    // Find all ERC721 mint events on Foundation contract TO this address
    // Mint = Transfer from the zero address to the artist — permanent, never changes
    const transfersRes = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{
          fromBlock: '0x0',
          toBlock: 'latest',
          fromAddress: '0x0000000000000000000000000000000000000000',
          toAddress: address,
          contractAddresses: [FOUNDATION_CONTRACT],
          category: ['erc721'],
          withMetadata: true,
          excludeZeroValue: true,
          maxCount: '0x64',
        }],
      }),
    });

    const transfersData = await transfersRes.json();
    const transfers = transfersData.result?.transfers || [];

    if (transfers.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // For each minted token, fetch full metadata to get IPFS CIDs
    const nfts = await Promise.all(
      transfers.map(async (transfer) => {
        const rawId = transfer.erc721TokenId || transfer.tokenId;
        const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
        if (!tokenId) return null;

        try {
          const metaRes = await fetch(
            `${NFT_URL}/getNFTMetadata?contractAddress=${FOUNDATION_CONTRACT}&tokenId=${tokenId}&refreshCache=false`
          );
          const meta = await metaRes.json();

          return {
            title: meta.name || meta.rawMetadata?.name || `Token #${tokenId}`,
            tokenId,
            contract: FOUNDATION_CONTRACT,
            chain: 'eth',
            cid_meta: extractCID(meta.tokenUri?.raw || meta.tokenUri?.gateway),
            cid_media: extractCID(
              meta.rawMetadata?.image ||
              meta.rawMetadata?.animation_url ||
              meta.media?.[0]?.uri
            ),
            image: meta.image?.cachedUrl || meta.image?.originalUrl || null,
            listed: false,
          };
        } catch {
          return {
            title: `Token #${tokenId}`,
            tokenId,
            contract: FOUNDATION_CONTRACT,
            chain: 'eth',
            cid_meta: null,
            cid_media: null,
            image: null,
            listed: false,
          };
        }
      })
    );

    const valid = nfts.filter(Boolean);
    res.status(200).json({ nfts: valid, count: valid.length });

  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

function extractCID(uri) {
  if (!uri) return null;
  if (typeof uri === 'object') uri = uri.raw || uri.gateway || '';
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return uri.replace('ipfs://', '').split('/')[0];
  const match = uri.match(/\/ipfs\/([a-zA-Z0-9]+)/);
  return match ? match[1] : null;
}
