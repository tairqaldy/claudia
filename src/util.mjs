export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function clip(text, max) {
  const s = String(text ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

// 45s, 12m, 1h 5m
export function fmtDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// "2h", "30m", "1h30m", "90" (minutes) -> ms
export function parseDuration(text, fallbackMs) {
  const s = String(text ?? "").trim().toLowerCase();
  if (!s) return fallbackMs;
  if (/^\d+$/.test(s)) return Number(s) * 60_000;
  let total = 0;
  for (const [, n, unit] of s.matchAll(/(\d+)\s*(h|m)/g)) total += Number(n) * (unit === "h" ? 3_600_000 : 60_000);
  return total || fallbackMs;
}

// quiet = { from: "01:00", to: "09:00" }; windows can wrap past midnight
export function inQuietHours(quiet, timeZone, date = new Date()) {
  if (!quiet) return false;
  const t = date.toLocaleTimeString("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return quiet.from < quiet.to ? t >= quiet.from && t < quiet.to : t >= quiet.from || t < quiet.to;
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}
