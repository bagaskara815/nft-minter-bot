// wallets.js — load & select minting wallets (optional multi-wallet)
import { ethers } from 'ethers';
import fs from 'node:fs';

// Load all configured wallets, deduped by address, in priority order:
//   1. PRIVATE_KEY            (primary, required for any minting)
//   2. PRIVATE_KEYS           (comma-separated extras)
//   3. WALLETS_FILE / wallets.json  (["0x..pk", {"pk":"0x.."}])
export function loadWallets() {
  const list = [];
  const seen = new Set();
  const add = (pk) => {
    if (!pk || typeof pk !== 'string') return;
    let w;
    try { w = new ethers.Wallet(pk.trim()); } catch { return; }
    if (seen.has(w.address)) return;
    seen.add(w.address);
    list.push(w);
  };

  add(process.env.PRIVATE_KEY);
  (process.env.PRIVATE_KEYS || '').split(',').forEach(add);

  const file = process.env.WALLETS_FILE || 'wallets.json';
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const arr = Array.isArray(j) ? j : (j.wallets || []);
      for (const e of arr) add(typeof e === 'string' ? e : (e.pk || e.privateKey));
    }
  } catch { /* ignore malformed wallets file */ }

  return list;
}

// Select a subset from the loaded wallets by spec:
//   null / '' / undefined → [primary]  (default: single wallet)
//   'all' | '*'           → every wallet
//   'N' (integer)         → first N wallets
//   '1,3,4'               → 1-based indices
export function selectWallets(all, spec) {
  if (!all.length) throw new Error('no wallets loaded (set PRIVATE_KEY in .env)');
  if (spec == null || spec === '') return [all[0]];

  const s = String(spec).trim().toLowerCase();
  if (s === 'all' || s === '*') return all;
  if (/^\d+$/.test(s)) return all.slice(0, Math.max(1, Math.min(Number(s), all.length)));
  if (/^[\d,\s]+$/.test(s)) {
    const idx = s.split(',')
      .map((x) => Number(x.trim()) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < all.length);
    if (idx.length) return idx.map((i) => all[i]);
  }
  return [all[0]];
}

// Extract an optional wallet spec from a command string, returning the spec
// and the remaining input with the token stripped. Supports:
//   --wallets all | wallets:all | wallets=3 | wallets 3 | w:1,2 | w=all
// The bare `w` shorthand REQUIRES `:`/`=` (never a space) so trailing words
// ending in "w" (e.g. ".../overview 10") aren't mistaken for a spec.
export function extractWalletSpec(input) {
  const val = '(all|\\*|\\d+(?:\\s*,\\s*\\d+)*)';
  // Full keyword: allows space/colon/equals. Bare `w`: colon/equals only.
  const re = new RegExp(`(?:\\b(?:--wallets|wallets)[:=\\s]+|\\bw[:=])${val}\\b`, 'i');
  const m = input.match(re);
  if (!m) return { spec: null, rest: input.trim() };
  const rest = (input.slice(0, m.index) + input.slice(m.index + m[0].length))
    .replace(/\s+/g, ' ').trim();
  return { spec: m[1].replace(/\s+/g, ''), rest };
}
