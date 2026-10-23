#!/usr/bin/env node
// Claudia's daemon: one small process that hears Claude Code hooks and talks to you on Telegram.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { HOME, PATHS, loadConfig, log, readJson, saveConfig, writeJson } from "./config.mjs";
import { createBrain, explainError } from "./brain.mjs";
import { createControl } from "./control.mjs";
import * as laptop from "./laptop.mjs";
import { createMemory } from "./memory.mjs";
import { createAppServer } from "./miniapp.mjs";
import { loadRecipes, saveRecipe } from "./recipes.mjs";
import { createRunner } from "./runner.mjs";
import { Tracker, displayName } from "./sessions.mjs";
import { createTelegram } from "./telegram.mjs";
import { activity, readTail, timeline } from "./transcript.mjs";
import { cardName, renderBatch, renderBoard, renderCard, renderTerminal } from "./cards.mjs";
import { parseTerminalEvent } from "./terminal.mjs";
import { findCloudflared, startTunnel } from "./tunnel.mjs";
import { clip, fmtDur, inQuietHours, parseDuration } from "./util.mjs";

const config = loadConfig();
if (!config.telegramToken) {
  log("no telegram token yet. run: npm run setup");
  process.exit(1);
}

const COMMANDS = [
  { command: "status", description: "what's running right now" },
  { command: "away", description: "sessions wait for you here" },
  { command: "back", description: "you're at the laptop again" },
  { command: "new", description: "start a task on the laptop" },
  { command: "laptop", description: "battery, cpu, keep awake, screenshot" },
  { command: "mute", description: "no sounds for a while, e.g. /mute 2h" },
  { command: "unmute", description: "sounds back on" },
  { command: "notes", description: "what i remember about you" },
];
const HELP = `every task gets one card. it shows up quietly while the task works, and comes back with a sound when it's done or needs you. the pinned message shows what's running right now.

reply to a card to tell that session what to do next. reply to a failed terminal command and i'll have claude look at it.

/away when you leave the laptop: finished sessions wait for your reply here, and their questions come as buttons
/back when you're at the laptop again
/new start a task in one of your projects
/status what's running
/laptop battery, keep awake, screenshot
/mute 2h no sounds for a while

or just text me`;

const tg = createTelegram(config.telegramToken);
const memory = createMemory();
const state = readJson(PATHS.state, {});
let saveTimer = null;
let app = null; // the Mini App server, once it's up
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(PATHS.state, state), 300);
  app?.broadcast();
  refreshBoard();
};
const chatId = () => config.chatId;
const clock = (ms) => new Date(ms).toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit" });
const muted = () => Date.now() < (state.mutedUntil ?? 0);
const hushed = () => muted() || inQuietHours(state.quietHours, config.timezone);

const tracker = new Tracker({
  state,
  save,
  notify,
  quietMs: config.quietSeconds * 1000,
  askDelayMs: config.askDelaySeconds * 1000,
  forceLoud: (s) => control.away() || s.remote, // when you're not at the laptop, every finished turn matters
  onError: (err) => log("tracker:", err),
});
const control = createControl({ state, save, tg, config, tracker, recipes: loadRecipes, log, onChange: () => app?.broadcast() });
const runner = createRunner({ config, log, onFinish: onRemoteFinish });
const prefs = {
  quietHours: () => state.quietHours ?? null,
  setQuietHours: (value) => {
    state.quietHours = value;
    save();
  },
  mutedUntil: () => state.mutedUntil ?? 0,
};
const actions = {
  away: control.away,
  setAway,
  projects: () => tracker.recentProjects(30).map((p) => p.name),
  continueSession,
  startTask,
  sessionActivity: describeActivity,
  terminal: () =>
    (state.terminal ?? [])
      .slice(-5)
      .map((t) => `- \`${clip(t.command, 80)}\` in ${t.cwd?.split(/[\\/]/).pop() ?? "?"}: ${t.ok ? "ok" : `failed (exit ${t.exitCode ?? "?"})`}, ${fmtDur(t.durationMs)}, ${fmtDur(Date.now() - t.at)} ago`)
      .join("\n"),
};
const brain = createBrain({ config, memory, tracker, prefs, actions, onError: (err) => log("brain:", err) });

// ---- pings

