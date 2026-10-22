#!/usr/bin/env node
// Claude Code runs this on each hook event. It hands the event to Claudia's daemon and starts the
// daemon if it isn't running. It never fails and never prints anything except a hook decision.
//
//   hook.mjs claudia-hook           fire and forget (async hooks)
//   hook.mjs claudia-hook --decide  wait for Claudia's answer (Stop, questions, permissions). She
//                                   answers at once unless you're away and replying from your phone.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS, loadConfig } from "./config.mjs";
import { sleep } from "./util.mjs";

const config = loadConfig();
const decide = process.argv.includes("--decide");
const waitMs = decide ? config.holdMinutes * 60_000 + 30_000 : 2000;
setTimeout(() => process.exit(0), waitMs + 8000).unref(); // hard stop, whatever happens
if (!config.telegramToken) process.exit(0); // not set up yet

let body = "";
for await (const chunk of process.stdin) body += chunk;
if (process.env.CLAUDIA_REMOTE) {
  // a session Claudia started from your phone
  try {
    body = JSON.stringify({ ...JSON.parse(body), claudia_remote: true });
  } catch {}
}

const post = (path, timeoutMs) =>
  fetch(`http://127.0.0.1:${config.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claudia": "1" },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });

try {
  const res = await post(decide ? "/decide" : "/event", waitMs);
  if (decide) {
    const answer = await res.json();
    if (answer && Object.keys(answer).length) process.stdout.write(JSON.stringify(answer));
  }
} catch (err) {
  // daemon not running: start it and deliver the event; there's nobody to decide anything yet
  if (err?.name !== "TimeoutError" && wake()) {
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      try {
        await post("/event", 2000);
        break;
      } catch {}
    }
  }
}
process.exit(0);

// Starts the daemon in the background, at most once a minute in case it can't start.
function wake() {
  try {
    if (Date.now() - Number(readFileSync(PATHS.spawnLock, "utf8")) < 60_000) return false;
  } catch {}
  mkdirSync(dirname(PATHS.spawnLock), { recursive: true });
  writeFileSync(PATHS.spawnLock, String(Date.now()));
  const daemon = join(dirname(fileURLToPath(import.meta.url)), "daemon.mjs");
  spawn(process.execPath, [daemon], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return true;
}
