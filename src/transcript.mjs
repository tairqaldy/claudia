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
