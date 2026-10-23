import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { activity, lastAssistantText, lastUserPrompt, readTail } from "../src/transcript.mjs";
import { fmtDur, inQuietHours, parseDuration } from "../src/util.mjs";

const entries = [
  { type: "user", timestamp: "2026-10-22T10:00:00Z", message: { content: "old task" } },
  { type: "assistant", message: { content: [{ type: "text", text: "old answer" }] } },
  { type: "user", timestamp: "2026-10-22T11:00:00Z", message: { content: [{ type: "text", text: "new task" }] } },
  { type: "assistant", message: { content: [{ type: "text", text: "working on it" }, { type: "tool_use", name: "Bash" }] } },
  { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
  { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } },
];

test("finds the latest typed prompt, skipping tool results", () => {
  assert.deepEqual(lastUserPrompt(entries), { text: "new task", at: Date.parse("2026-10-22T11:00:00Z") });
});

test("final text comes from the latest turn only", () => {
  assert.equal(lastAssistantText(entries), "working on it");
  assert.equal(lastAssistantText(entries.slice(0, 3)), "");
});

test("reads the tail of a jsonl file and skips a cut-off first line", () => {
  const file = join(mkdtempSync(join(tmpdir(), "claudia-")), "t.jsonl");
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  assert.equal(readTail(file).length, entries.length);
  const tail = readTail(file, 200);
  assert.ok(tail.length > 0 && tail.length < entries.length);
  assert.deepEqual(readTail(join(tmpdir(), "missing.jsonl")), []);
});

test("durations read like a person would say them", () => {
  assert.equal(fmtDur(45_000), "45s");
  assert.equal(fmtDur(12 * 60_000), "12m");
  assert.equal(fmtDur(65 * 60_000), "1h 5m");
  assert.equal(parseDuration("2h", 0), 7_200_000);
  assert.equal(parseDuration("1h30m", 0), 5_400_000);
  assert.equal(parseDuration("45", 0), 2_700_000);
  assert.equal(parseDuration("", 99), 99);
});

test("quiet hours work across midnight", () => {
  const at = (hhmm) => new Date(`2026-10-22T${hhmm}:00Z`);
  const night = { from: "23:00", to: "08:00" };
  assert.equal(inQuietHours(night, "UTC", at("23:30")), true);
  assert.equal(inQuietHours(night, "UTC", at("07:59")), true);
  assert.equal(inQuietHours(night, "UTC", at("08:00")), false);
  assert.equal(inQuietHours({ from: "13:00", to: "14:00" }, "UTC", at("13:15")), true);
  assert.equal(inQuietHours(null, "UTC", at("13:15")), false);
});

// Fake transcript lines for activity(): each one a second after the last.
let clock = Date.parse("2026-10-23T09:00:00Z");
const ts = () => new Date((clock += 1000)).toISOString();
const prompt = (text) => ({ type: "user", timestamp: ts(), message: { content: text } });
const say = (text) => ({ type: "assistant", timestamp: ts(), message: { content: [{ type: "text", text }] } });
const use = (id, name, input = {}) => ({ type: "assistant", timestamp: ts(), message: { content: [{ type: "tool_use", id, name, input }] } });
const result = (id, content, extra = {}) => ({ type: "user", timestamp: ts(), message: { content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] } });
const atOf = (e) => Date.parse(e.timestamp);

test("activity: a passing then a failing vitest run, the latest one wins", () => {
  const run1 = use("b1", "Bash", { command: "npx vitest run", description: "Run the unit tests" });
  const run2 = use("b2", "Bash", { command: "npx vitest run", description: "Rerun the unit tests" });
  const fail = result("b2", "Exit code 1\n FAIL  src/a.test.ts\n Test Files  1 failed | 3 passed (4)\n      Tests  2 failed | 40 passed (42)\n   Duration  1.2s", { is_error: true });
  const a = activity([
    prompt("fix the flaky tests"),
    run1,
    result("b1", " Test Files  4 passed (4)\n      Tests  42 passed (42)\n"),
    run2,
    fail,
    say("Two tests fail now; looking."),
  ]);
  assert.deepEqual(a.tests, { passed: 40, failed: 2, at: atOf(fail) });
  assert.deepEqual(a.events, [
    { at: atOf(run1), kind: "test", text: "tests: 42 passed", ok: true },
    { at: atOf(run2), kind: "test", text: "tests: 2 failed, 40 passed", ok: false }, // no extra "error" for a test failure
  ]);
  assert.equal(a.now, "writing");
  assert.deepEqual(a.counts, { commands: 2, edits: 0, reads: 0 });
});

