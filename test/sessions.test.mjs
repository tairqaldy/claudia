import assert from "node:assert/strict";
import { test } from "node:test";
import { Tracker, displayName } from "../src/sessions.mjs";

const SEC = 1000;
const MIN = 60 * SEC;

function setup({ entries = [], activity = null, away = false } = {}) {
  let now = 1_700_000_000_000;
  const queue = [];
  const pings = [];
  let msgId = 100;
  const transcript = { entries, activity };
  const tracker = new Tracker({
    state: {},
    now: () => now,
    timers: {
      set: (fn, ms) => {
        const t = { at: now + ms, fn };
        queue.push(t);
        return t;
      },
      clear: (t) => {
        const i = queue.indexOf(t);
        if (i >= 0) queue.splice(i, 1);
      },
    },
    transcripts: { read: () => transcript.entries, activity: () => transcript.activity, settle: async () => {} },
    forceLoud: () => away,
    notify: async (kind, s, extra) => {
      pings.push({ kind, project: s.project, ...extra });
      return { messageId: ++msgId, label: kind === "start" ? "fixing tests" : undefined };
    },
  });
  const advance = async (ms) => {
    const target = now + ms;
    for (;;) {
      queue.sort((a, b) => a.at - b.at);
      if (!queue.length || queue[0].at > target) break;
      const t = queue.shift();
      now = t.at;
      await t.fn();
    }
    now = target;
  };
  const ev = (hook_event_name, extra = {}) =>
    tracker.handle({ session_id: "s1", cwd: "/home/me/qn5", transcript_path: "/t.jsonl", hook_event_name, ...extra });
  return { tracker, pings, advance, ev, transcript, now: () => now };
}

test("a quick turn stays silent", async () => {
  const { pings, advance, ev } = setup();
  await ev("UserPromptSubmit", { prompt: "what's 2+2" });
  await advance(10 * SEC);
  await ev("Stop", { last_assistant_message: "4" });
  await advance(10 * MIN);
  assert.deepEqual(pings, []);
});

test("a long turn pings when it starts and when it's done, as a thread", async () => {
  const { pings, advance, ev, tracker } = setup();
  await ev("UserPromptSubmit", { prompt: "fix the checkout tests" });
  await advance(30 * SEC);
  assert.equal(pings.length, 1);
  assert.equal(pings[0].kind, "start");
  assert.equal(pings[0].project, "qn5");
  await advance(4 * MIN);
  await ev("Stop", { last_assistant_message: "All 42 tests pass now." });
  assert.equal(pings.length, 2);
  const done = pings[1];
  assert.equal(done.kind, "done");
  assert.equal(done.replyTo, 101);
  assert.equal(done.took, 4 * MIN + 30 * SEC);
  assert.equal(done.finalText, "All 42 tests pass now.");
  assert.match(tracker.describe(), /fixing tests · qn5: idle, finished 0s ago, took 5m/);
});

test("past durations become the usual time", async () => {
  const { pings, advance, ev, tracker } = setup();
  for (const minutes of [10, 12]) {
    await ev("UserPromptSubmit", { prompt: "build" });
    await advance(minutes * MIN);
    await ev("Stop", { last_assistant_message: "built" });
  }
  assert.equal(tracker.usual("qn5"), 11 * MIN);
  await ev("UserPromptSubmit", { prompt: "build again" });
  await advance(30 * SEC);
  assert.equal(pings.at(-1).kind, "start");
  assert.equal(pings.at(-1).usually, 11 * MIN);
});

test("a question answered quickly doesn't ping, an unanswered one does", async () => {
  const { pings, advance, ev } = setup();
  const ask = { tool_name: "AskUserQuestion", tool_input: { questions: [{ question: "postgres or sqlite?" }] } };
  await ev("UserPromptSubmit", { prompt: "set up the db" });
  await advance(5 * SEC);
  await ev("PreToolUse", ask);
  await advance(10 * SEC);
  await ev("PostToolUse", ask);
  await advance(15 * SEC); // start ping fires at 30s, but no ask ping
  assert.deepEqual(pings.map((p) => p.kind), ["start"]);

  await ev("PreToolUse", ask);
  await advance(20 * SEC);
  assert.deepEqual(pings.map((p) => p.kind), ["start", "ask"]);
});

