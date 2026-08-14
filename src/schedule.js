// schedule.js — timed & open-detect minting
import { fmtWIB } from './time.js';
import { getProvider } from './chains.js';
import { mintOne, mintMany } from './mint.js';
import { detectSeadrop, getPublicDrop } from './seadrop.js';
import { getSessionCookies } from './opensea-auth.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pre-warm OpenSea SIWE sessions for all wallets so login never sits in the
// mint critical path. Tokens are valid for hours; warming during the wait
// phase means the mint moment only pays for tx-build + send. Best-effort:
// a failed warm-up is retried lazily by mintOne at mint time.
async function prewarmOpensea(target, wallets, onEvent) {
  if (target.source !== 'opensea' || !target.slug) return;
  const list = Array.isArray(wallets) ? wallets : [wallets];
  await Promise.all(list.map(async (w) => {
    try {
      await getSessionCookies(w);
      onEvent({ stage: 'allowlist', eligible: true, wallet: w.address, reason: 'opensea session pre-warmed' });
    } catch (e) {
      onEvent({ stage: 'allowlist', eligible: false, wallet: w.address, reason: `pre-warm gagal: ${e.message}` });
    }
  }));
}

// Parse a "when" spec into an absolute unix seconds timestamp.
// Accepts: unix seconds (10 digits), unix ms (13 digits), ISO 8601,
// relative "in 30s|5m|2h|1d" / "30s" / "5m", or "HH:MM" (next occurrence, WIB).
export function parseWhen(spec, nowMs = Date.now()) {
  const s = String(spec).trim().toLowerCase();

  // relative: optional leading "in "
  let m = s.match(/^(?:in\s+)?(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const mult = { s: 1, m: 60, h: 3600, d: 86400 }[unit];
    return Math.floor(nowMs / 1000) + n * mult;
  }

  // unix ms
  if (/^\d{13}$/.test(s)) return Math.floor(Number(s) / 1000);
  // unix seconds
  if (/^\d{10}$/.test(s)) return Number(s);

  // HH:MM — interpreted as WIB (UTC+7), next occurrence.
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const WIB = 7 * 3600 * 1000;
    // Shift into WIB wall-clock, set the hh:mm there, shift back to UTC.
    const d = new Date(nowMs + WIB);
    d.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
    let t = Math.floor((d.getTime() - WIB) / 1000);
    if (t * 1000 <= nowMs) t += 86400; // already passed today → tomorrow
    return t;
  }

  // ISO / Date-parseable
  const parsed = Date.parse(spec);
  if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);

  throw new Error(`cannot parse time: "${spec}"`);
}

// Resolve the on-chain open time for a Seadrop target (startTime). Returns
// unix seconds, or null if not Seadrop / not configured.
export async function resolveOpenTime(target) {
  const provider = getProvider(target.chain);
  const sd = await detectSeadrop(target.contract, provider);
  if (!sd.version) return null;
  const drop = await getPublicDrop(sd.seadrop, target.contract, provider);
  return drop.startTime > 0 ? drop.startTime : null;
}

// Mint at (or just after) an absolute unix timestamp. Coarse-sleeps until a
// short lead before the target, then hands off to the open-poll loop so the
// tx lands on the first simulatable block. `wallets` may be one wallet or an
// array; returns an array of per-wallet results.
export async function mintAt(target, wallets, whenUnix, onEvent = () => {}, opts = {}) {
  const leadMs = opts.leadMs ?? 1500;
  const now = Date.now();
  const targetMs = whenUnix * 1000;
  const waitMs = Math.max(0, targetMs - now - leadMs);

  onEvent({ stage: 'scheduled', when: whenUnix, waitMs, wib: fmtWIB(whenUnix) });

  // Coarse wait in <=15s chunks so a cancelled job/process notices sooner.
  let remaining = waitMs;
  while (remaining > 0) {
    if (opts.signal?.aborted) throw new Error('schedule cancelled');
    const chunk = Math.min(remaining, 15000);
    await sleep(chunk);
    remaining -= chunk;
  }
  return mintWhenOpen(target, wallets, onEvent, { ...opts, startAtUnix: whenUnix });
}

const CLOSED_RE = /not active|belum aktif|notactive|not started|notstarted|notenabled|not enabled|invalidmerkleproof|invalid merkle|simulation revert|execution reverted|mint not|before start|too early/i;
const FATAL_RE = /insufficient funds|invalid private key|unknown chain|no recognized mint/i;

// Poll until the mint is actually open, then send from every wallet. For
// Seadrop, spins from `startAtUnix` (or the resolved startTime). For generic
// mints, just polls the simulation. `wallets` may be one wallet or an array.
export async function mintWhenOpen(target, wallets, onEvent = () => {}, opts = {}) {
  const list = Array.isArray(wallets) ? wallets : [wallets];

  const pollMs = opts.pollMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 10 min default watch window
  const deadline = Date.now() + timeoutMs;

  // Determine the earliest sensible poll moment.
  let openAt = opts.startAtUnix ?? null;
  if (openAt == null) {
    try { openAt = await resolveOpenTime(target); } catch { openAt = null; }
  }
  if (openAt != null) {
    const leadMs = opts.leadMs ?? 1500;
    const preWait = openAt * 1000 - Date.now() - leadMs;
    if (preWait > 0) {
      onEvent({ stage: 'waiting_open', openAt, wib: fmtWIB(openAt) });
      let rem = preWait;
      while (rem > 0) {
        if (opts.signal?.aborted) throw new Error('schedule cancelled');
        const chunk = Math.min(rem, 15000);
        await sleep(chunk);
        rem -= chunk;
      }
    }
  }

  // Warm OpenSea sessions now (after the coarse wait) so tokens are fresh and
  // login is off the mint critical path. No-op for non-OpenSea targets.
  await prewarmOpensea(target, list, onEvent);

  onEvent({ stage: 'polling', pollMs });

  let attempts = 0;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new Error('schedule cancelled');
    attempts += 1;
    try {
      // Probe openness with the first wallet. A fatal (non-timing) error
      // aborts; a closed-style revert means keep polling; success means open
      // → fan out to the remaining wallets.
      const first = await mintOne(target, list[0], onEvent);
      if (list.length === 1) return [first];
      const rest = await mintMany(target, list.slice(1), onEvent, opts);
      return [first, ...rest];
    } catch (e) {
      lastErr = e.shortMessage || e.message;
      if (FATAL_RE.test(lastErr) && !CLOSED_RE.test(lastErr)) throw e;
      if (attempts % 10 === 0) onEvent({ stage: 'still_closed', attempts, lastErr });
      await sleep(pollMs);
    }
  }
  throw new Error(`watch window elapsed (${attempts} attempts). last: ${lastErr}`);
}
