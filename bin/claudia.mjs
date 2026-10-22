#!/usr/bin/env node
// claudia setup | start | stop | restart | status | test | logs | hooks on|off | autostart on|off | uninstall
import Anthropic from "@anthropic-ai/sdk";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { HOME, PATHS, ROOT, loadConfig, saveConfig } from "../src/config.mjs";
import {
  SETTINGS,
  autostartEnabled,
  disableAutostart,
  enableAutostart,
  hooksInstalled,
  installHooks,
  removeHooks,
} from "../src/install.mjs";
import { createTelegram } from "../src/telegram.mjs";
import { sleep } from "../src/util.mjs";

const [command = "help", ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(
  rest.filter((a) => a.startsWith("--")).map((a) => {
    const [key, ...value] = a.slice(2).split("=");
    return [key, value.length ? value.join("=") : true];
  }),
);
const positional = rest.filter((a) => !a.startsWith("--"));

async function daemon(path, method = "POST") {
  try {
    const res = await fetch(`http://127.0.0.1:${loadConfig().port}${path}`, {
      method,
      headers: { "x-claudia": "1" },
      signal: AbortSignal.timeout(3000),
    });
    return await res.json();
  } catch {
    return null;
  }
}
const health = () => daemon("/health", "GET");

async function start() {
  const running = await health();
  if (running) return console.log(`claudia's already up (pid ${running.pid})`);
  if (!loadConfig().telegramToken) return console.log("not set up yet. run: npm run setup");
  spawn(process.execPath, [join(ROOT, "src", "daemon.mjs")], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const h = await health();
    if (h) return console.log(`claudia's up (pid ${h.pid}, port ${loadConfig().port})`);
  }
  console.log("she didn't come up. check: npm run logs");
}

async function stop() {
  if (!(await health())) return console.log("claudia isn't running");
  await daemon("/stop");
  for (let i = 0; i < 20 && (await health()); i++) await sleep(200);
  console.log("claudia stopped");
}

async function status() {
  const h = await health();
  const cfg = loadConfig();
  console.log(h ? `running · pid ${h.pid} · port ${cfg.port} · @${h.bot ?? "?"}` : "not running (npm start)");
  console.log(`paired: ${cfg.chatId ? "yes" : "no"} · hooks: ${hooksInstalled() ? "on" : "off"} · autostart: ${autostartEnabled() ? "on" : "off"} · brain: ${cfg.anthropicKey ? cfg.model : "off"}`);
  if (h) {
    const s = await daemon("/status");
    if (s) console.log(`${s.muted ? "muted\n" : ""}\n${s.text}`);
  }
}

async function test() {
  if (!(await health())) return console.log("claudia isn't running (npm start)");
  const res = await daemon("/test");
  console.log(res?.error ?? "sent. check telegram");
}

function logs() {
  try {
    console.log(readFileSync(PATHS.log, "utf8").trimEnd().split("\n").slice(-40).join("\n"));
  } catch {
    console.log("no logs yet");
  }
}

function hooks() {
  if (positional[0] === "off") {
    removeHooks();
    return console.log(`hooks removed from ${SETTINGS}`);
  }
  installHooks();
  console.log(`hooks added to ${SETTINGS}`);
}

function autostart() {
  if (positional[0] === "off") {
    disableAutostart();
    return console.log("autostart off");
  }
  console.log(`autostart on: ${enableAutostart()}`);
}

async function uninstall() {
  await stop();
  removeHooks();
  disableAutostart();
  if (flags.purge) rmSync(HOME, { recursive: true, force: true });
  console.log(flags.purge ? `removed hooks, autostart and ${HOME}` : `removed hooks and autostart. her memory and keys are still in ${HOME} (add --purge to delete)`);
}

async function setup() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question, current, { secret = false } = {}) => {
    if (flags.yes && current) return current;
    const shown = current ? ` [${secret ? `…${String(current).slice(-4)}` : current}]` : "";
    return (await rl.question(`${question}${shown}: `)).trim() || current || "";
  };
  const yes = async (question) => flags.yes || !/^n/i.test((await rl.question(`${question} [Y/n]: `)).trim());
  const cfg = loadConfig();
  console.log("\nhi! let's set up claudia. press enter to keep what's in [brackets].\n");

  const name = flags.name || (await ask("what should she call you", cfg.name));

  // Telegram
  console.log("\n1. telegram. make a bot with @BotFather (/newbot) and paste its token.");
  let telegramToken = flags["telegram-token"] || cfg.telegramToken;
  let bot;
  for (;;) {
    telegramToken = await ask("bot token", telegramToken, { secret: true });
    try {
      bot = await createTelegram(telegramToken).me();
      console.log(`   ok, that's @${bot.username}`);
      break;
    } catch (err) {
      console.log(`   telegram says no: ${err.message}. copy the token again from BotFather.`);
      if (flags.yes) process.exit(1);
      telegramToken = "";
    }
  }

  // Anthropic
  console.log("\n2. her brain (optional but recommended). an anthropic api key from console.anthropic.com.");
  console.log("   without it she still pings you, just with plain templates and no chat.");
  let anthropicKey = flags["anthropic-key"] || cfg.anthropicKey || "";
  let anthropicWorkspace = flags.workspace || cfg.anthropicWorkspace || "";
  for (;;) {
    anthropicKey = await ask("api key (enter to skip)", anthropicKey, { secret: true });
    if (!anthropicKey) break;
    try {
      const client = new Anthropic({
        apiKey: anthropicKey,
        ...(anthropicWorkspace ? { defaultHeaders: { "anthropic-workspace-id": anthropicWorkspace } } : {}),
      });
      await client.messages.create({ model: cfg.model, max_tokens: 256, output_config: { effort: "low" }, messages: [{ role: "user", content: "hi" }] });
      console.log("   ok, brain works");
      break;
    } catch (err) {
      console.log(`   that didn't work: ${err.message}`);
      if (flags.yes) process.exit(1);
      if (err instanceof Anthropic.BadRequestError) {
        anthropicWorkspace = (await rl.question("   if your key needs a workspace id (wrkspc_…), paste it, else enter: ")).trim() || anthropicWorkspace;
      } else anthropicKey = "";
    }
  }

  const pairCode = cfg.chatId ? null : randomBytes(4).toString("hex");
  saveConfig({ name, telegramToken, anthropicKey: anthropicKey || null, anthropicWorkspace: anthropicWorkspace || null, pairCode });

  console.log("\n3. hooking into claude code");
  if (await yes(`   add claudia's hooks to ${SETTINGS}?`)) {
    installHooks();
    console.log("   done (a backup of your settings is next to it, .before-claudia)");
  }
  if (await yes("   start her automatically when you log in?")) console.log(`   done: ${enableAutostart()}`);
  rl.close();

  await stop().catch(() => {});
  await start();

  if (!pairCode) return console.log("\nall set. she's still paired with your chat.\n");
  console.log(`\n4. last step: open this link on your phone and tap Start\n\n   https://t.me/${bot.username}?start=${pairCode}\n`);
  for (let i = 0; i < 150; i++) {
    await sleep(2000);
    if ((await health())?.paired) return console.log("paired! she just said hi on telegram.\n");
  }
  console.log("didn't see you tap Start yet. the link keeps working, no need to rerun setup.\n");
}

function help() {
  console.log(`claudia: telegram pings for your claude code sessions

  npm run setup        first-time setup (keys, hooks, autostart, pairing)
  npm start            start her in the background
  npm stop             stop her
  npm run status       is she running, and what she sees
  npm run logs         last log lines

  node bin/claudia.mjs test              send a test ping
  node bin/claudia.mjs hooks on|off      add or remove the claude code hooks
  node bin/claudia.mjs autostart on|off  start at login or not
  node bin/claudia.mjs uninstall [--purge]`);
}

const commands = { setup, start, stop, restart: async () => (await stop(), start()), status, test, logs, hooks, autostart, uninstall, help };
await (commands[command] ?? help)();