test("a permission prompt that was already answered doesn't ping", async () => {
  const { pings, advance, ev, transcript, now } = setup();
  await ev("UserPromptSubmit", { prompt: "deploy" });
  await advance(40 * SEC);
  await ev("Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  await advance(10 * SEC);
  transcript.activity = now(); // the session moved on
  await advance(20 * SEC);
  assert.deepEqual(pings.map((p) => p.kind), ["start"]);
});

test("idle prompts are ignored", async () => {
  const { pings, advance, ev } = setup();
  await ev("Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  await advance(5 * MIN);
  assert.deepEqual(pings, []);
});

test("a Stop with no known start recovers it from the transcript, once", async () => {
  const { pings, ev, now, transcript } = setup();
  transcript.entries = [
    { type: "user", timestamp: new Date(now() - 8 * MIN).toISOString(), message: { role: "user", content: "refactor auth" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Auth is refactored." }] } },
  ];
  await ev("Stop", { last_assistant_message: "Auth is refactored." });
  await ev("Stop", { last_assistant_message: "Auth is refactored." });
  assert.equal(pings.length, 1);
  assert.equal(pings[0].kind, "done");
  assert.equal(pings[0].took, 8 * MIN);
});

test("an API failure pings even when quick", async () => {
  const { pings, advance, ev } = setup();
  await ev("UserPromptSubmit", { prompt: "hi" });
  await advance(3 * SEC);
  await ev("StopFailure", { error: "overloaded" });
  assert.equal(pings.length, 1);
  assert.equal(pings[0].kind, "failed");
  assert.equal(pings[0].error, "overloaded");
});

test("a long-running turn gets one check-in, unless it went quiet", async () => {
  const { pings, advance, ev, now, transcript } = setup();
  await ev("UserPromptSubmit", { prompt: "migrate everything" });
  await advance(30 * SEC);
  transcript.activity = now() + 60 * MIN; // keeps looking active
  await advance(60 * MIN);
  assert.deepEqual(pings.map((p) => p.kind), ["start", "long"]);

  const quiet = setup();
  await quiet.ev("UserPromptSubmit", { prompt: "migrate everything" });
  await quiet.advance(30 * SEC);
  quiet.transcript.activity = quiet.now(); // then nothing for an hour, e.g. it was interrupted
  await quiet.advance(60 * MIN);
  assert.deepEqual(quiet.pings.map((p) => p.kind), ["start"]);
  assert.match(quiet.tracker.describe(), /no activity for 1h/);
});

test("session end forgets the session", async () => {
  const { ev, tracker } = setup();
  await ev("SessionStart", { source: "startup" });
  assert.match(tracker.describe(), /qn5: open, idle/);
  await ev("SessionEnd", { reason: "other" });
  assert.equal(tracker.describe(), "no sessions seen in the last day");
});

test("a turn that leaves background tasks running is paused, not done", async () => {
  const { pings, advance, ev, tracker } = setup();
  await ev("UserPromptSubmit", { prompt: "run the eval suite" });
  await advance(2 * MIN);
  await ev("Stop", { last_assistant_message: "Started the evals in the background.", background_tasks: [{ description: "eval run", status: "running" }] });
  assert.equal(pings.at(-1).kind, "paused");
  assert.deepEqual(pings.at(-1).background, ["eval run"]);
  assert.match(tracker.describe(), /paused 0s, 1 background task still running/);
  assert.equal(tracker.usual("qn5"), null, "a paused turn isn't a finished duration");
});

test("while away, even quick turns ping", async () => {
  const { pings, advance, ev } = setup({ away: true });
  await ev("UserPromptSubmit", { prompt: "what's 2+2" });
  await advance(5 * SEC);
  await ev("Stop", { last_assistant_message: "4" });
  assert.deepEqual(pings.map((p) => p.kind), ["done"]);
});

test("finished work lands in the diary, and projects are remembered", async () => {
  const { advance, ev, tracker } = setup();
  await ev("UserPromptSubmit", { prompt: "build" });
  await advance(3 * MIN);
  await ev("Stop", { last_assistant_message: "built" });
  assert.equal(tracker.state.log.length, 1);
  assert.equal(tracker.state.log[0].took, 180);
  assert.deepEqual(tracker.recentProjects(), [{ cwd: "/home/me/qn5", name: "qn5" }]);
});

test("limits resetting pings once", async () => {
  const { pings, ev } = setup();
  await ev("Notification", { notification_type: "quota_auto_resume_fired", message: "resumed" });
  assert.deepEqual(pings.map((p) => p.kind), ["resumed"]);
});

test("titles beat meaningless folder names", () => {
  assert.equal(displayName({ project: "scratch-2026-10-15-fe816a", label: "qaldy design system" }), "qaldy design system");
  assert.equal(displayName({ project: "qn5", label: "checkout tests" }), "checkout tests · qn5");
  assert.equal(displayName({ project: "qn5" }), "qn5");
});
