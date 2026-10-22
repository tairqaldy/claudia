#!/usr/bin/env node
// Claude Code runs this on each hook event. It hands the event to Claudia's daemon and starts the
// daemon if it isn't running. It never prints and always exits 0, so it can't disturb a session.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PATHS, loadConfig } from "./config.mjs";
import { sleep } from "./util.mjs";

setTimeout(() => process.exit(0), 10_000).unref(); // hard stop, whatever happens

const config = loadConfig();
if (!config.telegramToken) process.exit(0); // not set up yet

let body = "";
for await (const chunk of process.stdin) body += chunk;

const send = () =>
  fetch(`http://127.0.0.1:${config.port}/event`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-claudia": "1" },
    body,
    signal: AbortSignal.timeout(2000),
  });

try {
  await send();
} catch {
  if (wake()) {
    for (let i = 0; i < 10; i++) {
      await sleep(400);
      try {
        await send();
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
