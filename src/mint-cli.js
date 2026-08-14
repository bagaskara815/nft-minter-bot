#!/usr/bin/env node
// mint-cli.js — CLI entrypoint
//   node src/mint-cli.js <url|contract> [chain] [amount]
//   node src/mint-cli.js --at "2026-08-12T14:00" <url|contract> [chain] [amount]
//   node src/mint-cli.js --at "in 5m" <url|contract> ...
//   node src/mint-cli.js --when-open <url|contract> ...   (poll on-chain open time)
//   node src/mint-cli.js --wallets all <url|contract> ... (multi-wallet; default single)
import 'dotenv/config';
import { parseTarget } from './parse.js';
import { resolveTarget } from './resolve.js';
import { mintOne, mintMany } from './mint.js';
import { mintAt, mintWhenOpen, parseWhen } from './schedule.js';
import { fmtDuration } from './time.js';
import { loadWallets, selectWallets } from './wallets.js';

function parseFlags(argv) {
  const out = { at: null, whenOpen: false, wallets: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--at') { out.at = argv[++i]; }
    else if (a === '--when-open' || a === '--open') { out.whenOpen = true; }
    else if (a === '--wallets' || a === '-w') { out.wallets = argv[++i]; }
    else out.rest.push(a);
  }
  return out;
}

function logEvent(ev) {
  const w = ev.wallet ? ` {${ev.wallet.slice(0, 8)}}` : '';
  switch (ev.stage) {
    case 'scheduled': console.log(`[SCHED]  ${ev.wib} (tunggu ${fmtDuration(ev.waitMs / 1000)})`); break;
    case 'waiting_open': console.log(`[WAIT]   buka on-chain ${ev.wib}`); break;
    case 'polling': console.log(`[POLL]   every ${ev.pollMs}ms until open`); break;
    case 'still_closed': console.log(`[CLOSED] attempt ${ev.attempts}: ${ev.lastErr}`); break;
    case 'target': console.log(`[TARGET]${w} ${ev.contract} on ${ev.chain} × ${ev.amount}`); break;
    case 'detected': console.log(`[FN]${w}     ${ev.fn}  ${ev.price} ETH`); break;
    case 'gas': console.log(`[GAS]${w}    limit ${ev.gasLimit}`); break;
    case 'sent': console.log(`[SENT]${w}   ${ev.hash}`); break;
    case 'wallet_error': console.log(`[ERR]    {${ev.wallet.slice(0, 8)}} ${ev.error}`); break;
  }
}

function report(results) {
  const arr = Array.isArray(results) ? results : [results];
  const ok = arr.filter((r) => r.status === 'success').length;
  console.log(`\n[DONE] ${ok}/${arr.length} minted`);
  for (const r of arr) {
    if (r.status === 'error') { console.log(`  ✗ ${r.wallet}: ${r.error}`); continue; }
    console.log(`  ${r.status === 'success' ? '✓' : '⚠'} ${r.hash}  block ${r.block}  gas ${r.gasUsed}`);
    console.log(`    ${r.explorer}`);
  }
}

async function main() {
  const { at, whenOpen, wallets: walletSpec, rest } = parseFlags(process.argv.slice(2));
  const input = rest.join(' ');
  if (!input) {
    console.error('usage: node src/mint-cli.js [--at <time>] [--when-open] [--wallets all|N|1,2] <url|contract> [chain] [amount]');
    console.error('  --at <time>       ISO 8601, unix, "in 5m", "30s", or "HH:MM" (WIB)');
    console.error('  --when-open       poll on-chain open time, mint the instant it opens');
    console.error('  --wallets <spec>  all | N | 1,3 (default: single primary wallet)');
    process.exit(1);
  }

  const all = loadWallets();
  if (!all.length) { console.error('[FAIL] no wallets (set PRIVATE_KEY in .env)'); process.exit(1); }
  const chosen = selectWallets(all, walletSpec);
  console.log(`[WALLETS] ${chosen.length}/${all.length} — ${chosen.map((w) => w.address.slice(0, 8)).join(', ')}`);

  const target = await resolveTarget(parseTarget(input));

  let result;
  if (at) {
    result = await mintAt(target, chosen, parseWhen(at), logEvent);
  } else if (whenOpen) {
    result = await mintWhenOpen(target, chosen, logEvent);
  } else {
    result = await mintMany(target, chosen, logEvent);
  }
  report(result);
}

main().catch((e) => { console.error(`[FAIL] ${e.message}`); process.exit(1); });
