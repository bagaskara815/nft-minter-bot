// schedule.js — timed & open-detect minting
import { fmtWIB } from './time.js';
import { getProvider } from './chains.js';
import { mintOne, mintMany } from './mint.js';
import { detectSeadrop, getPublicDrop } from './seadrop.js';
import { getSessionCookies } from './opensea-auth.js';
import { getEligibleOpenWindow } from './opensea-drop.js';

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

// Resolve the on-chain launch window for a Seadrop target. Returns
// { startTime, endTime } unix seconds (endTime 0 → open-ended), or null if the
// target isn't a configured Seadrop.
export async function resolveOpenWindow(target) {
  const provider = getProvider(target.chain);
  const sd = await detectSeadrop(target.contract, provider);
  if (!sd.version) return null;
  const drop = await getPublicDrop(sd.seadrop, target.contract, provider);
  if (!(drop.startTime > 0)) return null;
  return { startTime: drop.startTime, endTime: drop.endTime > 0 ? drop.endTime : 0 };
}

// Back-compat: just the open time (used for display). null when unknown.
export async function resolveOpenTime(target) {
  const win = await resolveOpenWindow(target);
  return win ? win.startTime : null;
}

// Mint at (or just after) an absolute unix timestamp. Delegates the full
// precise wait + hot-path landing to mintWhenOpen (startAtUnix), so waiting
// never competes with the poll watch-window. `wallets` may be one or an array.
export async function mintAt(target, wallets, whenUnix, onEvent = () => {}, opts = {}) {
  const waitMs = Math.max(0, whenUnix * 1000 - Date.now());
  onEvent({ stage: 'scheduled', when: whenUnix, waitMs, wib: fmtWIB(whenUnix) });
  return mintWhenOpen(target, wallets, onEvent, { ...opts, startAtUnix: whenUnix });
}

// Tunables adopted from osnm-z:
//   HOT_LEAD_MS   — wake precisely this long before open, then busy-sleep to the
//                   exact second (osnm-z CALLDATA_HOT_LEAD_MS = 2000).
//   REFRESH_MS    — while waiting far out, re-probe the on-chain window this
//                   often so a shifted start time is picked up (StageChanged).
const HOT_LEAD_MS = 2000;
const REFRESH_MS = 30_000;

const CLOSED_RE = /not active|belum aktif|notactive|not started|notstarted|notenabled|not enabled|invalidmerkleproof|invalid merkle|simulation revert|execution reverted|mint not|before start|too early/i;
const FATAL_RE = /insufficient funds|invalid private key|unknown chain|no recognized mint/i;

// Poll until the mint is actually open, then send from every wallet. For
// Seadrop, spins from `startAtUnix` (or the resolved startTime). For generic
// mints, just polls the simulation. `wallets` may be one wallet or an array.
export async function mintWhenOpen(target, wallets, onEvent = () => {}, opts = {}) {
  const list = Array.isArray(wallets) ? wallets : [wallets];

  const pollMs = opts.pollMs ?? 400;
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000; // 10 min watch window (polling phase only)
  // Injectable for tests; defaults to the real engine. Prod behavior unchanged.
  const attemptMint = opts.mintOne ?? mintOne;
  const attemptMany = opts.mintMany ?? mintMany;

  // Resolve the launch window. Prefer an explicit start (scheduled /ma). For
  // OpenSea drops, resolve the earliest stage THIS wallet is eligible for
  // (GTD/presale usually opens earlier and cheaper than public) via an
  // authenticated session — not the public stage. Falls back to the on-chain
  // Seadrop window for non-OpenSea / when eligibility can't be resolved.
  let openAt = opts.startAtUnix ?? null;
  let endAt = opts.endAtUnix ?? 0;
  let eligibleStage = null;
  if (openAt == null && target.source === 'opensea' && target.slug) {
    try {
      const cookie = await getSessionCookies(list[0]);
      const win = await getEligibleOpenWindow(target.slug, list[0].address, cookie);
      if (win) {
        eligibleStage = win;
        openAt = win.startTime;
        endAt = win.endTime;
        const label = win.stageType === 'PUBLIC_SALE' ? 'public'
          : win.stageType === 'SIGNED_PRESALE' ? 'presale/GTD'
          : win.stageType === 'MERKLE_PRESALE' ? 'allowlist' : `stage ${win.stageIndex}`;
        const priceTxt = win.priceUnit ? `${win.priceUnit} ${win.symbol}` : 'FREE';
        onEvent({ stage: 'eligible_stage', stageIndex: win.stageIndex, stageType: win.stageType, label, price: priceTxt, openAt: win.startTime, wib: fmtWIB(win.startTime) });
      }
    } catch { /* eligibility resolve failed → fall through to on-chain */ }
  }
  if (openAt == null) {
    try {
      const win = await resolveOpenWindow(target);
      if (win) { openAt = win.startTime; endAt = win.endTime; }
    } catch { openAt = null; }
  }

  const nowSec = () => Math.floor(Date.now() / 1000);
  if (openAt != null && endAt > 0 && nowSec() >= endAt) {
    throw new Error(`stage sudah berakhir (tutup ${fmtWIB(endAt)}) — tidak ada yang bisa di-mint`);
  }

  // Two-phase wait (osnm-z pattern):
  //  1. Coarse loop far from open — re-probe the on-chain window each REFRESH_MS
  //     so a shifted start time is picked up; abort if the drop ended meanwhile.
  //  2. Hot path — once within HOT_LEAD_MS of open, busy-sleep to the exact
  //     second so the tx is submitted on the first live block, not a poll later.
  if (openAt != null) {
    while (true) {
      if (opts.signal?.aborted) throw new Error('schedule cancelled');
      const remainingMs = openAt * 1000 - Date.now();
      if (remainingMs <= HOT_LEAD_MS) break;

      const chunk = Math.min(remainingMs - HOT_LEAD_MS, REFRESH_MS);
      onEvent({ stage: 'waiting_open', openAt, wib: fmtWIB(openAt) });
      await sleep(chunk);

      // Re-probe only when we resolved the window on-chain (no explicit start).
      // A creator can move the start; follow it. Best-effort — keep the old
      // openAt if the probe fails transiently.
      if (opts.startAtUnix == null) {
        try {
          const win = await resolveOpenWindow(target);
          if (win) {
            if (win.endTime > 0 && nowSec() >= win.endTime) {
              throw new Error(`stage sudah berakhir (tutup ${fmtWIB(win.endTime)}) — tidak ada yang bisa di-mint`);
            }
            openAt = win.startTime; endAt = win.endTime;
          }
        } catch (e) {
          if (/sudah berakhir/.test(e.message)) throw e;
        }
      }
    }

    // Warm OpenSea sessions before the hot path so login is off the critical
    // path and tokens are fresh at open. No-op for non-OpenSea targets.
    await prewarmOpensea(target, list, onEvent);

    // Hot path: sleep precisely to the open second.
    while (true) {
      if (opts.signal?.aborted) throw new Error('schedule cancelled');
      const remainingMs = openAt * 1000 - Date.now();
      if (remainingMs <= 0) break;
      await sleep(remainingMs);
    }
  } else {
    // No known open time (generic contract): warm now, poll the simulation.
    await prewarmOpensea(target, list, onEvent);
  }

  // Start the poll watch-window AFTER the wait, so the full timeout covers the
  // polling phase — never consumed by waiting for open.
  const deadline = Date.now() + timeoutMs;
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
      const first = await attemptMint(target, list[0], onEvent);
      if (list.length === 1) return [first];
      const rest = await attemptMany(target, list.slice(1), onEvent, opts);
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