// Each task has one card. "start" posts it silently, "long", "working" and progress edit it in
// place, and an outcome (done, needs you, stuck) deletes it and posts it again at the bottom with
// a sound. Cards remember which session they belong to, so replying to one talks to that session.
async function notify(kind, session, extra = {}) {
  if (!chatId()) return null;
  const s = session;
  const card = { name: cardName(s), since: s.turnStart, usually: extra.usually ?? tracker.usual(s.project) };

  if (kind === "start") {
    if (!s.label) s.label = (await brain.summarize("start", s, extra)).label ?? null;
    const msg = await tg.send(chatId(), renderCard({ ...card, name: cardName(s), state: "working", step: stepOf(s) }, clock), { silent: true, html: true });
    indexCard(msg.message_id, s.id);
    log(`card start · ${s.project}`);
    return { messageId: msg.message_id, label: s.label };
  }
  if (kind === "long" || kind === "working" || kind === "resumed") {
    if (extra.replyTo) await tg.edit(chatId(), extra.replyTo, renderCard({ ...card, state: "working", long: extra.elapsed, step: stepOf(s) }, clock), undefined, { html: true });
    return null;
  }
  if (kind === "ask") {
    if (control.asking(s.id)) return null; // it's already here as buttons
    if (extra.replyTo) await tg.remove(chatId(), extra.replyTo);
    const msg = await tg.send(chatId(), renderCard({ ...card, state: "needs", gist: s.waitingFor }, clock), { silent: hushed(), html: true });
    indexCard(msg.message_id, s.id);
    memory.addMessage("assistant", `${card.name} needs you: ${s.waitingFor}`);
    log(`card ask · ${s.project}`);
    return { messageId: msg.message_id };
  }

  // an outcome: done, paused or failed
  const { verdict, gist } = await brain.summarize(kind, s, extra);
  const hold = kind === "done" || kind === "paused" ? control.stopHold(s.id) : null;
  const out = { ...card, state: verdict, took: extra.took, gist, hint: hold ? "reply to keep it going" : null };
  if (extra.replyTo) await tg.remove(chatId(), extra.replyTo);
  memory.addMessage("assistant", `${card.name}: ${verdict}. ${gist}`);
  log(`card ${verdict} · ${s.project}`);
  if (hold) {
    // a session waiting for your reply gets its own message with buttons, right away
    const text = renderCard(out, clock);
    let msg;
    try {
      msg = await tg.send(chatId(), text, { silent: hushed(), html: true, markup: control.stopButtons(hold) });
    } catch (err) {
      control.release(hold); // nothing to reply to, so the session shouldn't wait
      throw err;
    }
    control.attach(hold, msg.message_id, text, true);
    indexCard(msg.message_id, s.id);
    return { messageId: msg.message_id };
  }
  outbox.push({ card: out, sessionId: s.id, loud: verdict !== "paused" });
  clearTimeout(outboxTimer);
  outboxTimer = setTimeout(flushOutbox, BATCH_MS);
  return null;
}

// Tasks that finish within a few seconds of each other share one message.
const BATCH_MS = 6000;
let outbox = [];
let outboxTimer = null;
async function flushOutbox() {
  const batch = outbox;
  outbox = [];
  if (!batch.length) return;
  const silent = hushed() || !batch.some((b) => b.loud);
  try {
    const msg = await tg.send(chatId(), batch.length === 1 ? renderCard(batch[0].card, clock) : renderBatch(batch.map((b) => b.card)), { silent, html: true });
    if (batch.length === 1) indexCard(msg.message_id, batch[0].sessionId);
  } catch (err) {
    log("telegram:", err);
  }
}

// message id -> session id, so a reply to a card reaches its session (the last 300 cards)
function indexCard(messageId, sessionId) {
  state.cards = { ...(state.cards ?? {}), [messageId]: sessionId };
  const ids = Object.keys(state.cards);
  if (ids.length > 300) for (const id of ids.slice(0, ids.length - 300)) delete state.cards[id];
  save();
}

// what a working session is doing right now, from its transcript, in a few words
function stepOf(s) {
  if (s.status !== "working" || !s.transcript) return null;
  try {
    return activity(readTail(s.transcript, 256 * 1024)).now;
  } catch {
    return null;
  }
}

// Working cards follow along: every 20s, any card whose step changed is edited (silently).
setInterval(() => {
  for (const s of tracker.sessions()) {
    if (s.status !== "working" || !s.announced || !s.startMsgId) continue;
    const step = stepOf(s);
    if (!step || step === s.step) continue;
    s.step = step;
    tg.edit(chatId(), s.startMsgId, renderCard({ name: cardName(s), state: "working", since: s.turnStart, usually: tracker.usual(s.project), step }, clock), undefined, { html: true });
  }
}, 20_000).unref();

// ---- the pinned "right now" message

