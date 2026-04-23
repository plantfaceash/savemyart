// api/scan.js — CLEAN ACCURATE VERSION
//
// Core principle: only show NFTs that were MINTED BY this wallet
//
// Step 1: alchemy_getAssetTransfers(from=0x0, to=wallet) — mint events only
// Step 2: Group specific tokenIds by contract address
// Step 3: Verify each personal collection is Foundation via factory() eth_call
//         (NOT getNFTsForContract — that was pulling unrelated tokens)
// Step 4: Fetch metadata only for the specific minted tokenIds
// Step 5: Get current owner per token via ownerOf() eth_call
// Step 6: Assign status: held / listed / sold / unknown

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

  const RPC = `https://eth-mainnet.g.alchemy.com/v2/${KEY}`;
  const NFT = `https://eth-mainnet.g.alchemy.com/nft/v3/${KEY}`;

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

  // Known Foundation contracts
  const SHARED = '0x3b3ee1931dc30c1957379fac9aba94d1c48a5405';
  const FOUNDATION_FACTORIES = new Set([
    '0x3b612a5b49e025a6e4ba4ee4fb1ef46d13588059',
    '0x612e2daddc89d91409e40f946f9f7cfe422e777e',
  ]);
  const MARKETPLACE = new Set([
    '0xcda72070e455bb31c7690a170224ce43623d0b6f',
    '0x0e3a2a1f2146d86a604adc220b4967a898d7fe07',
  ]);

  // ABI selectors
  const FACTORY_SELECTOR = '0xc45a0155'; // factory()
  const OWNER_OF_SELECTOR = '0x6352211e'; // ownerOf(uint256)

  const results = new Map();

  try {
    // ── STEP 1: Get ALL ERC721 mints to this wallet ──────────────────────────
    // from=0x0 means minted directly to wallet — authoritative source
    const allMints = [];
    let pageKey = '';
    do {
      const params = {
        fromBlock: '0xB00000',
        toBlock: 'latest',
        fromAddress: '0x0000000000000000000000000000000000000000',
        toAddress: resolvedAddress,
        category: ['erc721'],
        withMetadata: false,
        excludeZeroValue: false,
        maxCount: '0x3e8',
      };
      if (pageKey) params.pageKey = pageKey;
      const data = await rpc(RPC, 'alchemy_getAssetTransfers', [params]);
      allMints.push(...(data?.transfers || []));
      pageKey = data?.pageKey || '';
    } while (pageKey);

    if (allMints.length === 0) {
      return res.status(200).json({ nfts: [], count: 0 });
    }

    // ── STEP 2: Group SPECIFIC minted tokenIds by contract ───────────────────
    // Only the exact tokens minted to this wallet — not the full collection
    const byContract = new Map();
    for (const tx of allMints) {
      const contract = tx.rawContract?.address?.toLowerCase();
      if (!contract) continue;
      const rawId = tx.erc721TokenId || tx.tokenId;
      const tokenId = rawId ? parseInt(rawId, 16).toString() : null;
      if (!tokenId) continue;
      if (!byContract.has(contract)) byContract.set(contract, new Set());
      byContract.get(contract).add(tokenId);
    }

    // ── STEP 3: Filter to Foundation contracts only ──────────────────────────
    // Verify each personal collection via factory() eth_call
    // This runs in parallel — no eth_getLogs, so no free-tier limit issues
    const personalContracts = [];
    await Promise.all(
      [...byContract.keys()]
        .filter(c => c !== SHARED)
        .map(async contract => {
          try {
            const result = await rpc(RPC, 'eth_call', [
              { to: contract, data: FACTORY_SELECTOR },
              'latest',
            ]);
            if (result && result.length >= 66) {
              const factoryAddr = '0x' + result.slice(26).toLowerCase();
              if (FOUNDATION_FACTORIES.has(factoryAddr)) {
                personalContracts.push(contract);
              }
              // Not a Foundation contract — silently skip
            }
          } catch {
            // eth_call failed — not a valid contract or not Foundation
          }
        })
    );

    // ── STEP 4: Fetch metadata for ONLY the minted tokenIds ─────────────────
    // NOT getNFTsForContract (returns entire collection)
    // Instead: one getNFTMetadata call per specific minted token
    for (let i = 0; i < personalContracts.length; i += 5) {
      const batch = personalContracts.slice(i, i + 5);
      await Promise.all(batch.map(async contract => {
        const tokenIds = [...(byContract.get(contract) || [])];
        // Fetch metadata in sub-batches of 10
        for (let j = 0; j < tokenIds.length; j += 10) {
          await Promise.all(tokenIds.slice(j, j + 10).map(async tokenId => {
            const key = `${contract}-${tokenId}`;
            if (results.has(key)) return;
            try {
              const data = await fetchJSON(
                `${NFT}/getNFTMetadata?contractAddress=${contract}&tokenId=${tokenId}`
              );
              results.set(key, fmtNFT(data, contract, tokenId));
            } catch {
              results.set(key, {
                title: `Token #${tokenId}`, tokenId, contract,
                chain: 'eth', cid_meta: null, cid_media: null,
                has_cid: false, display_cid: null, image: null, status: 'unknown',
              });
            }
          }));
        }
      }));
    }

    // ── STEP 5: Get current owner for each personal collection token ─────────
    // ownerOf(tokenId) via eth_call — accurate per-token ownership
    // Replaces getOwnersForContract (which we no longer call)
    const ownerChecks = [];
    for (const contract of personalContracts) {
      const tokenIds = [...(byContract.get(contract) || [])];
      for (const tokenId of tokenIds) {
        ownerChecks.push({ contract, tokenId });
      }
    }

    // Run owner checks in batches of 20
    for (let i = 0; i < ownerChecks.length; i += 20) {
      await Promise.all(ownerChecks.slice(i, i + 20).map(async ({ contract, tokenId }) => {
        const key = `${contract}-${tokenId}`;
        if (!results.has(key)) return;
        const nft = results.get(key);
        try {
          // ownerOf(uint256) — pad tokenId to 32 bytes
          const tokenHex = BigInt(tokenId).toString(16).padStart(64, '0');
          const callData = OWNER_OF_SELECTOR + tokenHex;
          const result = await rpc(RPC, 'eth_call', [
            { to: contract, data: callData },
            'latest',
          ]);
          if (result && result.length >= 66) {
            const owner = ('0x' + result.slice(26)).toLowerCase();
            if (owner === addrLC)            nft.status = 'held';
            else if (MARKETPLACE.has(owner)) nft.status = 'listed';
            else if (owner !== '0x0000000000000000000000000000000000000000') nft.status = 'sold';
          }
        } catch { /* status stays unknown */ }
      }));
    }

    // ── STEP 6: Shared contract — specific minted tokenIds only ─────────────
    const sharedIds = [...(byContract.get(SHARED) || [])];
    for (let i = 0; i < sharedIds.length; i += 10) {
      await Promise.all(sharedIds.slice(i, i + 10).map(async tokenId => {
        const key = `${SHARED}-${tokenId}`;
        if (results.has(key)) return;
        try {
          const data = await fetchJSON(
            `${NFT}/getNFTMetadata?contractAddress=${SHARED}&tokenId=${tokenId}`
          );
          results.set(key, fmtNFT(data, SHARED, tokenId));
        } catch {
          results.set(key, {
            title: `Token #${tokenId}`, tokenId, contract: SHARED,
            chain: 'eth', cid_meta: null, cid_media: null,
            has_cid: false, display_cid: null, image: null, status: 'unknown',
          });
        }
      }));
    }

    // Status for shared contract tokens
    try {
      const heldData = await fetchJSON(
        `${NFT}/getNFTsForOwner?owner=${encodeURIComponent(resolvedAddress)}`
        + `&contractAddresses[]=${SHARED}&withMetadata=false&limit=100`
      );
      const heldIds = new Set((heldData?.ownedNfts || []).map(n => n.tokenId));
      for (const tokenId of sharedIds) {
        const key = `${SHARED}-${tokenId}`;
        if (!results.has(key)) continue;
        const nft = results.get(key);
        if (nft.status === 'unknown') {
          nft.status = heldIds.has(tokenId) ? 'held' : 'sold';
        }
      }
    } catch { /* stays unknown */ }

    const nfts = Array.from(results.values());
    res.status(200).json({ nfts, count: nfts.length });

  } catch (err) {
    console.error('Scan error:', err.message);
    res.status(500).json({ error: 'Scan failed. Please try again.' });
  }
}

// ChatGPT-verified CID regex — CIDv0 (Qm...) and CIDv1 (b...)
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
