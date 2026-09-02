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
  mintQuery: process.env.OS_HASH_MINT_QUERY || '15d500b9dab94cd28b158ebc43ac446c3c71250178c22cdbdf152bc302154310',
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

// Issue a persisted GraphQL query (GET, like the frontend). On
// PERSISTED_QUERY_NOT_FOUND (OpenSea redeploys rotate hashes), re-register the
// query via APQ — POST the full query text once with its sha256, then retry
// hash-only. Returns parsed JSON; GraphQL errors stay in the payload.
const QUERY_TEXTS = {
  MintActionTimelineQuery: `query MintActionTimelineQuery($address: Address! $fromAssets: [AssetQuantityInput!]! $toAssets: [AssetQuantityInput!]! $recipient: Address) { swap(address: $address fromAssets: $fromAssets toAssets: $toAssets recipient: $recipient action: MINT) { actions { __typename ... on TransactionAction { transactionSubmissionData { to data value chain { networkId identifier } } } } errors { __typename } } }`,
  MintModuleQuery: `query MintModuleQuery($collectionSlug: String!) { dropBySlug(slug: $collectionSlug) { __typename stages { __typename stageType stageIndex startTime endTime maxTotalMintableByWallet price { token { unit symbol contractAddress chain { identifier } } } label } } }`,
  DropEligibilityQuery: `query DropEligibilityQuery($collectionSlug: String!, $address: Address!) { dropBySlug(slug: $collectionSlug) { __typename ... on Erc721SeaDropV1 { minterQuantityMinted(minter: $address) } accountStageEligibility { walletCount allowlistedWalletCount wallets { address quantityMinted stages { dropStageUuid isEligible maxTotalMintableByWallet } } } stages { uuid stageType stageIndex isEligible eligibleMinterAddress maxTotalMintableByWallet allowlistMemberCount eligibleMaxTotalMintableByWallet eligiblePrice { token { unit symbol } } } } }`,
  MintQuery: `query MintQuery($slug: String!) { collectionBySlug(slug: $slug) { __typename name isVerified address chain { identifier } imageUrl } }`,
};

async function persistedQuery(operationName, hash, variables, cookie) {
  const headers = cookie ? { ...HEADERS, cookie } : HEADERS;
  const ext = JSON.stringify({ persistedQuery: { sha256Hash: hash, version: 1 } });
  const url =
    `${GQL}?app_id=os2-web&operationName=${operationName}` +
    `&variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&extensions=${encodeURIComponent(ext)}`;
  const r = await fetch(url, { headers });
  if (r.ok) return await r.json();

  // Hash may be retired (frontend redeploy). Fall back to APQ registration:
  // send the full query text with our computed sha256; the server registers it
  // and executes in the same call. Subsequent calls go back to hash-only GET.
  const body = await r.json().catch(() => ({}));
  const notFound = body?.errors?.some?.((e) => e?.extensions?.code === 'PERSISTED_QUERY_NOT_FOUND');
  const text = QUERY_TEXTS[operationName];
  if (!notFound || !text) throw new Error(`opensea gql ${operationName} ${r.status}`);
  const { createHash } = await import('node:crypto');
  const computed = createHash('sha256').update(text).digest('hex');
  const pr = await fetch(GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationName,
      query: text,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: computed } },
    }),
  });
  if (!pr.ok) throw new Error(`opensea gql ${operationName} APQ ${pr.status}`);
  return await pr.json();
}

// Run a query with OUR OWN text+hash via APQ directly (skip the pinned hash).
// Use when we need fields the frontend's pinned-hash version doesn't return
// (e.g. the new allowlist-count fields) — the server registers our hash.
async function apqQuery(operationName, variables, cookie) {
  const text = QUERY_TEXTS[operationName];
  if (!text) throw new Error(`no query text for ${operationName}`);
  const { createHash } = await import('node:crypto');
  const computed = createHash('sha256').update(text).digest('hex');
  const headers = cookie ? { ...HEADERS, cookie } : HEADERS;
  const pr = await fetch(GQL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      operationName,
      query: text,
      variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: computed } },
    }),
  });
  if (!pr.ok) throw new Error(`opensea gql ${operationName} APQ ${pr.status}`);
  return await pr.json();
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
      endTime: s.endTime ? Math.floor(new Date(s.endTime).getTime() / 1000) : 0,
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

// Fetch collection metadata + external links for a slug. The GraphQL API does
// not expose website/socials, so those come from the OpenSea REST v2 API
// (needs OPENSEA_KEY). Returns null when the slug isn't found.
export async function getCollectionMeta(slug) {
  const j = await persistedQuery('MintQuery', HASHES.mintQuery, { slug }).catch(() => null);
  const c = j?.data?.collectionBySlug;

  const meta = {
    name: c?.name || slug,
    verified: !!c?.isVerified,
    address: c?.address || null,
    chain: c?.chain?.identifier || null,
    imageUrl: c?.imageUrl || null,
    opensea: `https://opensea.io/collection/${slug}`,
    website: null,
    twitter: null,
    discord: null,
    telegram: null,
    owner: null,
  };

  // Enrich with external links from REST v2 when an API key is available.
  const key = process.env.OPENSEA_KEY;
  if (key) {
    try {
      const r = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, { headers: { 'x-api-key': key } });
      if (r.ok) {
        const d = await r.json();
        meta.website = d.project_url || null;
        meta.twitter = d.twitter_username ? `https://x.com/${d.twitter_username}` : null;
        meta.discord = d.discord_url || null;
        meta.telegram = d.telegram_url || null;
        meta.owner = d.owner || null;
        if (d.name) meta.name = d.name;
      }
    } catch { /* REST enrichment is best-effort */ }
  }

  return meta;
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
  const data = t.data || '0x';
  const selector = data.slice(0, 10).toLowerCase();
  // Infer the SeaDrop stage type from the returned selector (osnm-z mapping),
  // and decode the on-chain stageIndex so callers can verify the server built
  // the tx for the stage they intended (not a public fallback at a higher price).
  const stageType = SELECTOR_STAGE[selector] || null;
  let stageIndex = null;
  if (stageType === 'PUBLIC_SALE') {
    stageIndex = 0;
  } else if (stageType && data.length >= 10 + 9 * 64) {
    // presale: stageIndex lives at ABI word 8 (offset 4 + 8*32 bytes).
    try { stageIndex = Number(BigInt('0x' + data.slice(10 + 8 * 64, 10 + 9 * 64))); } catch { stageIndex = null; }
  }
  return {
    to: t.to,
    data,
    value: BigInt(t.value || 0),
    networkId: t.chain?.networkId ?? null,
    crossChain: !!mintAction.relayerFulfillment?.crossChain,
    requestId: mintAction.relayerFulfillment?.requestId || null,
    selector,
    stageType,
    stageIndex,
  };
}