let boardTimer = null;
let boardText = null;
function refreshBoard(delay = 3000) {
  if (boardTimer || !chatId()) return;
  boardTimer = setTimeout(async () => {
    boardTimer = null;
    const text = renderBoard({ sessions: tracker.snapshot(), holds: control.list(), doneToday: doneToday(), away: control.away() });
    const markup = state.appUrl ? { inline_keyboard: [[{ text: "open claudia", web_app: { url: state.appUrl } }]] } : { inline_keyboard: [] };
    const key = text + JSON.stringify(markup);
    if (key === boardText) return;
    if (state.boardId && (await tg.update(chatId(), state.boardId, text, markup))) return void (boardText = key);
    try {
      const msg = await tg.send(chatId(), text, { silent: true, html: true, markup });
      state.boardId = msg.message_id;
      boardText = key;
      await tg.pin(chatId(), msg.message_id);
      save();
    } catch (err) {
      log("board:", err);
    }
  }, delay);
}
// elapsed minutes on the board move on even when nothing else happens
setInterval(() => tracker.sessions().some((s) => s.status === "working") && refreshBoard(0), 60_000).unref();

const say = (text, opts) => (chatId() ? tg.send(chatId(), text, opts).catch((err) => log("telegram:", err)) : null);

// ---- hook events

// Events for one session are handled in order; different sessions don't wait on each other.
const queues = new Map();
function enqueue(ev) {
  const id = ev.session_id ?? "unknown";
  const next = (queues.get(id) ?? Promise.resolve()).then(() => onEvent(ev)).catch((err) => log("event:", err));
  queues.set(id, next);
  next.then(() => queues.get(id) === next && queues.delete(id));
}

async function onEvent(ev) {
  if (ev.hook_event_name === "UserPromptSubmit" && !ev.claudia_remote) {
    // you typed on the laptop, so you're not away anymore
    if (control.away()) {
      setAway(false);
      say("you're back at the laptop, so away mode is off", { silent: true });
    }
    if (config.learnHabits && ev.prompt) {
      state.prompts = [...(state.prompts ?? []), { text: clip(ev.prompt, 500), project: ev.cwd?.split(/[\\/]/).pop(), at: Date.now() }].slice(-300);
    }
  }
  await tracker.handle(ev);
}

function setAway(on) {
  control.setAway(on);
  if (on) keepAwakeIfNeeded();
}

// ---- acting on the laptop

// "plan" first: it plans, and the plan comes to your phone to approve or change before anything is touched
const PLAN_FIRST = "Before changing anything, make a plan and present it with ExitPlanMode so I can approve it from my phone.";

function continueSession(query, instruction, plan = false) {
  const s = tracker.find(query);
  if (!s) return "no session like that in the last day";
  return continueThis(s, instruction, plan);
}

function continueThis(s, instruction, plan = false) {
  // a session held open for your reply takes it in place, so it can't switch modes; ask it to plan instead
  if (control.continueSession(s.id, plan ? `${instruction}\n\n${PLAN_FIRST}` : instruction)) return `sent to ${displayName(s)}, it's on it`;
  if (s.status === "working" || s.status === "waiting") {
    // it can't be interrupted, so the instruction waits and is handed over the moment it stops
    s.queued = s.queued ? `${s.queued}\n\n${instruction}` : instruction;
    save();
    return `${displayName(s)} is mid-task. it gets this as soon as it stops`;
  }
  const started = runner.run({ cwd: s.cwd, prompt: instruction, resume: s.id, ...(plan ? { permissionMode: "plan" } : {}) });
  if (!started.ok) return `couldn't: ${started.error}`;
  return `resumed ${displayName(s)} in the background. if it's open in the desktop app, reopen it there to see the new turn`;
}

function startTask(project, task, plan = false) {
  const q = project.toLowerCase();
  const match = tracker.recentProjects(30).find((p) => p.name.toLowerCase() === q) ?? tracker.recentProjects(30).find((p) => p.name.toLowerCase().includes(q));
  if (!match) return `no project called ${project} among the recent ones`;
  const started = runner.run({ cwd: match.cwd, prompt: task, ...(plan ? { permissionMode: "plan" } : {}) });
  if (!started.ok) return `couldn't start it: ${started.error}`;
  return plan ? `started in ${match.name}. it'll send you its plan to approve first` : `started in ${match.name}. its card shows up in a moment, and questions come as buttons`;
}

function takeQueued(sessionId) {
  const s = sessionById(sessionId);
  if (!s?.queued) return null;
  const q = s.queued;
  s.queued = null;
  save();
  return q;
}

function replyToSession(msg, sessionId, text) {
  const s = sessionById(sessionId);
  const answer = s ? continueThis(s, text) : "that session is gone from the laptop. /new starts a fresh one";
  return tg.send(chatId(), answer, { silent: true, replyTo: msg.message_id });
}

