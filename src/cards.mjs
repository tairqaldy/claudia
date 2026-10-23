// How Claudia's messages look. Every task gets one card: it appears silently while the task works,
// is edited in place as it goes, and comes back with a sound when it's done or needs you. The
// layout is always the same (state and name first, one sentence of gist, nothing else), so a
// glance at the lock screen is enough. Claudia's voice only writes the gist.
import { clip, fmtDur } from "./util.mjs";

export const esc = (text) => String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const ICON = { working: "⏳", needs: "🟠", done: "✅", stuck: "🔴", paused: "⏸", failed: "🔴", ok: "✅" };

// "qn5 · checkout tests"; folder names like scratch-2026-10-15-fe816a mean nothing, so they're dropped
export function cardName(s) {
  const scratch = /^scratch-|^[0-9a-f-]{20,}$/i.test(s.project ?? "");
  if (!s.label) return s.project ?? "a session";
  return scratch ? s.label : `${s.project} · ${s.label}`;
}

const HEAD = {
  working: (name) => name,
  needs: (name) => `${name} needs you`,
  done: (name) => name,
  stuck: (name) => `${name} is stuck`,
  failed: (name) => `${name} hit an error`,
  paused: (name) => `${name} paused`,
};

// c: { state, name, took?, since?, usually?, step?, gist?, long?, hint? }
export function renderCard(c, clock = (ms) => new Date(ms).toTimeString().slice(0, 5)) {
  const head = `<b>${ICON[c.state]} ${esc(HEAD[c.state](c.name))}</b>`;
  const lines = [c.took != null && c.state !== "working" ? `${head} · ${fmtDur(c.took)}` : head];
  if (c.state === "working") {
    const usual = c.usually ? ` · usually ~${fmtDur(c.usually)}` : "";
    lines.push(c.long ? `running long: ${fmtDur(c.long)}${usual}` : `working since ${clock(c.since)}${usual}`);
    if (c.step) lines.push(`▸ ${esc(c.step)}`);
  } else if (c.gist) {
    lines.push(esc(clip(c.gist, 400)));
  }
  if (c.hint) lines.push(`<i>${esc(c.hint)}</i>`);
  return lines.join("\n");
}

// Several tasks finishing within seconds of each other arrive as one message.
export function renderBatch(cards) {
  const needs = cards.filter((c) => c.state === "needs" || c.state === "stuck" || c.state === "failed").length;
  const head = `<b>${cards.length} finished</b>${needs ? ` · ${needs} need${needs === 1 ? "s" : ""} you` : ""}`;
  const items = cards.map((c) => {
    const took = c.took != null ? ` · ${fmtDur(c.took)}` : "";
    return [`${ICON[c.state]} <b>${esc(HEAD[c.state](c.name))}</b>${took}`, c.gist ? esc(clip(c.gist, 240)) : ""].filter(Boolean).join("\n");
  });
  return [head, ...items].join("\n\n");
}

// A long command from your terminal finished.
export function renderTerminal(t) {
  const cmd = clip(t.command.replace(/\s+/g, " "), 60);
  const where = t.cwd ? ` · ${esc(t.cwd.split(/[\\/]/).filter(Boolean).pop())}` : "";
  const status = t.ok ? "" : ` failed${t.exitCode ? ` (exit ${t.exitCode})` : ""}`;
  const lines = [`<b>${t.ok ? ICON.ok : ICON.failed} ${esc(cmd)}${status}</b> · ${fmtDur(t.durationMs)}${where}`];
  const out = t.output.slice(t.ok ? -2 : -6).join("\n").trim();
  if (out) lines.push(`<pre>${esc(clip(out, 700))}</pre>`);
  if (!t.ok) lines.push("<i>reply and i'll have claude look at it</i>");
  return lines.join("\n");
}

// The pinned "right now" message: one line per live session, then today's total.
export function renderBoard({ sessions, holds = [], doneToday = { count: 0, totalMs: 0 }, away = false, now = Date.now() }) {
  const waitingOn = new Set(holds.filter((h) => h.kind !== "stop").map((h) => h.sessionId));
  const lines = [];
  for (const s of sessions) {
    const name = esc(cardName({ project: s.project, label: s.title !== s.project ? s.title : null }));
    if (s.status === "waiting" || waitingOn.has(s.id)) lines.push(`${ICON.needs} ${name} · needs you`);
    else if (s.status === "working") lines.push(`${ICON.working} ${name} · ${fmtDur(now - (s.turnStart ?? now))}`);
    else if (s.status === "background") lines.push(`${ICON.paused} ${name} · ${s.background.length} in the background`);
  }
  const head = `<b>right now</b>${away ? " · away mode" : ""}`;
  const body = lines.length ? lines.join("\n") : "all quiet";
  const today = doneToday.count ? `${ICON.done} ${doneToday.count} done today · ${fmtDur(doneToday.totalMs)} of work` : "nothing finished yet today";
  return `${head}\n${body}\n\n${today}`;
}
