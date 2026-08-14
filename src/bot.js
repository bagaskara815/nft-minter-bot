#!/usr/bin/env node
// bot.js — Telegram NFT minter bot. Owner-guarded. Wraps the mint engine.
//
// Commands:
//   /mint <url|contract> [chain] [amount]   — detect + simulate + send + report
//   /mintat <time> | <url|contract> ...      — mint at a scheduled time
//   /mintopen <url|contract> ...             — poll on-chain open, mint the instant it opens
//   /check <url|contract> [chain]            — dry-run: detect fn/price, no send
//   /jobs                                    — list scheduled/running mint jobs
//   /cancel <id>                             — cancel a scheduled job
//   /wallet                                  — show wallet address + balances
//   /help
import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import { parseTarget } from './parse.js';
import { resolveTarget } from './resolve.js';
import { mintOne, mintMany, detectMintFunction, detectPrice } from './mint.js';
import { detectSeadrop, getPublicDrop, getAllowlistRoot, tokenStatus } from './seadrop.js';
import { getProvider, CHAIN_IDS } from './chains.js';
import { mintAt, mintWhenOpen, parseWhen, resolveOpenTime } from './schedule.js';
import { loadWallets, selectWallets, extractWalletSpec } from './wallets.js';
import { fmtWIB, fmtDuration } from './time.js';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error('[FAIL] TELEGRAM_BOT_TOKEN not set'); process.exit(1); }
if (!process.env.PRIVATE_KEY) { console.error('[FAIL] PRIVATE_KEY not set'); process.exit(1); }

// Owner allowlist: comma-separated Telegram user IDs. Empty = deny all (safe default).
const ALLOWED = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const WALLETS = loadWallets();
const wallet = WALLETS[0];
if (!wallet) { console.error('[FAIL] no wallets loaded (set PRIVATE_KEY in .env)'); process.exit(1); }
const bot = new TelegramBot(TOKEN, { polling: true });

function isAllowed(msg) {
  if (ALLOWED.length === 0) return false;
  return ALLOWED.includes(String(msg.from?.id));
}

