// Reads Claude Code session transcripts (JSONL). Only the tail is read, so big transcripts stay cheap.
import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";

export function readTail(path, maxBytes = 512 * 1024) {
  if (!path) return [];
  let fd;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift(); // first line is probably cut in half
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }
    return entries;
  } finally {
    closeSync(fd);
  }
}

export function lastActivity(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n")
      : "";

// A prompt the person typed. Tool results also arrive as "user" lines, so those are skipped.
function isPrompt(entry) {
  if (entry?.type !== "user" || entry.isMeta) return false;
  const c = entry.message?.content;
  if (Array.isArray(c) && c.some((b) => b?.type === "tool_result")) return false;
  return textOf(c).trim().length > 0;
}

export function lastUserPrompt(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isPrompt(entries[i])) {
      const e = entries[i];
      return { text: textOf(e.message.content).trim(), at: Date.parse(e.timestamp) || null };
    }
  }
  return null;
}

const TOOL_KIND = {
  Bash: "cmd",
  PowerShell: "cmd",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Read: "read",
  Grep: "read",
  Glob: "read",
  WebFetch: "web",
  WebSearch: "web",
  Agent: "agent",
  Task: "agent",
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function describeActivity(a) {
  const parts = [];
  if (a.cmd) parts.push(`ran ${plural(a.cmd, "command")}`);
  if (a.edit.size) parts.push(`edited ${plural(a.edit.size, "file")}`);
  if (a.read) parts.push(`looked at ${plural(a.read, "file")}`);
  if (a.web) parts.push("searched the web");
  if (a.agent) parts.push(`used ${plural(a.agent, "helper")}`);
  if (a.other) parts.push(`used ${plural(a.other, "tool")}`);
  return parts.join(" · ");
}

// The last few turns as the Mini App shows them: your prompt, one line of what the session did,
// and Claude's final message. Text Claude wrote between tool calls is folded into the activity.
export function timeline(entries, maxTurns = 3) {
  const turns = [];
  let turn = null;
  for (const e of entries) {
    if (isPrompt(e)) {
      turn = { you: textOf(e.message.content).trim(), at: Date.parse(e.timestamp) || null, texts: [], act: null };
      turns.push(turn);
      continue;
    }
    if (!turn || e?.type !== "assistant" || !Array.isArray(e.message?.content)) continue;
    for (const b of e.message.content) {
      if (b?.type === "text" && b.text.trim()) turn.texts.push(b.text.trim());
      if (b?.type === "tool_use") {
        turn.act ??= { cmd: 0, edit: new Set(), read: 0, web: 0, agent: 0, other: 0 };
        const kind = TOOL_KIND[b.name] ?? "other";
        if (kind === "edit") turn.act.edit.add(b.input?.file_path ?? b.id);
        else turn.act[kind] += 1;
      }
    }
  }
  const items = [];
  for (const t of turns.slice(-maxTurns)) {
    items.push({ type: "you", text: t.you, at: t.at });
    if (t.act) items.push({ type: "activity", text: describeActivity(t.act) });
    if (t.texts.length) items.push({ type: "claude", text: t.texts.at(-1) });
  }
  return items;
}

// The final thing Claude said in the latest turn (text only, tool calls ignored).
export function lastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (isPrompt(e)) break;
    if (e?.type === "assistant") {
      const t = textOf(e.message?.content).trim();
      if (t) return t;
    }
  }
  return "";
}