// SeaDrop mint selectors → stage type (from zunmax/osnm-z validate_stage_calldata).
const SELECTOR_STAGE = {
  '0x161ac21f': 'PUBLIC_SALE',    // mintPublic
  '0x4b61cd6f': 'SIGNED_PRESALE', // mintSigned (GTD / allowlist w/ server signature)
  '0x4300a4e6': 'MERKLE_PRESALE', // mintAllowList (on-chain merkle)
};

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
  // Use our own APQ-registered query so the new count fields
  // (accountStageEligibility + allowlistMemberCount) are always present —
  // the frontend's pinned hash may still return the older shape.
  const j = await apqQuery(
    'DropEligibilityQuery',
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
      uuid: s.uuid || null,
      stageType: s.stageType || null,
      isEligible: s.isEligible,
      eligibleMinterAddress: s.eligibleMinterAddress || null,
      maxPerWallet: s.eligibleMaxTotalMintableByWallet ?? s.maxTotalMintableByWallet ?? null,
      priceUnit: tok?.unit ?? null,
      symbol: tok?.symbol || 'ETH',
      // New OpenSea field: how many wallets are in this stage's allowlist
      // (null on public stage). Shown as the "+N wallets eligible" style stat.
      allowlistMemberCount: s.allowlistMemberCount ?? null,
    };
  });
  const authed = stages.some((s) => s.isEligible !== null);
  // accountStageEligibility: the drop-wide wallet list. `allowlistedWalletCount`
  // is OpenSea's own number; the UI's per-stage "+N other wallets" count is
  // derived by filtering that list — we expose both plus the derived map.
  const ase = drop.accountStageEligibility || null;
  let otherEligibleByStage = null;
  if (ase?.wallets?.length) {
    // wallets[].stages identify the stage by dropStageUuid (NOT stageIndex) —
    // build uuid→stageIndex from the top-level stages list first.
    const byUuid = new Map(stages.filter((s) => s.uuid).map((s) => [s.uuid, s.stageIndex]));
    otherEligibleByStage = {};
    for (const wl of ase.wallets) {
      if (!wl.address || wl.address.toLowerCase() === String(minterAddress).toLowerCase()) continue;
      for (const st of wl.stages || []) {
        if (!st.isEligible) continue;
        const idx = byUuid.get(st.dropStageUuid);
        if (idx == null) continue;
        otherEligibleByStage[idx] = (otherEligibleByStage[idx] || 0) + 1;
      }
    }
  }
  return {
    typename: drop.__typename,
    stages,
    authed,
    minted: drop.minterQuantityMinted ?? null,
    walletCount: ase?.walletCount ?? null,
    allowlistedWalletCount: ase?.allowlistedWalletCount ?? null,
    otherEligibleByStage,
  };
}

// Resolve the earliest stage this wallet is actually eligible for, by
// cross-referencing MintModuleQuery (start/end/price per stage) with the
// authenticated DropEligibilityQuery (isEligible per stage). This is what /mo
// must wait for — NOT the public stage — so an eligible GTD/presale that opens
// earlier (and is usually cheaper) is targeted instead of the public fallback.
//
// Returns { stageIndex, stageType, startTime, endTime, priceUnit, symbol,
// maxPerWallet } for the earliest eligible stage, or null when the wallet is
// eligible for nothing / the session wasn't accepted.
export async function getEligibleOpenWindow(slug, minterAddress, cookie) {
  const [mod, elig] = await Promise.all([
    getDropStages(slug),
    getDropEligibility(slug, minterAddress, cookie),
  ]);
  if (!mod || !elig || !elig.authed) return null;

  // Index stage timing/price by stageIndex from MintModuleQuery.
  const byIndex = new Map(mod.stages.map((s) => [String(s.stageIndex), s]));

  const eligible = elig.stages
    .filter((s) => s.isEligible === true)
    .map((s) => {
      const m = byIndex.get(String(s.stageIndex)) || {};
      return {
        stageIndex: s.stageIndex,
        stageType: s.stageType || m.stageType || null,
        startTime: m.startTime ?? null,
        endTime: m.endTime ?? 0,
        priceUnit: s.priceUnit ?? m.priceUnit ?? null,
        symbol: s.symbol || m.symbol || 'ETH',
        maxPerWallet: s.maxPerWallet ?? m.maxPerWallet ?? null,
      };
    })
    .filter((s) => s.startTime != null);
  if (!eligible.length) return null;

  // Earliest start wins; tie-break cheapest.
  eligible.sort((a, b) => (a.startTime - b.startTime) || ((a.priceUnit ?? 0) - (b.priceUnit ?? 0)));
  return eligible[0];
}
