import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lastAssistantText, lastUserPrompt, readTail } from "../src/transcript.mjs";
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
