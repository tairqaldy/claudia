#!/usr/bin/env node
// Claudia's daemon: one small process that hears Claude Code hooks and talks to you on Telegram.
import { createServer } from "node:http";
import { PATHS, loadConfig, log, readJson, saveConfig, writeJson } from "./config.mjs";
import { createBrain, explainError } from "./brain.mjs";
import { createMemory } from "./memory.mjs";
import { Tracker } from "./sessions.mjs";
import { createTelegram } from "./telegram.mjs";
import { clip, inQuietHours, parseDuration } from "./util.mjs";

const config = loadConfig();
if (!config.telegramToken) {
  log("no telegram token yet. run: npm run setup");
  process.exit(1);
}

const COMMANDS = [
  { command: "status", description: "what's running right now" },
  { command: "mute", description: "no sounds for a while, e.g. /mute 2h" },
  { command: "unmute", description: "sounds back on" },
  { command: "notes", description: "what i remember about you" },
  { command: "forget", description: "forget a note, e.g. /forget 3" },
];
const HELP = `i text you when a claude code session starts something long, finishes, or needs you. "started" pings are silent, the rest make a sound.

/status what's running
/mute 2h no sounds for a while
/notes what i remember

or just text me`;

const tg = createTelegram(config.telegramToken);
const memory = createMemory();
const state = readJson(PATHS.state, {});
let saveTimer = null;
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(PATHS.state, state), 300);
};

const tracker = new Tracker({
  state,
  save,
  notify,
  quietMs: config.quietSeconds * 1000,
  askDelayMs: config.askDelaySeconds * 1000,
  onError: (err) => log("tracker:", err),
});
const prefs = {
  quietHours: () => state.quietHours ?? null,
  setQuietHours: (value) => {
    state.quietHours = value;
    save();
  },
  mutedUntil: () => state.mutedUntil ?? 0,
};
const brain = createBrain({ config, memory, tracker, prefs, onError: (err) => log("brain:", err) });
const muted = () => Date.now() < (state.mutedUntil ?? 0);
const hushed = () => muted() || inQuietHours(state.quietHours, config.timezone);
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" });

async function notify(kind, session, extra = {}) {
  if (!config.chatId) return null;
  const { text, label } = await brain.ping(kind, session, extra);
  const silent = kind === "start" || kind === "long" || hushed();
  const msg = await tg.send(config.chatId, text, { silent, replyTo: extra.replyTo });
  memory.addMessage("assistant", text);
  log(`ping ${kind} · ${session.project}`);
  return { messageId: msg.message_id, label };
}

// Events for one session are handled in order; different sessions don't wait on each other.
const queues = new Map();
function enqueue(ev) {
  const id = ev.session_id ?? "unknown";
  const next = (queues.get(id) ?? Promise.resolve()).then(() => tracker.handle(ev)).catch((err) => log("event:", err));
  queues.set(id, next);
  next.then(() => queues.get(id) === next && queues.delete(id));
}

async function onUpdate(update) {
  const msg = update.message;
  if (!msg?.chat) return;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!config.chatId) return pair(msg, text);
  if (msg.chat.id !== config.chatId) return; // she only talks to you
  const chatId = config.chatId;
  if (!text) return tg.send(chatId, "i can only read text for now");

  const [first, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  switch (first.split("@")[0].toLowerCase()) {
    case "/start":
    case "/help":
      return tg.send(chatId, HELP);
    case "/status":
      return tg.send(chatId, tracker.describe());
    case "/mute":
      state.mutedUntil = Date.now() + parseDuration(arg, 3_600_000);
      save();
      return tg.send(chatId, `ok, no sounds until ${clock(state.mutedUntil)}. you'll still get messages, just quietly`);
    case "/unmute":
      state.mutedUntil = 0;
      save();
      return tg.send(chatId, "sound's back on");
    case "/notes":
      return tg.send(chatId, memory.notes().map((n) => `#${n.id} ${n.text}`).join("\n") || "my notebook's empty so far");
    case "/forget":
      return tg.send(chatId, memory.forget(arg.replace("#", "")) ? "gone" : "no note with that number. /notes shows them");
  }
  return chat(msg, text);
}

async function chat(msg, text) {
  const quoted = msg.reply_to_message?.text;
  const input = quoted ? `(replying to: "${clip(quoted, 300)}")\n${text}` : text;
  tg.typing(config.chatId);
  const typing = setInterval(() => tg.typing(config.chatId), 4500);
  let answer;
  try {
    answer = await brain.reply(input);
  } catch (err) {
    log("chat:", err);
    answer = explainError(err);
  } finally {
    clearInterval(typing);
  }
  memory.addMessage("user", input);
  memory.addMessage("assistant", answer);
  await tg.send(config.chatId, answer);
}

// The first chat to send "/start <code>" (from the setup link) becomes the only chat she answers.
async function pair(msg, text) {
  const code = text.split(/\s+/)[1];
  if (msg.chat.type !== "private" || !config.pairCode || code !== config.pairCode) return;
  config.chatId = msg.chat.id;
  delete config.pairCode;
  saveConfig({ chatId: msg.chat.id, pairCode: null });
  log(`paired with chat ${msg.chat.id}`);
  const { text: hello } = await brain.ping("hello", { project: "" });
  await tg.send(config.chatId, hello);
  memory.addMessage("assistant", hello);
}

const startedAt = Date.now();
let bot = null;

const server = createServer((req, res) => {
  const reply = (code, body = {}) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    return reply(200, { ok: true, pid: process.pid, paired: Boolean(config.chatId), bot, startedAt });
  }
  // a custom header can't be sent cross-origin without a preflight, so web pages can't poke this
  if (req.method !== "POST" || req.headers["x-claudia"] !== "1") return reply(404);
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 2_000_000) req.destroy();
  });
  req.on("end", async () => {
    switch (req.url) {
      case "/event": {
        reply(200); // answer right away; hooks shouldn't wait on Telegram or the model
        try {
          enqueue(JSON.parse(body));
        } catch {}
        return;
      }
      case "/status":
        return reply(200, { text: tracker.describe(), muted: muted() });
      case "/test":
        if (!config.chatId) return reply(409, { error: "not paired yet" });
        await tg.send(config.chatId, "test ping from the laptop. if you see this, we're good").catch((err) => log("test:", err));
        return reply(200);
      case "/stop":
        reply(200);
        return shutdown();
    }
    reply(404);
  });
});

function shutdown() {
  clearTimeout(saveTimer);
  writeJson(PATHS.state, state);
  log("claudia stopped");
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
// one bad message or a locked file shouldn't take her down and cost you a "done" ping
process.on("unhandledRejection", (err) => log("unhandled:", err));
process.on("uncaughtException", (err) => log("uncaught:", err));

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    log(`port ${config.port} is taken, claudia is probably already running`);
    process.exit(0);
  }
  log("server:", err);
  process.exit(1);
});

server.listen(config.port, "127.0.0.1", async () => {
  log(`claudia up · pid ${process.pid} · port ${config.port}`);
  try {
    bot = (await tg.me()).username;
    await tg.call("setMyCommands", { commands: COMMANDS });
  } catch (err) {
    log("telegram:", err);
  }
  tg.poll(onUpdate, (err) => log("telegram:", err));
});
