import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { createAppServer, verifyInitData } from "../src/miniapp.mjs";
import { timeline } from "../src/transcript.mjs";

const TOKEN = "123456:test-token";

// Signs initData the way Telegram does, so the check can be tested without Telegram.
function sign(fields, token = TOKEN) {
  const params = new URLSearchParams(fields);
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const check = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

const now = Date.now();
const fresh = { auth_date: String(Math.floor(now / 1000) - 60), user: JSON.stringify({ id: 42, first_name: "Tair" }), query_id: "AAE" };

test("accepts initData signed with the bot token", () => {
  assert.equal(verifyInitData(sign(fresh), TOKEN, now).id, 42);
});

test("rejects tampering, the wrong bot, and stale logins", () => {
  const tampered = sign(fresh).replace("Tair", "Mallory");
  assert.equal(verifyInitData(tampered, TOKEN, now), null);
  assert.equal(verifyInitData(sign(fresh, "999:other-bot"), TOKEN, now), null);
  const old = { ...fresh, auth_date: String(Math.floor(now / 1000) - 2 * 86_400) };
  assert.equal(verifyInitData(sign(old), TOKEN, now), null);
  assert.equal(verifyInitData("", TOKEN, now), null);
  assert.equal(verifyInitData("user=%7B%7D", TOKEN, now), null);
});

test("timeline folds a turn into prompt, one activity line, and the final message", () => {
  const entries = [
    { type: "user", timestamp: "2026-10-22T10:00:00Z", message: { content: "fix the flaky tests" } },
    { type: "assistant", message: { content: [{ type: "text", text: "Let me look." }, { type: "tool_use", name: "Bash", input: {} }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "a.js" } }, { type: "tool_use", name: "Edit", input: { file_path: "a.js" } }, { type: "tool_use", name: "Read", input: {} }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "All 42 pass now." }] } },
  ];
  assert.deepEqual(timeline(entries), [
    { type: "you", text: "fix the flaky tests", at: Date.parse("2026-10-22T10:00:00Z") },
    { type: "activity", text: "ran 1 command · edited 1 file · looked at 1 file" },
    { type: "claude", text: "All 42 pass now." },
  ]);
});

test("state is long-polled: a request with the latest version waits for the next change", async () => {
  let n = 0;
  const api = { state: async () => ({ n }), watching() {}, actions: {} };
  const app = createAppServer({ config: { telegramToken: TOKEN, chatId: 42 }, api });
  const port = 47900 + Math.floor(Math.random() * 90);
  await app.listen(port);
  const auth = { authorization: `tma ${sign({ ...fresh, auth_date: String(Math.floor(Date.now() / 1000)) })}` };
  const get = (q = "") => fetch(`http://127.0.0.1:${port}/api/state${q}`, { headers: auth }).then((r) => r.json());

  const first = await get();
  assert.equal(first.n, 0);
  const started = Date.now();
  const next = get(`?since=${first.version}`);
  setTimeout(() => {
    n = 1;
    app.broadcast();
  }, 150);
  const second = await next;
  assert.equal(second.n, 1);
  assert.ok(second.version > first.version);
  assert.ok(Date.now() - started >= 150, "it waited for the change instead of answering at once");

  const stale = await get(`?since=${first.version}`); // an old version answers at once
  assert.equal(stale.n, 1);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/state`)).status, 401);
  app.close();
});
