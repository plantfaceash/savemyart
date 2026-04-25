// api/build-allowlist.js — paginated allowlist builder
// Call with ?page=0, ?page=1, ?page=2, ?page=3 etc until done=true
// Paste ALL results back to Claude who will combine them

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const KEY = process.env.ALCHEMY_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'No API key' });

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;

  const FACTORIES = [
    '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059',
    '0x612e2daddc89d91409e40f946f9f7cfe422e777e',
  ];

  const TOPICS = [[
    '0x48c63a793e95e8dd34b97129fccf934521b523304e082dce08e8b526f744f77a',
    '0xf7fa52d400466b968484c78a536972ebacc53e89ddb0e9481725cbf5c9caef1b',
    '0x3fae07dc12cbcda9b511751519c44c4a152a6027e77d9d68d1d2dcae86bf3460',
  ]];

  // Split block range into pages of ~500k blocks each
  // Foundation launched personal collections ~block 13,400,000 (0xCC8C60)
  // Current block ~22,000,000 (0x14FB180)
  const PAGE_SIZE = 500000;
  const START = 0xCC8C60;
  const END   = 0x14FB180;

  const page = parseInt(req.query.page || '0');
  const fromBlock = START + page * PAGE_SIZE;
  const toBlock   = Math.min(fromBlock + PAGE_SIZE, END);
  const done      = toBlock >= END;

  if (fromBlock >= END) {
    return res.status(200).json({ done: true, page, contracts: [], count: 0 });
  }

  const collections = new Set();
  const errors = [];

  async function getLogs(address, fb, tb) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ fromBlock: fb, toBlock: tb, address, topics: TOPICS }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.result || [];
  }

  const fb = '0x' + fromBlock.toString(16);
  const tb = '0x' + toBlock.toString(16);

  for (const factory of FACTORIES) {
    let chunkFrom = fromBlock;
    let chunkSize = PAGE_SIZE;

    while (chunkFrom < toBlock) {
      const chunkTo = Math.min(chunkFrom + chunkSize, toBlock);
      const cfb = '0x' + chunkFrom.toString(16);
      const ctb = '0x' + chunkTo.toString(16);
      try {
        const logs = await getLogs(factory, cfb, ctb);
        for (const log of logs) {
          if (log.topics[1]) {
            collections.add('0x' + log.topics[1].slice(26).toLowerCase());
          }
        }
        chunkFrom = chunkTo;
      } catch (e) {
        if (chunkSize > 50000) {
          chunkSize = Math.floor(chunkSize / 2);
        } else {
          errors.push(`${cfb}-${ctb}: ${e.message}`);
          chunkFrom = chunkTo;
        }
      }
    }
  }

  const contracts = [...collections].sort();

  res.status(200).json({
    page,
    fromBlock: fb,
    toBlock: tb,
    done,
    nextPage: done ? null : page + 1,
    count: contracts.length,
    errors: errors.length,
    contracts,
  });
}
