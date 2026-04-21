// api/debug.js
// Diagnostic endpoint - call with ?address=0x... to see what the scan finds
// Returns raw intermediate data so we can pinpoint the failure

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { address } = req.query;
  if (!address) return res.status(400).json({ error: 'Address required' });

  const KEY = process.env.ALCHEMY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'No API key' });

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;

  const SHARED  = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';
  const FACTORY1 = '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059';
  const FACTORY2 = '0x612e2daddc89d91409e40f946f9f7cfe422e777e';

  const addrLC    = address.toLowerCase();
  const addrTopic = '0x' + '0'.repeat(24) + addrLC.slice(2);

  // Minted(address,uint256,string,string) event signature
  const MINTED_TOPIC = '0xe2406cfd356cfbe4e42d452bde96d27f48c423e5f02b5d78695893308399519d';

  const out = { address: addrLC, steps: {} };

  try {
    // STEP 1: alchemy_getAssetTransfers - mint events to artist (no contract filter)
    const mintData = await rpc(RPC, 'alchemy_getAssetTransfers', [{
      fromBlock: '0xB00000',
      toBlock: 'latest',
      fromAddress: '0x0000000000000000000000000000000000000000',
      toAddress: address,
      category: ['erc721'],
      withMetadata: false,
      excludeZeroValue: false,
      maxCount: '0x3e8',
    }]);
    const transfers = mintData?.transfers || [];
    const byContract = {};
    for (const tx of transfers) {
      const c = tx.rawContract?.address?.toLowerCase();
      if (c) byContract[c] = (byContract[c] || 0) + 1;
    }
    out.steps.mintTransfers = {
      totalCount: transfers.length,
      contracts: byContract,
      note: 'ERC721 mints to artist from 0x0 across ALL contracts'
    };

    // STEP 2: Factory event scan - topics[1] = artist
    const factory1Logs = await rpc(RPC, 'eth_getLogs', [{
      fromBlock: '0xD72620', // Jan 2022
      toBlock: 'latest',
      address: FACTORY1,
      topics: [null, addrTopic],
    }]);
    const factory2Logs = await rpc(RPC, 'eth_getLogs', [{
      fromBlock: '0xD72620',
      toBlock: 'latest',
      address: FACTORY2,
      topics: [null, addrTopic],
    }]);
    out.steps.factoryLogsTopics1 = {
      factory1Count: (factory1Logs || []).length,
      factory2Count: (factory2Logs || []).length,
      factory1Sample: (factory1Logs || []).slice(0, 2),
      factory2Sample: (factory2Logs || []).slice(0, 2),
      note: 'Factory events where artist is topics[1]'
    };

    // STEP 3: Factory event scan - topics[2] = artist
    const f1t2 = await rpc(RPC, 'eth_getLogs', [{
      fromBlock: '0xD72620',
      toBlock: 'latest',
      address: FACTORY1,
      topics: [null, null, addrTopic],
    }]);
    const f2t2 = await rpc(RPC, 'eth_getLogs', [{
      fromBlock: '0xD72620',
      toBlock: 'latest',
      address: FACTORY2,
      topics: [null, null, addrTopic],
    }]);
    out.steps.factoryLogsTopics2 = {
      factory1Count: (f1t2 || []).length,
      factory2Count: (f2t2 || []).length,
      note: 'Factory events where artist is topics[2]'
    };

    // STEP 4: Minted event scan on personal collections (if any found)
    // Scan recent 100k blocks with Minted event + creator filter (2000 block chunks)
    const currentBlock = parseInt(await rpc(RPC, 'eth_blockNumber', []), 16);
    const fromBlock = currentBlock - 100000; // last ~2 weeks of blocks
    const CHUNK = 2000;
    let mintedLogs = [];
    const promises = [];
    for (let b = fromBlock; b < currentBlock; b += CHUNK) {
      const fb = '0x' + b.toString(16);
      const tb = '0x' + Math.min(b + CHUNK - 1, currentBlock).toString(16);
      promises.push(rpc(RPC, 'eth_getLogs', [{
        fromBlock: fb, toBlock: tb,
        topics: [MINTED_TOPIC, addrTopic],
      }]).catch(() => []));
    }
    // Run in batches of 20 parallel
    for (let i = 0; i < promises.length; i += 20) {
      const batch = await Promise.all(promises.slice(i, i + 20));
      for (const logs of batch) mintedLogs.push(...(logs || []));
    }
    const mintedContracts = [...new Set(mintedLogs.map(l => l.address?.toLowerCase()))];
    out.steps.mintedEventScan = {
      blocksScanned: 100000,
      logsFound: mintedLogs.length,
      contractsFound: mintedContracts,
      note: 'Minted(address,uint256,string,string) events with artist as creator in last 100k blocks'
    };

    // STEP 5: getNFTsForOwner - what does the artist currently hold?
    const ownedData = await fetch(`${NFT}/getNFTsForOwner?owner=${address}&withMetadata=false&limit=100`);
    const owned = await ownedData.json();
    const ownedByContract = {};
    for (const nft of (owned?.ownedNfts || [])) {
      const c = nft.contract?.address?.toLowerCase();
      if (c) ownedByContract[c] = (ownedByContract[c] || 0) + 1;
    }
    out.steps.currentlyOwned = {
      totalCount: owned?.totalCount || 0,
      byContract: ownedByContract,
      note: 'NFTs currently in artist wallet (any contract)'
    };

  } catch (err) {
    out.error = err.message;
  }

  res.status(200).json(out);
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
