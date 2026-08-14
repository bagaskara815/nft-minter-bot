// opensea-drop.js — mint OpenSea Drops (OS2) via the public GraphQL API.
//
// OpenSea's newer drop flow does NOT let you construct a mintPublic/mintSigned
// call yourself: the mint transaction is generated server-side (relayer +
// requestId) and eligibility/signature live in OpenSea's backend. So we replay
// the same persisted GraphQL queries the frontend uses:
//   - MintModuleQuery       → stages (label, price, startTime, per-wallet cap)
//   - MintActionTimelineQuery → the ready-to-send { to, data, value } tx
//
// Persisted-query hashes can change when OpenSea redeploys the frontend;
// override via env (OS_HASH_MINT_MODULE / OS_HASH_MINT_TIMELINE) if they break.
const GQL = 'https://gql.opensea.io/graphql';

const HASHES = {
  mintModule: process.env.OS_HASH_MINT_MODULE || '98b96c9357f51630dc14c3bcab0de47684337a0aa726277b82820d6ee354217d',
  mintTimeline: process.env.OS_HASH_MINT_TIMELINE || 'f13295cbe1dabcf1c58d8280ecc15e5ee7b04425b539e0c5261a8e4b2693d9d0',
  dropEligibility: process.env.OS_HASH_DROP_ELIGIBILITY || 'e1b54354df0d26d39c6b81429bd5e5d37749eaa4bdc027f987128f8c1e7d2308',
};

// Native token sentinel (paying with the chain's own coin).
const NATIVE = '0x0000000000000000000000000000000000000000';

// Map our canonical chain keys → OpenSea chain identifiers. Most match; only a
// few differ. Unknown keys pass through unchanged.
const OS_CHAIN = {
  ethereum: 'ethereum',
  base: 'base',
  polygon: 'matic',
  arbitrum: 'arbitrum',
  optimism: 'optimism',
  'zora-network': 'zora',
  bsc: 'bsc',
  avalanche: 'avalanche',
  bera: 'bera_chain',
  robinhood: 'robinhood',
};

export function osChain(chainKey) {
  return OS_CHAIN[chainKey] || chainKey;
}

const HEADERS = {
  'content-type': 'application/json',
  'x-app-id': 'os2-web',
  origin: 'https://opensea.io',
  referer: 'https://opensea.io/',
  'user-agent': 'Mozilla/5.0',
};

// Issue a persisted GraphQL query (GET, like the frontend). Returns parsed
// `data`. Throws on transport error; GraphQL-level errors are left in the
// payload for the caller to interpret (some are partial/UNAUTHORIZED).
async function persistedQuery(operationName, hash, variables, cookie) {
  const url =
    `${GQL}?app_id=os2-web&operationName=${operationName}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(JSON.stringify({ persistedQuery: { sha256Hash: hash, version: 1 } }))}`;
  const headers = cookie ? { ...HEADERS, cookie } : HEADERS;
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`opensea gql ${operationName} ${r.status}`);
  const j = await r.json();
  return j;
}

// Fetch the drop stages for a collection slug. Returns
// { typename, stages:[{ label, stageIndex, startTime, priceWei, symbol, currency, chain, maxPerWallet }] }
// or null when the slug isn't an OpenSea drop.
export async function getDropStages(slug) {
  const j = await persistedQuery('MintModuleQuery', HASHES.mintModule, { collectionSlug: slug });
  const drop = j?.data?.dropBySlug;
  if (!drop) return null;
  const stages = (drop.stages || []).map((s) => {
    const tok = s.price?.token;
    const unit = tok?.unit ?? 0;
    return {
      label: s.label,
      stageIndex: s.stageIndex,
      startTime: s.startTime ? Math.floor(new Date(s.startTime).getTime() / 1000) : null,
      priceWei: unit ? BigInt(Math.round(unit * 1e18)) : 0n,
      priceUnit: unit,
      symbol: tok?.symbol || 'ETH',
      currency: tok?.contractAddress || NATIVE,
      chain: tok?.chain?.identifier || null,
      maxPerWallet: s.maxTotalMintableByWallet ?? null,
      stageType: s.stageType || null,
    };
  });
  return { typename: drop.__typename, stages };
}

