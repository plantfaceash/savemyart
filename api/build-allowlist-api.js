// api/build-allowlist.js — ONE TIME USE ENDPOINT
// Call once at: https://savemyart.xyz/api/build-allowlist
// Returns all Foundation personal collection contract addresses
// DELETE THIS FILE after you have the list

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

  // Foundation personal collections: blocks 14,100,000 to 22,500,000
  const START = 0xD72620;
  const END   = 0x1578000;
  const CHUNK = 500000; // Large chunks ok with specific address filter

  const collections = new Set();
  const errors = [];

  async function getLogs(address, fromBlock, toBlock) {
    const r = await fetch(RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
        params: [{ fromBlock, toBlock, address, topics: TOPICS }]
      })
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d.result || [];
  }

  for (const factory of FACTORIES) {
    let block = START;
    let chunkSize = CHUNK;
    while (block < END) {
      const to = Math.min(block + chunkSize, END);
      const fb = '0x' + block.toString(16);
      const tb = '0x' + to.toString(16);
      try {
        const logs = await getLogs(factory, fb, tb);
        for (const log of logs) {
          if (log.topics[1]) {
            collections.add('0x' + log.topics[1].slice(26).toLowerCase());
          }
        }
        block = to;
      } catch (e) {
        if (chunkSize > 10000) {
          chunkSize = Math.floor(chunkSize / 2);
        } else {
          errors.push(`${fb}-${tb}: ${e.message}`);
          block = to;
        }
      }
    }
  }

  const sorted = [...collections].sort();

  res.status(200).json({
    count: sorted.length,
    errors: errors.length,
    contracts: sorted,
    // Ready to paste into scan.js:
    setCode: `const FOUNDATION_CONTRACTS = new Set([\n${sorted.map(a => `  '${a}',`).join('\n')}\n  '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405', // shared\n]);`
  });
}
