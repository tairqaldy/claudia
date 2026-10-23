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

// ---- Live activity: what the current turn is doing ("▸ running the tests" on a card,
// and the answer to "what's qn5 doing?"). Only the turn after the latest prompt counts.

const str = (v) => (typeof v === "string" ? v.trim() : "");
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const baseName = (p) => (typeof p === "string" ? (p.split(/[\\/]/).filter(Boolean).at(-1) ?? "") : "");

// The command as people would recognise it: its first line, without a leading `cd somewhere &&`.
function shortCmd(command) {
  const line = str(command).split("\n").find((l) => l.trim()) ?? "";
  return line.trim().replace(/^(?:cd|Set-Location|Push-Location|pushd)\s+(?:\/d\s+)?("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, "");
}

const cmdLabel = (input) => clip(str(input.description), 80) || clip(shortCmd(input.command), 60) || "a command";

const NOT_VERBS = new Set(["git", "node", "docker", "vite", "vitest", "jest", "cargo", "python", "pip", "go", "gh", "yarn", "bun", "deno", "tsc", "eslint", "prettier", "playwright", "curl", "the", "a", "an", "all"]);
const DOUBLE = new Set(["commit", "submit", "rerun", "reset", "begin", "forget", "refer", "prefer", "admit", "omit"]);

// "Run the tests" -> "running the tests", "Type-check" -> "type-checking". Descriptions are imperative;
// a status line reads better in -ing.
function gerund(desc) {
  const m = /^((?:[a-z]+-)*)([a-z]+)(\s[\s\S]*)?$/i.exec(desc);
  if (!m || !/[aeiouy]/i.test(m[2])) return null; // "npm install": not a verb we can bend
  const v = m[2].toLowerCase();
  if (NOT_VERBS.has(v)) return `running ${lowerFirst(desc)}`; // "Git status", not "gitting status"
  const stem = DOUBLE.has(v) || /^[^aeiou]*[aeiou][^aeiouwxy]$/.test(v) ? v + v.at(-1) : /[^e]e$/.test(v) ? v.slice(0, -1) : v;
  return `${m[1].toLowerCase()}${stem}ing${m[3] ?? ""}`;
}

function running(input) {
  const d = gerund(str(input.description));
  if (d) return clip(d, 60);
  const cmd = shortCmd(input.command);
  return cmd ? `running ${clip(cmd, 50)}` : "running a command";
}

const DOING = {
  Grep: "searching the code",
  Glob: "looking for files",
  WebSearch: "searching the web",
  WebFetch: "reading a web page",
  AskUserQuestion: "asking you a question",
  ExitPlanMode: "waiting for you to approve the plan",
  TodoWrite: "updating its to-do list",
};

// A tool call that hasn't come back yet, in a few plain words.
function doing({ name, input }) {
  const kind = TOOL_KIND[name];
  if (kind === "cmd") return running(input);
  if (kind === "edit") return `editing ${baseName(input.file_path ?? input.notebook_path) || "a file"}`;
  if (name === "Read") return input.file_path ? `reading ${baseName(input.file_path)}` : "reading files";
  if (kind === "agent") {
    const d = clip(str(input.description), 60);
    return d ? `waiting on a helper: ${lowerFirst(d)}` : "waiting on a helper";
  }
  if (Object.hasOwn(DOING, name)) return DOING[name];
  const mcp = /^mcp__(.+?)__/.exec(name);
  if (mcp) return /^[0-9a-f]{8}-/.test(mcp[1]) ? "using a connector" : `using ${mcp[1].replace(/^plugin_/, "").replace(/[_-]+/g, " ").toLowerCase()}`;
  return `using ${name.toLowerCase()}`;
}

function lastMatch(s, re) {
  let last = null;
  for (const m of s.matchAll(re)) last = m;
  return last;
}
const num = (line, word) => Number(new RegExp(`(\\d+) ${word}`).exec(line)?.[1] ?? 0);

// The latest test-run summary in a command's output. Only the last 4 KB is scanned, so huge logs stay cheap.
function testSummary(text) {
  const s = text.slice(-4096).replace(/\x1b\[[\d;]*m/g, "");
  // node:test: "ℹ pass 43" (spec reporter) or "# pass 43" (tap)
  const pass = lastMatch(s, /^[ \t]*[ℹ#] pass (\d+)/gm);
  const fail = lastMatch(s, /^[ \t]*[ℹ#] fail (\d+)/gm);
  if (pass || fail) return { passed: Number(pass?.[1] ?? 0), failed: Number(fail?.[1] ?? 0) };
  // vitest "Tests  2 failed | 40 passed (42)", jest "Tests:  1 failed, 41 passed, 42 total"
  const tl = lastMatch(s, /^[ \t]*Tests:?[ \t]+([^\n]*)/gm)?.[1] ?? "";
  if (/\d+ (passed|failed)/.test(tl)) return { passed: num(tl, "passed"), failed: num(tl, "failed") };
  // cargo "test result: ok. 12 passed; 0 failed", one line per test binary
  const cargo = [...s.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return { passed: cargo.reduce((n, m) => n + Number(m[1]), 0), failed: cargo.reduce((n, m) => n + Number(m[2]), 0) };
  // pytest "3 failed, 40 passed in 2.1s"
  const py = lastMatch(s, /^[ =]*(\d+ \w+(?:, \d+ \w+)*) in [\d.]+s/gm)?.[1] ?? "";
  if (/\d+ (passed|failed|errors?)\b/.test(py)) return { passed: num(py, "passed"), failed: num(py, "failed") + num(py, "errors?") };
  // playwright "5 passed (12s)" / "1 failed", mocha "42 passing" / "1 failing"
  const pw = lastMatch(s, /^[ \t]*(\d+) (?:passed|passing)\b/gm);
  const pf = lastMatch(s, /^[ \t]*(\d+) (?:failed|failing)\b/gm);
  if (pw || pf) return { passed: Number(pw?.[1] ?? 0), failed: Number(pf?.[1] ?? 0) };
  // go test: one "ok" / "FAIL" line per package
  const ok = [...s.matchAll(/^ok[ \t]+\S+[ \t]+(?:[\d.]+s|\(cached\))/gm)].length;
  const bad = [...s.matchAll(/^FAIL[ \t]+\S+[ \t]+(?:[\d.]+s|\[)/gm)].length;
  return ok || bad ? { passed: ok, failed: bad } : null;
}

const testText = ({ passed, failed }) => (failed ? `tests: ${failed} failed, ${passed} passed` : `tests: ${passed} passed`);

function resultText(b, e) {
  const t = textOf(b.content);
  if (t) return t;
  const r = e.toolUseResult;
  if (typeof r === "string") return r;
  return [r?.stdout, r?.stderr].filter((x) => typeof x === "string" && x).join("\n");
}

// The first line of an error worth showing: no <tool_use_error> tags, no bare "Exit code 1".
function firstLine(text) {
  for (const line of text.slice(0, 4096).split("\n")) {
    const t = line.replace(/<\/?[\w-]+>/g, "").trim();
    if (t && !/^Exit code \d+$/.test(t)) return clip(t, 120);
  }
  return "";
}

function onToolUse(st, b, at) {
  const call = { name: typeof b.name === "string" ? b.name : "tool", input: b.input && typeof b.input === "object" ? b.input : {}, ev: null };
  if (b.id) st.calls.set(b.id, call);
  st.open.add(call);
  const { name, input } = call;
  const kind = TOOL_KIND[name];
  if (kind === "cmd") {
    st.counts.commands += 1;
    call.ev = { at, kind: input.run_in_background === true ? "background" : "command", text: cmdLabel(input) };
  } else if (kind === "agent") {
    call.ev = { at, kind: "agent", text: clip(str(input.description), 80) || "a helper" };
  } else if (kind === "edit") {
    st.counts.edits += 1;
    const f = baseName(input.file_path ?? input.notebook_path);
    if (f) st.edited.push(f);
  } else if (kind === "read") st.counts.reads += 1;
  if (call.ev) st.events.push(call.ev);
}

function onResult(st, b, e, at) {
  const call = st.calls.get(b.tool_use_id);
  if (call) st.open.delete(call);
  const out = resultText(b, e);
  if (call?.ev?.kind === "command") {
    const t = testSummary(out);
    if (t) {
      st.tests = { ...t, at };
      Object.assign(call.ev, { kind: "test", text: testText(t), ok: t.failed === 0 });
      return; // a failing run is reported here, not again as an error
    }
  }
  const failed = b.is_error === true || /^Exit code [1-9]/.test(out) || e.toolUseResult?.interrupted === true;
  if (call?.ev) call.ev.ok = !failed;
  if (b.is_error === true) st.events.push({ at, kind: "error", text: firstLine(out) || `${call?.name ?? "a tool"} failed`, ok: false });
}

function step(st, e, b, at) {
  if (e.type === "assistant") {
    if (b?.type !== "text" && b?.type !== "thinking" && b?.type !== "tool_use") return;
    if (b.type === "text" && !str(b.text)) return;
    // A new step means earlier calls are finished, even if their results were cut off.
    // Calls made back to back (in parallel) stay open together.
    if (st.last !== "tool") st.open.clear();
    st.last = b.type === "tool_use" ? "tool" : b.type;
    if (b.type === "tool_use") onToolUse(st, b, at);
  } else if (b?.type === "tool_result") {
    st.last = "result";
    onResult(st, b, e, at);
  }
}

function nowOf(st) {
  if (st.last === "text") return "writing";
  if (st.last === "thinking") return "thinking";
  const open = [...st.open];
  if (open.length > 1 && open.every((c) => TOOL_KIND[c.name] === "read")) return "reading files";
  if (open.length) return doing(open.at(-1));
  return st.last ? "thinking" : null; // results are in; Claude is deciding what's next
}

export function activity(entries, { max = 8 } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  let start = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    if (isPrompt(list[i])) {
      start = i + 1;
      break;
    }
  }
  const st = { calls: new Map(), open: new Set(), last: null, events: [], tests: null, edited: [], counts: { commands: 0, edits: 0, reads: 0 } };
  for (let i = start; i < list.length; i++) {
    const e = list[i];
    if (!e || typeof e !== "object" || e.isSidechain) continue;
    const c = e.message?.content;
    const blocks = typeof c === "string" ? [{ type: "text", text: c }] : Array.isArray(c) ? c : [];
    const at = Date.parse(e.timestamp) || null;
    for (const b of blocks) {
      try {
        step(st, e, b, at);
      } catch {} // one odd line never breaks the card
    }
  }
  const files = [];
  for (let i = st.edited.length - 1; i >= 0 && files.length < 10; i--) {
    if (!files.includes(st.edited[i])) files.push(st.edited[i]);
  }
  return { now: nowOf(st), events: max > 0 ? st.events.slice(-max) : [], tests: st.tests, files, counts: st.counts };
}