function guard(handler) {
  return async (msg, match) => {
    if (!isAllowed(msg)) {
      await bot.sendMessage(msg.chat.id, `⛔ Not authorized. Your ID: ${msg.from?.id}`);
      return;
    }
    try {
      await handler(msg, match);
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  };
}

// In-memory registry of scheduled/running mint jobs (lost on restart).
const jobs = new Map();
let jobSeq = 0;

function addJob(meta) {
  const id = String(++jobSeq);
  jobs.set(id, { id, controller: new AbortController(), createdAt: Date.now(), ...meta });
  return jobs.get(id);
}

function fmtJob(j) {
  const when = j.whenUnix ? fmtWIB(j.whenUnix) : (j.mode === 'open' ? 'saat open' : '—');
  const w = j.wallets > 1 ? ` (${j.wallets}w)` : '';
  return `#${j.id} [${j.status}] ${j.mode} \`${j.contract}\` on ${j.chain} × ${j.amount}${w} @ ${when}`;
}

bot.onText(/^\/start$|^\/help$/, guard(async (msg) => {
  await bot.sendMessage(msg.chat.id, [
    '*NFT Minter Bot*',
    '',
    '`/mint <url|contract> [chain] [amount] [wallets:all|N]` — mint sekarang',
    '`/mintat <time> | <url|contract> … [wallets:all|N]` — mint terjadwal',
    '`/mintopen <url|contract> … [wallets:all|N]` — mint saat buka',
    '`/check <url|contract> [chain]` — dry run, no send',
    '`/jobs` · `/cancel <id>` — kelola job',
    '`/wallet` — daftar wallet + saldo',
    '',
    '*waktu*: ISO `2026-08-12T14:00`, unix, `in 5m`, `30s`, `2h`, atau `HH:MM` (WIB)',
    '*wallets*: default 1 (primary). `wallets:all`, `wallets:3`, atau `wallets:1,2` untuk multi.',
    'Chains: ethereum, base, polygon, arbitrum, optimism, zora, bsc, avalanche, bera, peaq, robinhood',
    'Auto-detect mint fn, price, gas, Seadrop v1/v2.',
  ].join('\n'), { parse_mode: 'Markdown' });
}));

bot.onText(/^\/wallet$/, guard(async (msg) => {
  const chains = Object.keys(CHAIN_IDS);
  const lines = [`👛 *${WALLETS.length} wallet* (default: primary)`, ''];
  for (let i = 0; i < WALLETS.length; i++) {
    const w = WALLETS[i];
    const bals = await Promise.allSettled(chains.map(async (chain) => {
      const bal = await getProvider(chain).getBalance(w.address);
      return { chain, bal };
    }));
    // Only show chains with a non-zero balance to keep it compact.
    const nonzero = bals
      .filter((r) => r.status === 'fulfilled' && r.value.bal > 0n)
      .map((r) => `${r.value.chain} ${ethers.formatEther(r.value.bal)}`);
    lines.push(`${i + 1}. \`${w.address}\``);
    lines.push(`   ${nonzero.length ? nonzero.join(' · ') : '(saldo 0 di semua chain)'}`);
  }
  await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
}));

bot.onText(/^\/check\s+(.+)/s, guard(async (msg, match) => {
  const target = await resolveTarget(parseTarget(match[1]));
  const provider = getProvider(target.chain);
  const signer = wallet.connect(provider);
  const amount = target.amount || 1;

  const lines = [`🔍 *Check* \`${target.contract}\` on ${target.chain} × ${amount}`, ''];

  const sd = await detectSeadrop(target.contract, provider);
  if (sd.version) {
    const drop = await getPublicDrop(sd.seadrop, target.contract, provider);
    const root = await getAllowlistRoot(sd.seadrop, target.contract, provider);
    const now = Math.floor(Date.now() / 1000);
    const active = drop.startTime <= now && (drop.endTime === 0 || drop.endTime >= now);
    const openInfo = drop.startTime > now ? `  (buka dalam ${fmtDuration(drop.startTime - now)})` : '';
    lines.push(
      `Seadrop: ${sd.version}`,
      `price/unit: ${ethers.formatEther(drop.mintPrice)} ETH`,
      `total: ${ethers.formatEther(drop.mintPrice * BigInt(amount))} ETH`,
      `status: ${active ? '🟢 ACTIVE' : '🔴 inactive'}${openInfo}`,
      `buka:  ${fmtWIB(drop.startTime)}`,
      `tutup: ${drop.endTime ? fmtWIB(drop.endTime) : 'tanpa batas'}`,
      `max/wallet: ${drop.maxPerWallet}`,
      `allowlist: ${root ? 'ya (' + root.slice(0, 10) + '…)' : 'tidak'}`,
    );
  } else {
    const st = await tokenStatus(target.contract, provider);
    try {
      const fn = await detectMintFunction(target.contract, signer, amount);
      const price = await detectPrice(target.contract, provider, amount);
      lines.push(
        'Seadrop: no (generic mint)',
        `fn: ${fn.sig}`,
        `price: ${ethers.formatEther(price)} ETH`,
      );
    } catch (e) {
      lines.push(`no recognized mint fn: ${e.message}`);
    }
    if (st.maxSupply != null) lines.push(`maxSupply: ${st.maxSupply}`);
    if (st.totalSupply != null) lines.push(`totalSupply: ${st.totalSupply}`);
  }
  await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
}));

// Shared streaming-mint runner: streams progress into one editable message,
// then posts a final receipt. `runner(onEvent)` performs the actual mint.
async function streamMint(chatId, target, runner, walletCount = 1) {
  const status = await bot.sendMessage(chatId, `⏳ \`${target.contract}\` on ${target.chain}${walletCount > 1 ? ` — ${walletCount} wallet` : ''}…`, { parse_mode: 'Markdown' });
  const log = [];
  const push = async (line) => {
    log.push(line);
    if (log.length > 14) log.shift();
    await bot.editMessageText(log.join('\n'), {
      chat_id: chatId, message_id: status.message_id, parse_mode: 'Markdown',
    }).catch(() => {});
  };

  const tag = (ev) => (ev.wallet ? ` \`${ev.wallet.slice(0, 8)}\`` : '');
  const onEvent = async (ev) => {
    switch (ev.stage) {
      case 'scheduled': await push(`🕒 dijadwalkan ${ev.wib} (${fmtDuration(ev.waitMs / 1000)} lagi)`); break;
      case 'waiting_open': await push(`⏱ buka on-chain ${ev.wib}`); break;
      case 'polling': await push(`🔁 poll tiap ${ev.pollMs}ms sampai buka`); break;
      case 'still_closed': await push(`🔒 percobaan ${ev.attempts}: ${ev.lastErr}`); break;
      case 'target': await push(`🎯${tag(ev)} \`${ev.contract}\` × ${ev.amount}`); break;
      case 'detected': await push(`🧩${tag(ev)} ${ev.fn} — 💰 ${ev.price} ETH`); break;
      case 'gas': await push(`⛽${tag(ev)} gas ${ev.gasLimit}`); break;
      case 'sent': await push(`📤${tag(ev)} \`${ev.hash}\``); break;
      case 'wallet_error': await push(`❌ \`${ev.wallet.slice(0, 8)}\` ${ev.error}`); break;
    }
  };

  const results = await runner(onEvent);
  const arr = Array.isArray(results) ? results : [results];
  const ok = arr.filter((r) => r.status === 'success').length;

  const lines = [arr.length > 1 ? `📊 *${ok}/${arr.length} MINTED*` : (arr[0].status === 'success' ? '✅ *MINTED*' : '⚠️ *REVERTED*')];
  lines.push(`contract: \`${target.contract}\` on ${target.chain}`);
  for (const r of arr) {
    if (r.status === 'error') { lines.push(`❌ \`${r.wallet.slice(0, 10)}\` ${r.error}`); continue; }
    const mark = r.status === 'success' ? '✓' : '⚠';
    lines.push(`${mark} [${r.hash.slice(0, 12)}…](${r.explorer}) · blok ${r.block}`);
  }
  await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown', disable_web_page_preview: true });
  return { ok, total: arr.length, results: arr };
}

// Pull an optional wallet spec from the command args, resolve to a wallet set.
function pickWallets(input) {
  const { spec, rest } = extractWalletSpec(input);
  const chosen = selectWallets(WALLETS, spec);
  return { chosen, rest };
}

bot.onText(/^\/mint\s+([\s\S]+)/, guard(async (msg, match) => {
  const { chosen, rest } = pickWallets(match[1]);
  const target = await resolveTarget(parseTarget(rest));
  await streamMint(msg.chat.id, target, (onEvent) => mintMany(target, chosen, onEvent), chosen.length);
}));

// /mintat <time> | <url|contract> [chain] [amount] [wallets:all|N|1,2]
// The "|" separates the time spec from the target (times may contain spaces).
bot.onText(/^\/mintat\s+([\s\S]+)/, guard(async (msg, match) => {
  const raw = match[1];
  const bar = raw.indexOf('|');
  if (bar === -1) throw new Error('usage: /mintat <time> | <url|contract> [chain] [amount] [wallets:all|N]');
  const whenSpec = raw.slice(0, bar).trim();
  const { chosen, rest: targetSpec } = pickWallets(raw.slice(bar + 1).trim());
  const whenUnix = parseWhen(whenSpec);
  if (whenUnix * 1000 <= Date.now()) throw new Error('waktu itu sudah lewat');

  const target = await resolveTarget(parseTarget(targetSpec));
  const job = addJob({ mode: 'at', whenUnix, contract: target.contract, chain: target.chain, amount: target.amount || 1, wallets: chosen.length, status: 'scheduled', chatId: msg.chat.id });

  await bot.sendMessage(msg.chat.id, `🗓 job #${job.id} dijadwalkan ${fmtWIB(whenUnix)}\n\`${target.contract}\` on ${target.chain} × ${job.amount} — ${chosen.length} wallet`, { parse_mode: 'Markdown' });

  // Fire-and-forget; streams into its own message when it triggers.
  streamMint(msg.chat.id, target, (onEvent) => {
    job.status = 'running';
    return mintAt(target, chosen, whenUnix, onEvent, { signal: job.controller.signal });
  }, chosen.length).then((r) => { job.status = r.ok === r.total ? 'done' : (r.ok ? 'partial' : 'reverted'); })
    .catch((e) => { job.status = 'failed'; bot.sendMessage(msg.chat.id, `❌ job #${job.id}: ${e.message}`); })
    .finally(() => { setTimeout(() => jobs.delete(job.id), 60_000); });
}));

// /mintopen <url|contract> [chain] [amount] [wallets:all|N] — mint on open.
bot.onText(/^\/mintopen\s+([\s\S]+)/, guard(async (msg, match) => {
  const { chosen, rest } = pickWallets(match[1]);
  const target = await resolveTarget(parseTarget(rest));
  let openAt = null;
  try { openAt = await resolveOpenTime(target); } catch { /* not seadrop */ }
  const job = addJob({ mode: 'open', whenUnix: openAt, contract: target.contract, chain: target.chain, amount: target.amount || 1, wallets: chosen.length, status: 'watching', chatId: msg.chat.id });

  const when = openAt ? fmtWIB(openAt) : 'belum diketahui (poll simulasi)';
  await bot.sendMessage(msg.chat.id, `👀 job #${job.id} pantau waktu buka: ${when}\n\`${target.contract}\` on ${target.chain} × ${job.amount} — ${chosen.length} wallet`, { parse_mode: 'Markdown' });

  streamMint(msg.chat.id, target, (onEvent) => {
    job.status = 'running';
    return mintWhenOpen(target, chosen, onEvent, { signal: job.controller.signal });
  }, chosen.length).then((r) => { job.status = r.ok === r.total ? 'done' : (r.ok ? 'partial' : 'reverted'); })
    .catch((e) => { job.status = 'failed'; bot.sendMessage(msg.chat.id, `❌ job #${job.id}: ${e.message}`); })
    .finally(() => { setTimeout(() => jobs.delete(job.id), 60_000); });
}));

bot.onText(/^\/jobs$/, guard(async (msg) => {
  const active = [...jobs.values()];
  if (!active.length) { await bot.sendMessage(msg.chat.id, 'no scheduled jobs'); return; }
  await bot.sendMessage(msg.chat.id, active.map(fmtJob).join('\n'), { parse_mode: 'Markdown' });
}));

bot.onText(/^\/cancel\s+(\S+)/, guard(async (msg, match) => {
  const job = jobs.get(match[1].trim());
  if (!job) { await bot.sendMessage(msg.chat.id, `no job #${match[1]}`); return; }
  job.controller.abort();
  job.status = 'cancelled';
  jobs.delete(job.id);
  await bot.sendMessage(msg.chat.id, `🛑 cancelled job #${job.id}`);
}));

bot.on('polling_error', (e) => console.error('[poll]', e.message));

console.log(`[BOT] up as ${wallet.address}`);
console.log(`[BOT] allowed users: ${ALLOWED.length ? ALLOWED.join(', ') : '(none — set ALLOWED_USER_IDS)'}`);
