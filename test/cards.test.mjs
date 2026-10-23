import assert from "node:assert/strict";
import { test } from "node:test";
import { cardName, esc, renderBatch, renderBoard, renderCard, renderTerminal } from "../src/cards.mjs";

const MIN = 60_000;
const clock = () => "14:02";

test("a card always leads with its state and name, then one line", () => {
  assert.equal(renderCard({ state: "working", name: "qn5 · checkout tests", since: 0, usually: 12 * MIN }, clock), "<b>⏳ qn5 · checkout tests</b>\nworking since 14:02 · usually ~12m");
  assert.equal(
    renderCard({ state: "done", name: "qn5 · checkout tests", took: 14 * MIN, gist: "all 42 pass. nothing's committed yet." }, clock),
    "<b>✅ qn5 · checkout tests</b> · 14m\nall 42 pass. nothing's committed yet.",
  );
  assert.match(renderCard({ state: "needs", name: "qn5", gist: "postgres or sqlite?" }, clock), /^<b>🟠 qn5 needs you<\/b>\npostgres or sqlite\?$/);
  assert.match(renderCard({ state: "working", name: "qn5", since: 0, step: "running npm test", long: 30 * MIN }, clock), /running long: 30m\n▸ running npm test$/);
});

test("anything from a session is escaped, so it can't break the formatting", () => {
  assert.equal(esc("<b>a & b</b>"), "&lt;b&gt;a &amp; b&lt;/b&gt;");
  assert.match(renderCard({ state: "done", name: "x", gist: "use <Suspense>" }, clock), /use &lt;Suspense&gt;/);
});

test("scratch folders don't show up in names", () => {
  assert.equal(cardName({ project: "scratch-2026-10-15-fe816a", label: "fix login" }), "fix login");
  assert.equal(cardName({ project: "qn5", label: "fix login" }), "qn5 · fix login");
  assert.equal(cardName({ project: "qn5" }), "qn5");
});

test("tasks finishing together share one message, and say how many need you", () => {
  const text = renderBatch([
    { state: "done", name: "qn5", took: 3 * MIN, gist: "tests pass" },
    { state: "needs", name: "finow", took: MIN, gist: "which model?" },
  ]);
  assert.match(text, /^<b>2 finished<\/b> · 1 needs you\n\n✅ <b>qn5<\/b> · 3m\ntests pass\n\n🟠 <b>finow needs you<\/b> · 1m\nwhich model\?$/);
});

test("the pinned board lists live sessions, then today", () => {
  const now = 100 * MIN;
  const text = renderBoard({
    now,
    sessions: [
      { id: "a", project: "qn5", title: "checkout tests", status: "working", turnStart: now - 6 * MIN, background: [] },
      { id: "b", project: "finow", title: "finow", status: "waiting", background: [] },
      { id: "c", project: "docs", title: "docs", status: "idle", background: [] },
    ],
    doneToday: { count: 3, totalMs: 72 * MIN },
  });
  assert.equal(text, "<b>right now</b>\n⏳ qn5 · checkout tests · 6m\n🟠 finow · needs you\n\n✅ 3 done today · 1h 12m of work");
  assert.match(renderBoard({ sessions: [] }), /all quiet/);
});

test("a failed terminal command shows its last lines and how to get help", () => {
  const text = renderTerminal({ command: "npm run build", ok: false, exitCode: 1, durationMs: 3 * MIN, cwd: "C:\\code\\qn5", output: ["src/a.ts(3,1): error TS2304", "Found 1 error."] });
  assert.match(text, /^<b>🔴 npm run build failed \(exit 1\)<\/b> · 3m · qn5\n<pre>src\/a.ts\(3,1\): error TS2304\nFound 1 error.<\/pre>\n<i>reply/);
  assert.doesNotMatch(renderTerminal({ command: "pnpm test", ok: true, exitCode: 0, durationMs: 2 * MIN, cwd: "/x/finow", output: [] }), /reply/);
});
