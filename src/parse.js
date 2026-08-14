// parse.js — parse any mint-target input into a normalized descriptor
import { CHAIN_IDS } from './chains.js';

// Map user-facing chain aliases → canonical chain keys used in chains.js.
export function chainSlug(s) {
  if (!s) return 'ethereum';
  const map = {
    ethereum: 'ethereum', eth: 'ethereum', mainnet: 'ethereum',
    base: 'base',
    matic: 'polygon', polygon: 'polygon',
    arbitrum: 'arbitrum', arb: 'arbitrum',
    optimism: 'optimism', op: 'optimism',
    zora: 'zora-network', 'zora-network': 'zora-network',
    bsc: 'bsc', bnb: 'bsc',
    avalanche: 'avalanche', avax: 'avalanche', 'avalanche-c': 'avalanche',
    bera: 'bera', berachain: 'bera',
    peaq: 'peaq',
    'robinhood-chain': 'robinhood', robinhood: 'robinhood', rhoc: 'robinhood',
  };
  return map[s.toLowerCase()] || s.toLowerCase();
}

const ADDR = '0x[a-fA-F0-9]{40}';

// Parse an input string into a target descriptor.
// Returns one of:
//   { source:'opensea', chain, contract, tokenId?, amount }
//   { source:'opensea_slug', slug, amount }
//   { source:'manifold', claimId, amount }
//   { source:'zora', chain, contract, tokenId?, amount }
//   { source:'direct', contract, chain, amount }
export function parseTarget(input) {
  const s = String(input).trim();

  // OpenSea assets URL (trailing /N is a tokenId, not amount)
  let m = s.match(new RegExp(`opensea\\.io/assets/([\\w-]+)/(${ADDR})(?:/(\\d+))?`));
  if (m) return { source: 'opensea', chain: chainSlug(m[1]), contract: m[2], tokenId: m[3], amount: extractAmount(s) };

  // OpenSea collection URL → slug (needs contract lookup)
  m = s.match(/opensea\.io\/collection\/([\w-]+)/);
  if (m) return { source: 'opensea_slug', slug: m[1], amount: extractAmount(s), chain: findChain(stripUrls(s)) };

  // Scatter.art collection URL → slug (resolved via Scatter API).
  // Handles /collection/<slug>, /c/<slug> (short link), and bare /<slug>.
  m = s.match(/scatter\.art\/(?:collection\/|c\/)?([\w-]+)/);
  if (m) return { source: 'scatter', slug: m[1], amount: extractAmount(s) };

  // Manifold claim
  m = s.match(/manifold\.xyz\/c\/(\w+)/);
  if (m) return { source: 'manifold', claimId: m[1], amount: extractAmount(s) };

  // Zora collect URL
  m = s.match(new RegExp(`zora\\.co/collect/(\\w+):(${ADDR})(?:/(\\d+))?`));
  if (m) return { source: 'zora', chain: chainSlug(m[1]), contract: m[2], tokenId: m[3], amount: extractAmount(s) };

  // Direct: "0xABC …" with chain and amount in ANY order (plus optional "on").
  m = s.match(new RegExp(ADDR, 'i'));
  if (m) {
    const contract = m[0];
    const tail = s.slice(m.index + m[0].length);
    const { chain, amount } = parseTail(tail);
    return { source: 'direct', contract, chain, amount };
  }

  throw new Error('cannot parse mint target');
}

// Classify the whitespace-separated tokens after the address into a chain and
// an amount, independent of order. "on" is a filler word and ignored.
function parseTail(tail) {
  const tokens = tail.split(/\s+/).map((t) => t.trim()).filter(Boolean);
  let chain = null;
  let amount = null;
  for (const tok of tokens) {
    if (/^on$/i.test(tok)) continue;
    if (amount == null && /^x?\d+$/i.test(tok)) { amount = Number(tok.replace(/^x/i, '')); continue; }
    if (chain == null && !/^\d/.test(tok)) { chain = chainSlug(tok); continue; }
  }
  return { chain: chain || 'ethereum', amount: amount || 1 };
}

function stripUrls(s) {
  return s.replace(/https?:\/\/\S+/g, ' ');
}

// Find a chain alias among free-form tokens (for URL forms where the user may
// append a chain word). Returns a canonical chain or undefined.
function findChain(s) {
  for (const tok of s.split(/\s+/)) {
    if (!tok || /^\d/.test(tok) || /^x?\d+$/i.test(tok)) continue;
    const c = chainSlug(tok);
    if (c !== tok.toLowerCase() || KNOWN_CHAINS.has(c)) return c;
  }
  return undefined;
}

const KNOWN_CHAINS = new Set(Object.keys(CHAIN_IDS));

function extractAmount(s) {
  // Explicit "xN" anywhere
  let m = s.match(/(?:^|\s)x(\d+)(?:\s|$)/i);
  if (m) return Number(m[1]);
  // A standalone integer token that is NOT part of a URL path (avoid tokenId).
  const cleaned = stripUrls(s);
  m = cleaned.match(/(?:^|\s)(\d+)(?:\s|$)/);
  if (m) return Number(m[1]);
  return 1;
}

export { CHAIN_IDS };