// The test summary activity() finds in one command's output.
const testsIn = (content, extra) => activity([prompt("go"), use("t", "Bash", { command: "test" }), result("t", content, extra)]).tests;

test("activity: reads node:test and the other common runners' summaries", () => {
  const pick = (t) => t && { passed: t.passed, failed: t.failed };
  assert.deepEqual(pick(testsIn("✔ a (1ms)\nℹ tests 43\nℹ suites 0\nℹ pass 43\nℹ fail 0\nℹ cancelled 0\r\n")), { passed: 43, failed: 0 });
  assert.deepEqual(pick(testsIn("ok 1 - a\nnot ok 2 - b\n# tests 2\n# pass 1\n# fail 1\n")), { passed: 1, failed: 1 });
  assert.deepEqual(pick(testsIn("Tests:       1 failed, 41 passed, 42 total\nTime: 2.1 s")), { passed: 41, failed: 1 });
  assert.deepEqual(pick(testsIn("===== 3 failed, 40 passed, 2 warnings in 2.10s =====")), { passed: 40, failed: 3 });
  assert.deepEqual(pick(testsIn("  1 failed\n    [chromium] › a.spec.ts:3:1 › login\n  5 passed (12.3s)")), { passed: 5, failed: 1 });
  assert.deepEqual(pick(testsIn("ok  \tgithub.com/x/a\t0.012s\nok  \tgithub.com/x/b\t(cached)\nFAIL\tgithub.com/x/c\t0.3s\nFAIL")), { passed: 2, failed: 1 });
  assert.deepEqual(pick(testsIn("test result: ok. 12 passed; 0 failed; 0 ignored\ntest result: FAILED. 3 passed; 1 failed; 0 ignored")), { passed: 15, failed: 1 });
  assert.deepEqual(pick(testsIn("", { content: [] })), null);
  assert.equal(testsIn("added 3 packages in 2s"), null);
  // the summary is found in stdout when the result text itself is empty
  const viaStdout = activity([prompt("go"), use("t", "Bash", { command: "npm test" }), { ...result("t", ""), toolUseResult: { stdout: "ℹ pass 3\nℹ fail 0", stderr: "" } }]);
  assert.equal(viaStdout.tests.passed, 3);
  // only the tail of a huge output is scanned
  assert.deepEqual(pick(testsIn(`${"x".repeat(2_000_000)}\nℹ pass 7\nℹ fail 0`)), { passed: 7, failed: 0 });
});

test("activity: edits show as files, a failed edit and a failed build as errors", () => {
  const badEdit = result("e2", "<tool_use_error>String to replace not found in file.\nString: foo</tool_use_error>", { is_error: true });
  const build = use("b1", "PowerShell", { command: "npm run build", description: "Build the app" });
  const buildErr = result("b1", "Exit code 2\nsrc/a.ts(3,5): error TS2304: Cannot find name 'foo'.", { is_error: true });
  const a = activity([
    prompt("ship it"),
    use("e1", "Edit", { file_path: "C:\\proj\\src\\app.jsx" }),
    result("e1", "The file has been updated."),
    use("e2", "Edit", { file_path: "/proj/src/util.mjs" }),
    badEdit,
    use("e3", "Write", { file_path: "src/app.jsx" }),
    result("e3", "ok"),
    use("r1", "Read", { file_path: "src/app.jsx" }),
    result("r1", "..."),
    build,
    buildErr,
  ]);
  assert.deepEqual(a.files, ["app.jsx", "util.mjs"]);
  assert.deepEqual(a.counts, { commands: 1, edits: 3, reads: 1 });
  assert.deepEqual(a.events, [
    { at: atOf(badEdit), kind: "error", text: "String to replace not found in file.", ok: false },
    { at: atOf(build), kind: "command", text: "Build the app", ok: false },
    { at: atOf(buildErr), kind: "error", text: "src/a.ts(3,5): error TS2304: Cannot find name 'foo'.", ok: false },
  ]);
  assert.equal(a.tests, null);
  assert.equal(a.now, "thinking");
});

