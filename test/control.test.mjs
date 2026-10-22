import assert from "node:assert/strict";
import { test } from "node:test";
import { createControl } from "../src/control.mjs";

function setup({ away = true, holdMinutes = 1 } = {}) {
  const sent = [];
  const edits = [];
  let id = 500;
  const tg = {
    send: async (chat, text, opts = {}) => {
      const msg = { message_id: ++id, text, markup: opts.markup };
      sent.push(msg);
      return msg;
    },
    edit: async (chat, messageId, text) => edits.push({ messageId, text }),
    setButtons: async () => {},
    answerButton: async () => {},
    react: async () => {},
  };
  const begun = [];
  const tracker = {
    state: { sessions: { s1: { id: "s1", project: "qn5", label: "checkout tests" } } },
    begin: (s, prompt) => begun.push(prompt),
  };
  const recipes = () => [
    { key: "ship", label: "Ship it", prompt: "commit and push" },
    { key: "test", label: "Test it", prompt: "run the tests" },
  ];
  const state = { away };
  const control = createControl({ state, save: () => {}, tg, config: { chatId: 1, holdMinutes, name: "Tair" }, tracker, recipes });
  const tap = (data, messageId) => control.onButton({ id: "q", data, message: { message_id: messageId } });
  return { control, sent, edits, begun, tap };
}

const ev = (hook_event_name, extra = {}) => ({ session_id: "s1", hook_event_name, ...extra });
const tick = () => new Promise((r) => setImmediate(r));

test("at the laptop nothing waits", async () => {
  const { control } = setup({ away: false });
  assert.deepEqual(await control.decide(ev("Stop")), {});
  assert.deepEqual(await control.decide(ev("PermissionRequest", { tool_name: "Bash" })), {});
});

test("away: replying to the done ping continues the same session", async () => {
  const { control, begun } = setup();
  const answer = control.decide(ev("Stop"));
  const hold = control.stopHold("s1");
  assert.ok(hold);
  control.attach(hold, 42, "done · tests pass");
  assert.equal(control.onReply({ message_id: 43, reply_to_message: { message_id: 42 } }, "now commit it"), true);
  const out = await answer;
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Tair replied from Telegram: now commit it/);
  assert.deepEqual(begun, ["now commit it"]);
});

test("away: a shortcut button sends its instruction", async () => {
  const { control, tap } = setup();
  const answer = control.decide(ev("Stop"));
  const hold = control.stopHold("s1");
  control.attach(hold, 42, "done");
  const buttons = control.stopButtons(hold).inline_keyboard.flat().map((b) => b.text);
  assert.deepEqual(buttons, ["Ship it", "Test it", "More", "Done for now"]);
  await tap(`r:${hold.id}:ship`, 42);
  assert.equal((await answer).reason, "Tair replied from Telegram: commit and push");
});

test("away: questions become buttons and the tap is the answer", async () => {
  const { control, sent, tap } = setup();
  const questions = [{ question: "Which db?", options: [{ label: "Postgres" }, { label: "SQLite" }] }];
  const answer = control.decide(ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions } }));
  await tick();
  assert.match(sent[0].text, /checkout tests · qn5 is asking:\nWhich db\?/);
  assert.equal(control.asking("s1"), true);
  const id = sent[0].markup.inline_keyboard[0][1].callback_data.split(":")[1];
  await tap(`a:${id}:0:1`, sent[0].message_id);
  const out = await answer;
  assert.equal(out.hookSpecificOutput.permissionDecision, "allow");
  assert.deepEqual(out.hookSpecificOutput.updatedInput, { questions, answers: { "Which db?": "SQLite" } });
});

test("away: multi-select toggles, then sends", async () => {
  const { control, sent, tap } = setup();
  const questions = [{ question: "Which pages?", multiSelect: true, options: [{ label: "Home" }, { label: "Pricing" }, { label: "Blog" }] }];
  const answer = control.decide(ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions } }));
  await tick();
  const id = sent[0].markup.inline_keyboard[0][0].callback_data.split(":")[1];
  await tap(`a:${id}:0:0`, sent[0].message_id);
  await tap(`a:${id}:0:2`, sent[0].message_id);
  await tap(`a:${id}:0:0`, sent[0].message_id); // untick Home
  await tap(`s:${id}:0`, sent[0].message_id);
  assert.deepEqual((await answer).hookSpecificOutput.updatedInput.answers, { "Which pages?": "Blog" });
});

test("away: permission prompts get allow and deny buttons", async () => {
  const { control, sent, tap } = setup();
  const answer = control.decide(ev("PermissionRequest", { tool_name: "Bash", tool_input: { command: "npm publish" } }));
  await tick();
  assert.match(sent[0].text, /wants to run:\nnpm publish/);
  const id = sent[0].markup.inline_keyboard[0][1].callback_data.split(":")[1];
  await tap(`yd:${id}`, sent[0].message_id);
  assert.equal((await answer).hookSpecificOutput.decision.behavior, "deny");
});

test("coming back to the laptop lets every waiting session go", async () => {
  const { control } = setup();
  const answer = control.decide(ev("Stop"));
  control.attach(control.stopHold("s1"), 42, "done");
  control.setAway(false);
  assert.deepEqual(await answer, {});
  assert.equal(control.count(), 0);
});

test("sessions started from the phone wait even when you're not away", async () => {
  const { control } = setup({ away: false });
  control.decide(ev("Stop", { claudia_remote: true }));
  assert.ok(control.stopHold("s1"));
});

test("no reply in time means carry on as usual", async () => {
  const { control, edits } = setup({ holdMinutes: 0.0005 });
  const answer = control.decide(ev("Stop"));
  control.attach(control.stopHold("s1"), 42, "done");
  assert.deepEqual(await answer, {});
  assert.match(edits.at(-1).text, /no reply, so it stopped there/);
});
