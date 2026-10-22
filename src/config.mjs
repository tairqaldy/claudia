import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = process.env.CLAUDIA_HOME || join(homedir(), ".claudia");
export const PATHS = {
  config: join(HOME, "config.json"),
  state: join(HOME, "state.json"),
  memory: join(HOME, "memory.json"),
  log: join(HOME, "claudia.log"),
  spawnLock: join(HOME, "last-spawn"),
};

const DEFAULTS = {
  port: 47833,
  model: "claude-haiku-5-5",
  quietSeconds: 30, // turns shorter than this never ping you
  askDelaySeconds: 20, // grace period before "needs you" pings, in case you're at the laptop
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  name: userInfo().username,
};

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const text = JSON.stringify(data, null, 2) + "\n";
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch {
    writeFileSync(path, text); // rename can fail on Windows while another process holds the file
  }
}

export function loadConfig() {
  const file = readJson(PATHS.config, {});
  const env = process.env;
  return {
    ...DEFAULTS,
    ...file,
    telegramToken: env.CLAUDIA_TELEGRAM_TOKEN || file.telegramToken,
    anthropicKey: env.CLAUDIA_ANTHROPIC_KEY || file.anthropicKey,
    anthropicWorkspace: env.CLAUDIA_ANTHROPIC_WORKSPACE || file.anthropicWorkspace,
  };
}

export function saveConfig(patch) {
  const next = { ...readJson(PATHS.config, {}), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null || v === undefined) delete next[k];
  writeJson(PATHS.config, next);
  return next;
}

export function log(...parts) {
  const text = parts
    .map((p) => (p instanceof Error ? p.message : typeof p === "string" ? p : JSON.stringify(p)))
    .join(" ");
  const line = `${new Date().toISOString()} ${text}\n`;
  try {
    mkdirSync(HOME, { recursive: true });
    if (statSync(PATHS.log).size > 1_000_000) renameSync(PATHS.log, `${PATHS.log}.old`);
  } catch {}
  try {
    appendFileSync(PATHS.log, line);
  } catch {}
  if (process.stdout.isTTY) process.stdout.write(line);
}
