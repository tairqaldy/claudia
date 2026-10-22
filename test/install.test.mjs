import assert from "node:assert/strict";
import { test } from "node:test";
import { withHooks, withoutHooks } from "../src/install.mjs";

const CMD = '"node" "/x/claudia/src/hook.mjs" claudia-hook';
const theirs = { type: "command", command: "say done" };

test("adds hooks without touching existing settings or hooks", () => {
  const before = { model: "opus", hooks: { Stop: [{ hooks: [theirs] }] } };
  const after = withHooks(before, CMD);
  assert.equal(after.model, "opus");
  assert.deepEqual(after.hooks.Stop[0], { hooks: [theirs] });
  // hooks that can carry your answer back from Telegram wait; the rest run in the background
  assert.equal(after.hooks.Stop[1].hooks[0].command, `${CMD} --decide`);
  assert.equal(after.hooks.Stop[1].hooks[0].async, undefined);
  assert.equal(after.hooks.PermissionRequest[0].hooks[0].command, `${CMD} --decide`);
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].command, CMD);
  assert.equal(after.hooks.UserPromptSubmit[0].hooks[0].async, true);
  assert.equal(after.hooks.PreToolUse[0].matcher, "AskUserQuestion|ExitPlanMode");
  assert.deepEqual(before.hooks.Stop, [{ hooks: [theirs] }], "input is not mutated");
});

test("installing twice doesn't duplicate", () => {
  const once = withHooks({}, CMD);
  assert.deepEqual(withHooks(once, CMD), once);
});

test("removing leaves only what was there before", () => {
  const before = { hooks: { Stop: [{ hooks: [theirs] }] } };
  assert.deepEqual(withoutHooks(withHooks(before, CMD)), before);
  assert.deepEqual(withoutHooks(withHooks({ model: "opus" }, CMD)), { model: "opus" });
});