// "fix it" under a failed command: a new session in that folder gets the command and its output
function replyToTerminal(msg, t, text) {
  const what = t.ok ? "finished" : `failed${t.exitCode ? ` with exit code ${t.exitCode}` : ""}`;
  const prompt = `${text}\n\nContext: in my terminal in this folder, \`${t.command}\` ${what} after ${fmtDur(t.durationMs)}. Its last output:\n${t.output.join("\n") || "(none captured)"}`;
  const started = runner.run({ cwd: t.cwd, prompt });
  return tg.send(chatId(), started.ok ? "on it. its card shows up in a moment" : `couldn't start it: ${started.error}`, { silent: true, replyTo: msg.message_id });
}

// ---- your terminal: long commands finishing

async function onTerminal(t) {
  t.ok ??= true; // the shell couldn't tell: say it finished rather than claim it failed
  state.terminal = [...(state.terminal ?? []), { command: t.command, ok: t.ok, exitCode: t.exitCode, durationMs: t.durationMs, cwd: t.cwd, at: Date.now() }].slice(-20);
  save();
  if (!chatId()) return;
  const loud = !t.ok || t.durationMs >= 3 * 60_000; // short successes arrive quietly
  const msg = await tg.send(chatId(), renderTerminal(t), { silent: hushed() || !loud, html: true });
  const cards = { ...(state.terminalCards ?? {}), [msg.message_id]: t };
  state.terminalCards = Object.fromEntries(Object.entries(cards).slice(-30));
  save();
  log(`terminal ${t.ok ? "ok" : "failed"} · ${clip(t.command, 40)}`);
}

// a few lines on what a session has done this turn, for Claudia's look_at_session
function describeActivity(s) {
  const a = s.transcript ? activity(readTail(s.transcript, 256 * 1024)) : null;
  if (!a) return "";
  const lines = [];
  if (a.now) lines.push(`right now: ${a.now}`);
  if (a.tests) lines.push(`latest tests: ${a.tests.failed} failed, ${a.tests.passed} passed`);
  if (a.files.length) lines.push(`edited: ${a.files.join(", ")}`);
  for (const e of a.events) lines.push(`- ${e.kind}${e.ok === false ? " (failed)" : ""}: ${e.text}`);
  return lines.join("\n");
}

function onRemoteFinish({ cwd, error, needsLogin }) {
  if (!error) return; // the session's own hooks already pinged
  const where = cwd.split(/[\\/]/).pop();
  say(needsLogin ? `couldn't run it in ${where}: the claude cli on the laptop needs a login. open a terminal, run claude, then /login` : `the task in ${where} failed: ${error}`);
}

// ---- Telegram

async function onUpdate(update) {
  if (update.callback_query) return onButton(update.callback_query);
  const msg = update.message;
  if (!msg?.chat) return;
  const text = (msg.text ?? msg.caption ?? "").trim();
  if (!chatId()) return pair(msg, text);
  if (msg.chat.id !== chatId()) return; // she only talks to you

  if (msg.photo?.length) return onPhoto(msg, text);
  if (!text) return tg.send(chatId(), "i can read text and photos for now");
  if (newTask?.promptId && msg.reply_to_message?.message_id === newTask.promptId) return launchNew(text);
  if (control.onReply(msg, text)) return;
  const replied = msg.reply_to_message?.message_id;
  if (replied && !text.startsWith("/")) {
    // a reply to a session's card is for that session (a question about it goes to Claudia instead)
    const sessionId = state.cards?.[replied];
    if (sessionId && !text.trim().endsWith("?")) return replyToSession(msg, sessionId, text);
    const t = state.terminalCards?.[replied];
    if (t) return replyToTerminal(msg, t, text);
  }

  const [first, ...rest] = text.split(/\s+/);
  const arg = rest.join(" ");
  switch (first.split("@")[0].toLowerCase()) {
    case "/start":
    case "/help":
      return tg.send(chatId(), HELP);
    case "/status":
      return tg.send(chatId(), `${control.away() ? "away mode on\n\n" : ""}${tracker.describe()}`);
    case "/away":
      setAway(true);
      return tg.send(chatId(), `away mode on. finished sessions will wait up to ${config.holdMinutes}m for your reply here, and questions come as buttons. /back when you're at the laptop`);
    case "/back":
      setAway(false);
      return tg.send(chatId(), "welcome back. nothing waits on your phone now");
    case "/new":
      return chooseProject();
    case "/laptop":
      return laptopPanel();
    case "/app":
      return state.appUrl
        ? tg.send(chatId(), "here you go", { markup: { inline_keyboard: [[{ text: "open claudia", web_app: { url: state.appUrl } }]] } })
        : tg.send(chatId(), "the app isn't reachable right now. check that cloudflared is installed, then npm run restart");
    case "/mute":
      state.mutedUntil = Date.now() + parseDuration(arg, 3_600_000);
      save();
      return tg.send(chatId(), `ok, no sounds until ${clock(state.mutedUntil)}. you'll still get messages, just quietly`);
    case "/unmute":
      state.mutedUntil = 0;
      save();
      return tg.send(chatId(), "sound's back on");
    case "/notes":
      return tg.send(chatId(), memory.notes().map((n) => `#${n.id} ${n.text}`).join("\n") || "my notebook's empty so far");
    case "/forget":
      return tg.send(chatId(), memory.forget(arg.replace("#", "")) ? "gone" : "no note with that number. /notes shows them");
  }
  return chat(msg, text);
}

