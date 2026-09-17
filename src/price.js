// price.js — price detection, parsing, and price protection for mint operations
import { ethers } from 'ethers';
import { getProvider } from './chains.js';
import { detectSeadrop, getPublicDrop, getAllowlistRoot } from './seadrop.js';
import { checkAllowlist } from './allowlist.js';
import { getEligibleLists, pickBestList } from './scatter.js';
import { getDropStages, getEligibleOpenWindow } from './opensea-drop.js';
import { getSessionCookies } from './opensea-auth.js';

export const PRICE_READERS = [
  'function mintPrice() view returns (uint256)',
  'function price() view returns (uint256)',
  'function cost() view returns (uint256)',
  'function PRICE() view returns (uint256)',
  'function publicSalePrice() view returns (uint256)',
];

// Probe standard price reader functions on a contract.
export async function detectPrice(contract, provider, amount = 1) {
  for (const sig of PRICE_READERS) {
    try {
      const name = sig.match(/function (\w+)/)[1];
      const c = new ethers.Contract(contract, [sig], provider);
      const p = await c[name]();
      if (typeof p === 'bigint') return p * BigInt(amount);
    } catch { continue; }
  }
  return 0n;
}

// Extract optional max price specification from command string.
// Supports:
//   --max-price 0.01 | --maxprice 0.01 | max:0.01 | max=0.01 | maxprice:0.01
//   max:free | max:0 | max:0.05/unit | max:0.05total | max:any | max:unlimited
//   p:0.01 | p=0.01
export function extractMaxPriceSpec(input) {
  if (!input || typeof input !== 'string') return { spec: null, rest: input || '' };
  const valPattern = '((?:[0-9]+(?:\\.[0-9]+)?|\\.[0-9]+)(?:eth)?(?:\\/unit|total)?|free|any|none|unlimited)';
  const re = new RegExp(
    `(?:(?:^|(?<=\\s))(?:--max-price|--maxprice)|\\b(?:max-price|maxprice|max))[:=\\s]+${valPattern}\\b|\\bp[:=]${valPattern}\\b`,
    'i'
  );
  const m = input.match(re);
  if (!m) return { spec: null, rest: input.trim() };
  const val = m[1] || m[2];
  const rest = (input.slice(0, m.index) + input.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ').trim();
  return { spec: val.toLowerCase(), rest };
}

// Parse a price spec string into BigInt wei and human-readable formatting.
// amount: number of tokens being minted.
export function parsePriceSpec(spec, amount = 1) {
  if (!spec) return null;
  const s = String(spec).trim().toLowerCase();
  if (['any', 'none', 'unlimited'].includes(s)) {
    return { isUnlimited: true, maxPriceWei: null, maxPriceEth: null, display: 'nonaktif (unlimited)' };
  }
  if (s === 'free' || s === '0' || s === '0eth') {
    return {
      isUnlimited: false,
      maxPriceWei: 0n,
      maxPriceEth: '0',
      unitPriceEth: '0',
      display: 'FREE (0 ETH)',
    };
  }

  const isTotal = s.endsWith('total');
  const clean = s.replace(/eth$/, '').replace(/\/unit$/, '').replace(/total$/, '').trim();
  const num = Number(clean);
  if (Number.isNaN(num) || num < 0) {
    throw new Error(`format batas harga tidak valid: "${spec}"`);
  }

  const qty = BigInt(amount || 1);
  const parsedWei = ethers.parseEther(clean);
  const totalWei = isTotal ? parsedWei : parsedWei * qty;
  const unitWei = isTotal ? totalWei / qty : parsedWei;

  return {
    isUnlimited: false,
    maxPriceWei: totalWei,
    maxPriceEth: ethers.formatEther(totalWei),
    unitPriceEth: ethers.formatEther(unitWei),
    display: `${ethers.formatEther(totalWei)} ETH${qty > 1n ? ` (max ${ethers.formatEther(unitWei)} ETH/unit)` : ''}`,
  };
}

// Assert that actual price does not exceed max allowed price. Throws informative error.
export function assertPriceProtection({ actualPriceWei, maxPriceWei, context = '' }) {
  if (maxPriceWei == null) return;
  if (BigInt(actualPriceWei) > BigInt(maxPriceWei)) {
    const actualEth = ethers.formatEther(actualPriceWei);
    const maxEth = ethers.formatEther(maxPriceWei);
    const ctx = context ? ` [${context}]` : '';
    throw new Error(
      `proteksi harga${ctx}: harga mint (${actualEth} ETH) melebihi batas maksimum (${maxEth} ETH)`
    );
  }
}

// Resolve the current advertised price for a target across OpenSea, Seadrop, Scatter, or Generic.
// Returns { priceWei, priceEth, unitPriceEth, currency, source } or null if unknown.
export async function resolveTargetPrice(target, wallet) {
  const provider = getProvider(target.chain);
  const amount = target.amount || 1;

  // 1. Scatter
  if (target.source === 'scatter') {
    try {
      const slug = target.scatter?.slug || target.slug;
      const lists = await getEligibleLists(slug, wallet?.address);
      const list = pickBestList(lists);
      if (list) {
        const unitEth = String(list.token_price || '0');
        const unitWei = ethers.parseEther(unitEth);
        const totalWei = unitWei * BigInt(amount);
        return {
          priceWei: totalWei,
          priceEth: ethers.formatEther(totalWei),
          unitPriceEth: unitEth,
          currency: list.currency_symbol || 'ETH',
          source: `scatter "${list.name}"`,
        };
      }
    } catch { /* ignore */ }
  }

  // 2. OpenSea Drop
  if (target.source === 'opensea' && target.slug) {
    if (wallet) {
      try {
        const cookie = await getSessionCookies(wallet);
        const win = await getEligibleOpenWindow(target.slug, wallet.address, cookie);
        if (win && win.priceUnit != null) {
          const unitWei = ethers.parseEther(String(win.priceUnit));
          const totalWei = unitWei * BigInt(amount);
          return {
            priceWei: totalWei,
            priceEth: ethers.formatEther(totalWei),
            unitPriceEth: String(win.priceUnit),
            currency: win.symbol || 'ETH',
            source: `opensea ${win.stageType || 'stage'} #${win.stageIndex}`,
          };
        }
      } catch { /* ignore */ }
    }
    try {
      const drop = await getDropStages(target.slug);
      if (drop && drop.stages?.length) {
        const s = drop.stages[0];
        const unitWei = s.priceWei || 0n;
        const totalWei = unitWei * BigInt(amount);
        return {
          priceWei: totalWei,
          priceEth: ethers.formatEther(totalWei),
          unitPriceEth: String(s.priceUnit ?? 0),
          currency: s.symbol || 'ETH',
          source: `opensea stage #${s.stageIndex}`,
        };
      }
    } catch { /* ignore */ }
  }

  // 3. Seadrop
  try {
    const sd = await detectSeadrop(target.contract, provider);
    if (sd.version) {
      let unitPriceWei = null;
      let src = `seadrop ${sd.version} public`;
      if (wallet) {
        try {
          const root = await getAllowlistRoot(sd.seadrop, target.contract, provider);
          if (root) {
            const al = await checkAllowlist(sd.seadrop, target.contract, wallet.address, provider, root);
            if (al.eligible && al.mintParams?.[0] != null) {
              unitPriceWei = al.mintParams[0];
              src = `seadrop ${sd.version} allowlist`;
            }
          }
        } catch { /* ignore */ }
      }
      if (unitPriceWei == null) {
        const drop = await getPublicDrop(sd.seadrop, target.contract, provider);
        unitPriceWei = drop.mintPrice;
      }
      if (unitPriceWei != null) {
        const totalWei = unitPriceWei * BigInt(amount);
        return {
          priceWei: totalWei,
          priceEth: ethers.formatEther(totalWei),
          unitPriceEth: ethers.formatEther(unitPriceWei),
          currency: 'ETH',
          source: src,
        };
      }
    }
  } catch { /* ignore */ }

  // 4. Generic Contract
  try {
    const totalWei = await detectPrice(target.contract, provider, amount);
    return {
      priceWei: totalWei,
      priceEth: ethers.formatEther(totalWei),
      unitPriceEth: ethers.formatEther(totalWei / BigInt(amount)),
      currency: 'ETH',
      source: 'contract',
    };
  } catch {
    return null;
  }
}
