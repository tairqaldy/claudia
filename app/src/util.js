// 45s, 12m, 1h 5m — same as the daemon and the pings
export function fmtDur(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

// 06:12 or 1:04:09, for ticking timers
export function fmtClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function fmtAgo(ms) {
  if (ms < 45_000) return "now";
  if (ms < 18 * 3_600_000) return `${fmtDur(ms)} ago`;
  if (ms < 42 * 3_600_000) return "yesterday";
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export const timeOfDay = (ms) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// Fredoka has no Cyrillic, so anything that isn't Latin stays in Geist (01 Foundations → type)
export const isLatin = (text) => !/[^\u0000-ɏ -⁯\s]/.test(text ?? "");

const QUIET_MS = 5 * 60_000;

// What a session row shows, from the snapshot the daemon sends.
export function rowState(s, now) {
  if (s.status === "working") {
    const elapsed = now - (s.turnStart ?? now);
    const quiet = s.lastActivity && now - s.lastActivity > QUIET_MS;
    const over = s.usualMs && elapsed > s.usualMs;
    return {
      kind: "working",
      elapsed,
      progress: quiet ? 1 : s.usualMs ? Math.min(elapsed / s.usualMs, 1) : null,
      tone: quiet ? "quiet" : over ? "over" : "on",
      note: quiet
        ? `quiet for ${fmtDur(now - s.lastActivity)}`
        : over
          ? `${fmtDur(elapsed - s.usualMs)} over usual`
          : s.usualMs
            ? `usually ~${fmtDur(s.usualMs)}`
            : "",
    };
  }
  if (s.status === "waiting") return { kind: "needs", note: s.waitingFor ?? "" };
  if (s.status === "background") return { kind: "paused", note: `${s.background.length} background task${s.background.length === 1 ? "" : "s"}` };
  if (s.status === "failed") return { kind: "failed", note: s.lastDone?.summary ?? "" };
  if (s.lastDone) return { kind: "done", note: [s.lastDone.took ? `took ${fmtDur(s.lastDone.took)}` : "", fmtAgo(now - s.lastDone.at)].filter(Boolean).join(" · ") };
  return { kind: "idle", note: "open, nothing running" };
}