test("activity: a background command is its own kind of event", () => {
  const start = use("bg", "Bash", { command: "npm run dev", description: "Start the dev server", run_in_background: true });
  const a = activity([prompt("run it"), start, result("bg", "Command running in background with ID: abc123")]);
  assert.deepEqual(a.events, [{ at: atOf(start), kind: "background", text: "Start the dev server", ok: true }]);
  assert.equal(a.counts.commands, 1);
});

test("activity: now describes the call still in flight", () => {
  const now = (...rest) => activity([prompt("go"), say("On it."), ...rest]).now;
  assert.equal(now(use("1", "Bash", { command: "cd C:\\proj && npm test" })), "running npm test");
  assert.equal(now(use("1", "Bash", { command: "node --test", description: "Run the transcript tests" })), "running the transcript tests");
  assert.equal(now(use("1", "PowerShell", { command: "Get-Process", description: "Check what node is running" })), "checking what node is running");
  assert.equal(now(use("1", "PowerShell", { command: "x", description: "Type-check the app" })), "type-checking the app");
  assert.equal(now(use("1", "PowerShell", { command: "Set-Location C:\\proj; node --check a.mjs" })), "running node --check a.mjs");
  assert.equal(now(use("1", "Edit", { file_path: "C:\\proj\\app.jsx" })), "editing app.jsx");
  assert.equal(now(use("1", "Agent", { description: "Explore the transcript format" })), "waiting on a helper: explore the transcript format");
  assert.equal(now(use("1", "WebSearch", { query: "x" })), "searching the web");
  assert.equal(now(use("1", "AskUserQuestion", {})), "asking you a question");
  // parallel reads read as one thing; once one returns, the other is what's left
  assert.equal(now(use("r1", "Read", { file_path: "a.js" }), use("r2", "Grep", { pattern: "x" })), "reading files");
  assert.equal(now(use("r1", "Read", { file_path: "a.js" }), use("r2", "Grep", { pattern: "x" }), result("r1", "...")), "searching the code");
  assert.equal(now(use("r1", "Read", { file_path: "a.js" }), result("r1", "...")), "thinking");
  // a call whose result never arrived doesn't stick once Claude moves on
  assert.equal(now(use("x", "Bash", { command: "hang" }), say("That hung; moving on."), use("r", "Read", { file_path: "b.js" }), result("r", "...")), "thinking");
  assert.equal(now(), "writing");
});

test("activity: only the current turn counts", () => {
  const old = [
    prompt("old task"),
    use("o1", "Bash", { command: "npm test" }),
    result("o1", "ℹ pass 3\nℹ fail 1", { is_error: true }),
    use("o2", "Edit", { file_path: "old.js" }),
    result("o2", "ok"),
    say("done"),
  ];
  const empty = { now: null, events: [], tests: null, files: [], counts: { commands: 0, edits: 0, reads: 0 } };
  assert.deepEqual(activity([...old, prompt("new task")]), empty);
  const a = activity([...old, prompt("new task"), use("n1", "Read", { file_path: "new.js" })]);
  assert.equal(a.now, "reading new.js");
  assert.deepEqual(a.counts, { commands: 0, edits: 0, reads: 1 });
  assert.deepEqual([a.tests, a.files, a.events], [null, [], []]);
});

test("activity: keeps the newest events and never throws on junk", () => {
  const many = [prompt("go")];
  for (let i = 0; i < 12; i++) many.push(use(`c${i}`, "Bash", { command: `step ${i}` }), result(`c${i}`, "ok"));
  assert.equal(activity(many).events.length, 8);
  assert.deepEqual(activity(many, { max: 3 }).events.map((e) => e.text), ["step 9", "step 10", "step 11"]);

  const junk = [
    null,
    5,
    "x",
    { type: "assistant", message: null },
    { type: "assistant", message: { content: [null, 7, { type: "tool_use" }, { type: "tool_use", name: "Bash", input: null }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "nope", is_error: true, content: 42 }] } },
    { type: "user", toolUseResult: "Error: boom", message: { content: [{ type: "tool_result", is_error: true }] } },
  ];
  assert.doesNotThrow(() => activity(junk));
  assert.deepEqual(activity(null), { now: null, events: [], tests: null, files: [], counts: { commands: 0, edits: 0, reads: 0 } });
  const j = activity(junk);
  assert.deepEqual(j.events.map((e) => e.kind), ["command", "error", "error"]);
  assert.equal(j.events.at(-1).text, "Error: boom");
});