async function chat(msg, text, images = []) {
  const quoted = msg.reply_to_message?.text;
  const input = quoted ? `(replying to: "${clip(quoted, 300)}")\n${text}` : text;
  tg.typing(chatId());
  const typing = setInterval(() => tg.typing(chatId()), 4500);
  let answer;
  try {
    answer = await brain.reply(input, images);
  } catch (err) {
    log("chat:", err);
    answer = explainError(err);
  } finally {
    clearInterval(typing);
  }
  memory.addMessage("user", images.length ? `[photo] ${input}` : input);
  memory.addMessage("assistant", answer);
  await tg.send(chatId(), answer);
}

async function onPhoto(msg, caption) {
  const photo = msg.photo.at(-1); // largest size
  const bytes = await tg.download(photo.file_id);
  if (msg.reply_to_message && newTask?.promptId !== msg.reply_to_message.message_id) {
    // a screenshot for a waiting session: save it where that session can read it
    const dir = join(HOME, "inbox");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${Date.now()}.jpg`);
    writeFileSync(file, bytes);
    if (control.onReply(msg, `${caption || "Take a look at this screenshot and fix what's wrong"} (screenshot from my phone: ${file})`)) return;
    rmSync(file, { force: true });
  }
  return chat(msg, caption, [bytes.toString("base64")]);
}

async function onButton(q) {
  if (q.from?.id !== chatId()) return tg.answerButton(q.id);
  if (await control.onButton(q)) return;
  const [op, a, b] = String(q.data ?? "").split(":");
  await tg.answerButton(q.id);
  const messageId = q.message?.message_id;
  switch (op) {
    case "nw":
      return pickProject(Number(a), messageId);
    case "nr": {
      const recipe = loadRecipes().find((r) => r.key === a);
      return recipe && launchNew(recipe.prompt, recipe.label);
    }
    case "lp":
      return laptopAction(a, b, messageId);
    case "hs":
      return answerHabit(a === "yes", messageId);
  }
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
  await tg.send(chatId(), hello);
  memory.addMessage("assistant", hello);
}

// ---- /new: start a task in a recent project

let newTask = null;

async function chooseProject() {
  const projects = tracker.recentProjects(8);
  if (!projects.length) return tg.send(chatId(), "i haven't seen any projects yet. open one in claude code once and it'll show up here");
  newTask = { projects };
  const buttons = projects.map((p, i) => ({ text: p.name, callback_data: `nw:${i}` }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return tg.send(chatId(), "where should it run?", { markup: { inline_keyboard: rows } });
}

async function pickProject(i, messageId) {
  const project = newTask?.projects?.[i];
  if (!project) return;
  newTask.cwd = project.cwd;
  newTask.name = project.name;
  const recipes = loadRecipes().filter((r) => r.key !== "continue").slice(0, 6);
  const rows = [];
  for (let j = 0; j < recipes.length; j += 3) rows.push(recipes.slice(j, j + 3).map((r) => ({ text: r.label, callback_data: `nr:${r.key}` })));
  await tg.edit(chatId(), messageId, `in ${project.name}. pick a shortcut, or reply below with the task`, { inline_keyboard: rows });
  const prompt = await tg.send(chatId(), `what should it do in ${project.name}?`, {
    markup: { force_reply: true, input_field_placeholder: "describe the task" },
  });
  newTask.promptId = prompt.message_id;
}

async function launchNew(prompt, label = null) {
  if (!newTask?.cwd) return;
  const { cwd, name } = newTask;
  newTask = null;
  const started = runner.run({ cwd, prompt });
  await say(started.ok ? `started ${label ? `"${label}" ` : ""}in ${name}. you'll get the usual pings, and it waits for you when it's done` : `couldn't start it: ${started.error}`);
}

// ---- /laptop

async function laptopPanel() {
  const [battery, cpu] = await Promise.all([laptop.battery().catch(() => null), laptop.cpuPercent().catch(() => null)]);
  const mem = laptop.memory();
  const awakeUntil = laptop.keepAwakeUntil();
  const lines = [
    battery ? `battery ${battery.percent}%${battery.onBattery ? ", on battery" : battery.charging ? ", charging" : ", plugged in"}` : "no battery (plugged in)",
    `cpu ${cpu ?? "?"}% · memory ${mem.usedPct}% of ${mem.totalGb} GB`,
    awakeUntil ? `keeping it awake until ${clock(awakeUntil)}` : "sleep: normal",
    `${tracker.sessions().filter((s) => s.status === "working").length} sessions working · ${runner.count()} started from your phone`,
  ];
  return tg.send(chatId(), lines.join("\n"), { markup: laptopButtons() });
}

function laptopButtons() {
  const awake = laptop.keepAwakeUntil()
    ? { text: "Let it sleep", callback_data: "lp:sleep" }
    : { text: "Keep awake 2h", callback_data: "lp:awake" };
  return { inline_keyboard: [[{ text: "Screenshot", callback_data: "lp:shot" }, awake], [{ text: "Node processes", callback_data: "lp:procs" }]] };
}

async function laptopAction(action, arg, messageId) {
  if (action === "shot") {
    const file = join(HOME, "inbox", `screen-${Date.now()}.jpg`);
    mkdirSync(join(HOME, "inbox"), { recursive: true });
    try {
      await laptop.screenshot(file);
      await tg.sendPhoto(chatId(), file, `screen at ${clock(Date.now())}`);
    } catch (err) {
      await say(`couldn't take a screenshot: ${err.message}`);
    } finally {
      rmSync(file, { force: true });
    }
    return;
  }
  if (action === "awake" || action === "sleep") {
    if (action === "awake") laptop.keepAwake(120);
    else laptop.stopKeepAwake();
    state.manualAwake = action === "awake";
    return tg.setButtons(chatId(), messageId, laptopButtons());
  }
  if (action === "procs") {
    const procs = (await laptop.nodeProcesses()).slice(0, 8);
    if (!procs.length) return say("no node processes running besides me");
    const lines = procs.map((p) => `${p.pid} · ${p.mb} MB · ${clip(p.command, 70)}`);
    const rows = procs.map((p) => [{ text: `Stop ${p.pid} (${p.mb} MB)`, callback_data: `lp:kill:${p.pid}` }]);
    return tg.send(chatId(), `node processes, biggest first:\n\n${lines.join("\n")}\n\nonly stop the ones you recognise`, { markup: { inline_keyboard: rows } });
  }
  if (action === "kill") {
    const ok = laptop.killProcess(Number(arg));
    return say(ok ? `stopped ${arg}` : `couldn't stop ${arg}, it may already be gone`, { silent: true });
  }
}

// ---- background checks: keep awake while away, battery, daily digest

function keepAwakeIfNeeded() {
  const working = tracker.sessions().some((s) => s.status === "working" || s.status === "background");
  if (config.autoKeepAwake && control.away() && working) laptop.keepAwake(15); // extended while it stays true
}

async function checkBattery() {
  const working = tracker.sessions().filter((s) => s.status === "working");
  if (!working.length && !control.away()) return;
  const b = await laptop.battery().catch(() => null);
  if (!b) return;
  const alerts = (state.batteryAlerts ??= {});
  if (!b.onBattery) {
    state.batteryAlerts = {};
    return;
  }
  if (!alerts.unplugged && working.length) {
    alerts.unplugged = true;
    await say(`heads up: the laptop's running on battery (${b.percent}%) with ${working.length} session${working.length > 1 ? "s" : ""} working`);
  } else if (!alerts.low && b.percent <= 20) {
    alerts.low = true;
    await say(`laptop battery's at ${b.percent}%. plug it in or sessions stop when it dies`);
  }
  save();
}

const localDate = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: config.timezone });
const localTime = () => new Date().toLocaleTimeString("en-GB", { timeZone: config.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

async function dailyDigest() {
  if (!config.digestTime || !chatId() || localTime() < config.digestTime || state.lastDigest === localDate()) return;
  state.lastDigest = localDate();
  save();
  const since = Date.now() - 24 * 3_600_000;
  const done = (state.log ?? []).filter((e) => e.at > since);
  const open = tracker.sessions().filter((s) => s.status !== "idle");
  const facts = [
    `finished in the last 24h (${done.length}):`,
    ...done.map((e) => `- ${e.label ? `${e.label} (${e.project})` : e.project}: ${fmtDur(e.took * 1000)}`),
    `still open: ${open.map((s) => `${displayName(s)} (${s.status})`).join(", ") || "nothing"}`,
  ].join("\n");
  if (done.length || open.length) {
    const { text } = await brain.ping("digest", {}, { facts });
    await say(text, { silent: true });
    memory.addMessage("assistant", text);
  }
  await suggestHabit();
}

async function suggestHabit() {
  if (!config.learnHabits) return;
  const recent = (state.prompts ?? []).filter((p) => p.at > Date.now() - 14 * 86_400_000);
  const recipes = loadRecipes().map((r) => r.label);
  const idea = await brain.suggestShortcut(recent, [...recipes, ...(state.declinedHabits ?? [])]);
  if (!idea) return;
  state.pendingHabit = idea;
  save();
  await say(`you've asked for something like "${idea.label}" about ${idea.times} times lately. want a shortcut button for it?\n\n${clip(idea.prompt, 600)}`, {
    silent: true,
    markup: { inline_keyboard: [[{ text: "Save shortcut", callback_data: "hs:yes" }, { text: "No thanks", callback_data: "hs:no" }]] },
  });
}

async function answerHabit(yes, messageId) {
  const idea = state.pendingHabit;
  if (!idea) return tg.setButtons(chatId(), messageId);
  delete state.pendingHabit;
  if (yes) saveRecipe({ label: idea.label, prompt: idea.prompt });
  else state.declinedHabits = [...(state.declinedHabits ?? []), idea.label].slice(-30);
  save();
  await tg.setButtons(chatId(), messageId);
  await say(yes ? `saved. "${idea.label}" shows up on finished sessions now` : "ok, won't suggest that one again", { silent: true });
}

// ---- the Telegram Mini App

let laptopInfo = { battery: null, cpu: null, mem: laptop.memory(), awakeUntil: 0 };
let laptopTimer = null;
let laptopTicks = 0;

async function refreshLaptop() {
  const withBattery = laptopTicks++ % 6 === 0; // battery needs PowerShell, so only once a minute
  laptopInfo = {
    battery: withBattery ? await laptop.battery().catch(() => null) : laptopInfo.battery,
    cpu: await laptop.cpuPercent(300).catch(() => null),
    mem: laptop.memory(),
    awakeUntil: laptop.keepAwakeUntil(),
  };
  app?.broadcast();
}

const sessionById = (id) => tracker.state.sessions[id] ?? null;

function doneToday() {
  const today = localDate();
  const done = (state.log ?? []).filter((e) => localDate(e.at) === today);
  return { count: done.length, totalMs: done.reduce((sum, e) => sum + e.took * 1000, 0) };
}

const appApi = {
  async state() {
    return {
      now: Date.now(),
      name: config.name,
      away: control.away(),
      muted: muted(),
      sessions: tracker.snapshot(),
      holds: control.list(),
      doneToday: doneToday(),
      terminal: (state.terminal ?? []).slice(-6).reverse(),
      laptop: { ...laptopInfo, awakeUntil: laptop.keepAwakeUntil() },
      projects: tracker.recentProjects(12),
      recipes: loadRecipes().map(({ key, label, prompt }) => ({ key, label, prompt })),
    };
  },
  async session(id) {
    const s = sessionById(id);
    if (!s) return { error: "that session is gone" };
    return {
      ...tracker.snapshot().find((x) => x.id === id),
      timeline: timeline(readTail(s.transcript)),
      activity: s.transcript ? activity(readTail(s.transcript, 256 * 1024)) : null,
      hold: control.list().find((h) => h.sessionId === id && h.kind === "stop")?.id ?? null,
    };
  },
  async processes() {
    return { processes: (await laptop.nodeProcesses()).slice(0, 12) };
  },
  watching(count) {
    if (count && !laptopTimer) {
      laptopTicks = 0;
      refreshLaptop().catch((err) => log("laptop:", err));
      laptopTimer = setInterval(() => refreshLaptop().catch((err) => log("laptop:", err)), 10_000);
    } else if (!count && laptopTimer) {
      clearInterval(laptopTimer);
      laptopTimer = null;
    }
  },
  actions: {
    away: ({ on }) => (setAway(Boolean(on)), { ok: true }),
    hold: ({ id, action, value }) => (control.act(String(id), String(action), value) ? { ok: true } : { error: "that one's already settled" }),
    reply({ sessionId, text }) {
      const s = sessionById(sessionId);
      if (!s || !String(text ?? "").trim()) return { error: "nothing to send" };
      return { ok: true, message: continueThis(s, clip(text, 4000)) };
    },
    recipe({ sessionId, key }) {
      const s = sessionById(sessionId);
      const recipe = loadRecipes().find((r) => r.key === key);
      if (!s || !recipe) return { error: "unknown shortcut" };
      return { ok: true, message: continueThis(s, recipe.prompt) };
    },
    task({ cwd, prompt, careful = true }) {
      // only folders Claude Code has actually worked in, never an arbitrary path from the network
      const project = tracker.recentProjects(30).find((p) => p.cwd === cwd);
      if (!project || !String(prompt ?? "").trim()) return { error: "pick a project and describe the task" };
      const started = runner.run({ cwd, prompt: clip(prompt, 8000), permissionMode: careful ? config.remotePermissionMode : "bypassPermissions" });
      return started.ok ? { ok: true, message: `started in ${project.name}` } : { error: started.error };
    },
    async laptop({ action, pid }) {
      if (action === "awake") laptop.keepAwake(120);
      else if (action === "sleep") laptop.stopKeepAwake();
      else if (action === "shot") {
        const file = join(HOME, "inbox", `screen-${Date.now()}.jpg`);
        mkdirSync(join(HOME, "inbox"), { recursive: true });
        try {
          await laptop.screenshot(file);
          await tg.sendPhoto(chatId(), file, `screen at ${clock(Date.now())}`);
        } finally {
          rmSync(file, { force: true });
        }
        return { ok: true, message: "sent to your chat" };
      } else if (action === "kill") {
        // only a node process that's in the current list, and never this daemon
        const known = (await laptop.nodeProcesses()).some((p) => p.pid === Number(pid));
        if (!known || !laptop.killProcess(Number(pid))) return { error: "couldn't stop it, it may already be gone" };
      } else return { error: "unknown action" };
      await refreshLaptop();
      return { ok: true };
    },
  },
};

async function startApp() {
  if (config.miniApp === false) return;
  app = createAppServer({ config, api: appApi, log });
  try {
    await app.listen(config.appPort);
  } catch (err) {
    app = null;
    return log(`mini app: can't listen on ${config.appPort}:`, err);
  }
  log(`mini app on 127.0.0.1:${config.appPort}`);
  const pointMenuAt = async (url) => {
    state.appUrl = url;
    save();
    if (chatId()) {
      await tg
        .call("setChatMenuButton", { chat_id: chatId(), menu_button: { type: "web_app", text: "claudia", web_app: { url } } })
        .catch((err) => log("menu button:", err));
    }
    log(`mini app is at ${url}`);
  };
  if (config.appUrl) return pointMenuAt(config.appUrl); // your own domain or named tunnel
  const bin = findCloudflared(config);
  if (!bin) return log("mini app: cloudflared not found, so it's only reachable on this laptop");
  startTunnel({ bin, port: config.appPort, onUrl: pointMenuAt, log });
}

const every = (ms, fn) => setInterval(() => fn().catch((err) => log("timer:", err)), ms).unref();
every(60_000, async () => keepAwakeIfNeeded());
every(180_000, checkBattery);
every(60_000, dailyDigest);

// ---- local HTTP: hooks and the CLI talk to this

const startedAt = Date.now();
let bot = null;

const server = createServer((req, res) => {
  const reply = (code, body = {}) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/health") {
    return reply(200, { ok: true, pid: process.pid, paired: Boolean(chatId()), bot, startedAt, away: control.away() });
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
    let ev = null;
    try {
      ev = JSON.parse(body || "{}");
    } catch {}
    switch (req.url) {
      case "/event":
        reply(200); // answer right away; hooks shouldn't wait on Telegram or the model
        if (ev) enqueue(ev);
        return;
      case "/decide": {
        // hooks that can carry an answer back: registered before the event is tracked, so a "done" ping can attach to it
        // an instruction you sent while it was working is handed over now, so it keeps going
        const queued = ev?.hook_event_name === "Stop" ? takeQueued(ev.session_id) : null;
        const answer = queued ? Promise.resolve({ decision: "block", reason: `${config.name} replied from Telegram: ${queued}` }) : ev ? control.decide(ev) : Promise.resolve({});
        if (ev) enqueue(ev);
        // its "done" card goes out first, then the new turn starts like any other
        if (queued) enqueue({ hook_event_name: "UserPromptSubmit", session_id: ev.session_id, cwd: ev.cwd, transcript_path: ev.transcript_path, prompt: queued, claudia_remote: true });
        return reply(200, await answer);
      }
      case "/terminal": {
        reply(200);
        const t = parseTerminalEvent(ev);
        if (t) onTerminal(t).catch((err) => log("terminal:", err));
        return;
      }
      case "/status":
        return reply(200, { text: tracker.describe(), muted: muted(), away: control.away() });
      case "/test":
        if (!chatId()) return reply(409, { error: "not paired yet" });
        await say("test ping from the laptop. if you see this, we're good");
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
  startApp().catch((err) => log("mini app:", err));
});
