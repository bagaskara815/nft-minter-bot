// scatter.js — Scatter.art launchpad integration via the public API.
//
// Scatter contracts use a custom mint(auth, quantity, affiliate, signature)
// entrypoint, so generic mint-selector probing does NOT work. Instead the
// public API resolves the collection, the wallet's eligible mint lists, and
// builds the exact mint transaction (proof + signature included). No API key.
const SCATTER_API = 'https://api.scatter.art/v1';

// Sentinel the contract uses for "unlimited" wallet/list limits (uint32 max).
export const SCATTER_UNLIMITED = 4294967295;

// Fetch a collection by slug. Returns null when it isn't a Scatter collection
// (404) or the API is unreachable. Only slugs resolve — the API has no
// address lookup, so callers pass the collection's Scatter slug.
export async function getScatterCollection(slug) {
  try {
    const r = await fetch(`${SCATTER_API}/collection/${encodeURIComponent(slug)}`);
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.address) return null;
    return {
      address: j.address,
      chainId: j.chain_id,
      name: j.name,
      maxItems: j.max_items,
      numItems: j.num_items,
      slug,
    };
  } catch {
    return null;
  }
}

// Fetch the mint lists a wallet is eligible for. Without minterAddress the API
// returns public lists only. Returns [] on error (treated as "no lists").
export async function getEligibleLists(slug, minterAddress) {
  const url = `${SCATTER_API}/collection/${encodeURIComponent(slug)}/eligible-invite-lists${
    minterAddress ? `?minterAddress=${minterAddress}` : ''
  }`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

// A list is "public" when its currency is native and it has no wallet gate we
// can't satisfy. We surface all eligible lists; the picker chooses.
const NATIVE = '0x0000000000000000000000000000000000000000';

export function isNativeList(list) {
  return !list.currency_address || list.currency_address.toLowerCase() === NATIVE;
}

// Choose the best list to mint from among eligible lists: cheapest native-token
// list wins (free > paid), tie-break by earliest start. ERC20-priced lists are
// only chosen when no native list exists. Returns null when none are eligible.
export function pickBestList(lists) {
  if (!lists.length) return null;
  const priced = lists
    .map((l) => ({ list: l, price: Number(l.token_price ?? 0), native: isNativeList(l) }))
    .sort((a, b) => {
      if (a.native !== b.native) return a.native ? -1 : 1; // native first
      if (a.price !== b.price) return a.price - b.price;    // cheapest first
      return new Date(a.list.start_time || 0) - new Date(b.list.start_time || 0);
    });
  return priced[0].list;
}

// Build the mint transaction via the API. Returns { to, value, data, erc20s }.
// `lists` is [{ id, quantity }]. affiliate is an optional shill address.
export async function buildScatterMint({ collectionAddress, chainId, minterAddress, lists, affiliate }) {
  const body = { collectionAddress, chainId, minterAddress, lists };
  if (affiliate) body.affiliateAddress = affiliate;

  const r = await fetch(`${SCATTER_API}/mint`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`scatter /mint ${r.status}: ${txt.slice(0, 200)}`);
  }
  const j = await r.json();
  if (!j?.mintTransaction?.to) throw new Error('scatter /mint: no mintTransaction in response');
  return {
    to: j.mintTransaction.to,
    value: BigInt(j.mintTransaction.value || 0),
    data: j.mintTransaction.data,
    erc20s: Array.isArray(j.erc20s) ? j.erc20s : [],
  };
}
