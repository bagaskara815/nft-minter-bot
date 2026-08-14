// time.js — human-readable time formatting in WIB (Asia/Jakarta, UTC+7)
const WIB_OFFSET_MS = 7 * 3600 * 1000;
const DAYS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

const p2 = (n) => String(n).padStart(2, '0');

// Format a unix-seconds timestamp as e.g. "Rab, 12 Agu 2026 23:00 WIB".
export function fmtWIB(unixSec) {
  if (!unixSec || unixSec <= 0) return '—';
  const d = new Date(unixSec * 1000 + WIB_OFFSET_MS);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} `
    + `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())} WIB`;
}

// Format a Date/ms value in WIB.
export function fmtWIBms(ms) {
  return fmtWIB(Math.floor(ms / 1000));
}

// Human-readable relative duration, e.g. "2j 5m", "45d", "30d".
export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}d`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}d`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j ${m % 60}m`;
  const day = Math.floor(h / 24);
  return `${day}h ${h % 24}j`;
}
