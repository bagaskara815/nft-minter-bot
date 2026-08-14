// resolve.js — resolve an OpenSea slug or Scatter slug into contract + chain
import { chainSlug } from './parse.js';
import { chainKeyFromId } from './chains.js';
import { getScatterCollection } from './scatter.js';

// Uses OpenSea API v2 when OPENSEA_KEY is set, else falls back to HTML scrape.
export async function resolveOpenseaSlug(slug) {
  const key = process.env.OPENSEA_KEY;
  if (key) {
    const r = await fetch(`https://api.opensea.io/api/v2/collections/${slug}`, {
      headers: { 'x-api-key': key },
    });
    if (r.ok) {
      const j = await r.json();
      const c = j?.contracts?.[0];
      if (c?.address && !/^0x0+$/.test(c.address)) {
        return { contract: c.address, chain: chainSlug(c.chain) };
      }
    }
  }

  // Fallback: scrape the public collection page for the embedded contracts array.
  const html = await (await fetch(`https://opensea.io/collection/${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
  })).text();

  const block = html.match(/"contracts":\[[^\]]{0,500}\]/);
  if (block) {
    const addr = block[0].match(/0x[a-fA-F0-9]{40}/);
    const chainM = block[0].match(/"chain":"([\w-]+)"/);
    if (addr && !/^0x0+$/.test(addr[0])) {
      return { contract: addr[0], chain: chainSlug(chainM?.[1] || 'ethereum') };
    }
  }
  throw new Error(`could not resolve contract for slug "${slug}" (contract may not be deployed yet)`);
}

// Normalize a parsed target into { contract, chain, amount, tokenId? }.
export async function resolveTarget(target) {
  if (target.source === 'opensea_slug') {
    const { contract, chain } = await resolveOpenseaSlug(target.slug);
    // Keep the slug: OpenSea Drops (OS2) mint via GraphQL keyed by slug.
    return { ...target, source: 'opensea', slug: target.slug, contract, chain };
  }
  if (target.source === 'scatter') {
    const col = await getScatterCollection(target.slug);
    if (!col) throw new Error(`scatter collection "${target.slug}" not found (check the slug)`);
    const chain = chainKeyFromId(col.chainId);
    if (!chain) throw new Error(`scatter collection on unsupported chainId ${col.chainId}`);
    return { ...target, contract: col.address, chain, scatter: col };
  }
  if (target.source === 'manifold') {
    throw new Error('manifold claims require the claim contract; paste the 0x… contract instead');
  }
  return target;
}