// Build the mint transaction via OpenSea's action timeline. Pays with the
// chain's native token on the same chain as the drop.
//
// Returns { to, data, value, networkId } ready to sign+send, or throws with the
// OpenSea error typename (e.g. DropNotMintingError, InsufficientFundError,
// wallet-not-eligible) so callers can surface a precise reason.
export async function buildOpenseaMint({ slug, minterAddress, contract, chain, tokenId = '0', quantity = 1, cookie }) {
  const osc = osChain(chain);
  const variables = {
    address: minterAddress,
    capabilities: { eip7702: false },
    fromAssets: [{ asset: { chain: osc, contractAddress: NATIVE } }],
    toAssets: [{ asset: { chain: osc, contractAddress: contract, tokenId: String(tokenId) }, quantity: String(quantity) }],
  };
  const j = await persistedQuery('MintActionTimelineQuery', HASHES.mintTimeline, variables, cookie);
  const swap = j?.data?.swap;
  const actions = swap?.actions || [];
  const mintAction = actions.find((a) => a.__typename === 'MintAction' && a.transactionSubmissionData);

  if (!mintAction) {
    // Surface the specific reason OpenSea gave (drop closed, ineligible, funds).
    const errs = (swap?.errors || []).map((e) => e.__typename).filter(Boolean);
    const gql = (j?.errors || []).map((e) => e.message).filter(Boolean);
    const reason = errs[0] || gql[0] || 'no mint action returned';
    throw new Error(`opensea drop: ${reason}`);
  }

  const t = mintAction.transactionSubmissionData;
  return {
    to: t.to,
    data: t.data,
    value: BigInt(t.value || 0),
    networkId: t.chain?.networkId ?? null,
    crossChain: !!mintAction.relayerFulfillment?.crossChain,
    requestId: mintAction.relayerFulfillment?.requestId || null,
  };
}

// Structured error codes OpenSea returns when a mint tx can't be built. These
// distinguish "you're not eligible / out of allocation" (definitive) from
// "drop not open yet" (retry later).
const OS_ERROR_MEANINGS = {
  InsufficientMintsRemainingError: 'jatah mint habis (sudah mint maksimal)',
  DropNotMintingError: 'stage belum buka',
  DropStageNotActiveError: 'stage belum aktif',
  NotEligibleError: 'wallet tidak eligible',
  InsufficientFundError: 'saldo tidak cukup',
};

export function explainOpenseaError(msg) {
  for (const [code, meaning] of Object.entries(OS_ERROR_MEANINGS)) {
    if (msg.includes(code)) return { code, meaning };
  }
  return { code: null, meaning: msg.replace(/^opensea drop:\s*/, '') };
}

// Probe whether a wallet can mint a drop RIGHT NOW by attempting to build the
// mint tx (the authenticated MintActionTimelineQuery — the resolver that
// actually gates minting, unlike the display-only DropEligibilityQuery which
// returns null for headless sessions). Returns:
//   { mintable:true, tx }                          — eligible, tx ready
//   { mintable:false, code, reason, funds:true }   — eligible but out of funds
//   { mintable:false, code, reason }               — not eligible / not open
export async function probeOpenseaMint(args) {
  try {
    const tx = await buildOpenseaMint(args);
    return { mintable: true, tx };
  } catch (e) {
    const { code, meaning } = explainOpenseaError(e.message);
    // "Insufficient funds" means the wallet IS eligible (server built intent,
    // only balance is short) — treat as eligible-but-underfunded.
    const funds = code === 'InsufficientFundError';
    return { mintable: false, code, reason: meaning, funds };
  }
}

// Check a wallet's per-stage eligibility. REQUIRES an authenticated session
// cookie (from opensea-auth) — without it OpenSea returns isEligible:null +
// UNAUTHORIZED. Returns { stages:[{ stageIndex, stageType, isEligible,
// eligibleMinterAddress, maxPerWallet, priceUnit, symbol }], authed } or null.
export async function getDropEligibility(slug, minterAddress, cookie) {
  const j = await persistedQuery(
    'DropEligibilityQuery',
    HASHES.dropEligibility,
    { address: minterAddress, collectionSlug: slug },
    cookie,
  );
  const drop = j?.data?.dropBySlug;
  if (!drop) return null;
  // If any isEligible is non-null, the session was accepted (authed).
  const stages = (drop.stages || []).map((s) => {
    const tok = s.eligiblePrice?.token;
    return {
      stageIndex: s.stageIndex,
      stageType: s.stageType || null,
      isEligible: s.isEligible,
      eligibleMinterAddress: s.eligibleMinterAddress || null,
      maxPerWallet: s.eligibleMaxTotalMintableByWallet ?? s.maxTotalMintableByWallet ?? null,
      priceUnit: tok?.unit ?? null,
      symbol: tok?.symbol || 'ETH',
    };
  });
  const authed = stages.some((s) => s.isEligible !== null);
  return { typename: drop.__typename, stages, authed, minted: drop.minterQuantityMinted ?? null };
}
