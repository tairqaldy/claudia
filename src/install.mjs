// Wires Claudia into Claude Code (hooks in ~/.claude/settings.json) and into login (autostart).
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT, readJson, writeJson } from "./config.mjs";

export const SETTINGS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
const MARKER = "claudia-hook";
const ASK_TOOLS = "AskUserQuestion|ExitPlanMode";
// [event, matcher, waits]. Hooks that wait can carry your answer back from Telegram while you're
// away; at the laptop Claudia answers them instantly. The rest run in the background.
const EVENTS = [
  ["SessionStart"],
  ["UserPromptSubmit"],
  ["Notification"],
  ["StopFailure"],
  ["SessionEnd"],
  ["PostToolUse", ASK_TOOLS],
  ["Stop", null, true],
  ["PreToolUse", ASK_TOOLS, true],
  ["PermissionRequest", null, true],
];

const slash = (p) => p.replaceAll("\\", "/");
const daemonPath = () => join(ROOT, "src", "daemon.mjs");

export function hookCommand(node = process.execPath) {
  return `"${slash(node)}" "${slash(join(ROOT, "src", "hook.mjs"))}" ${MARKER}`;
}

const isOurs = (hook) => typeof hook?.command === "string" && hook.command.includes(MARKER);

export function withoutHooks(settings) {
  const next = structuredClone(settings);
  if (!next.hooks) return next;
  for (const [event, groups] of Object.entries(next.hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length) next.hooks[event] = kept;
    else delete next.hooks[event];
  }
  if (!Object.keys(next.hooks).length) delete next.hooks;
  return next;
}

export function withHooks(settings, command = hookCommand()) {
  const next = withoutHooks(settings);
  next.hooks ??= {};
  for (const [event, matcher, waits] of EVENTS) {
    const hook = waits
      ? { type: "command", command: `${command} --decide`, timeout: 600, statusMessage: "checking in with Claudia" }
      : { type: "command", command, async: true, timeout: 15 };
    const group = { hooks: [hook] };
    (next.hooks[event] ??= []).push(matcher ? { matcher, ...group } : group);
  }
  return next;
}

export function hooksInstalled() {
  const hooks = readJson(SETTINGS, {}).hooks ?? {};
  return Object.values(hooks).some((groups) => Array.isArray(groups) && groups.some((g) => g.hooks?.some(isOurs)));
}

function writeSettings(next) {
  if (existsSync(SETTINGS) && !existsSync(`${SETTINGS}.before-claudia`)) copyFileSync(SETTINGS, `${SETTINGS}.before-claudia`);
  writeJson(SETTINGS, next);
}

export const installHooks = () => writeSettings(withHooks(readJson(SETTINGS, {})));
export const removeHooks = () => existsSync(SETTINGS) && writeSettings(withoutHooks(readJson(SETTINGS, {})));

// Autostart at login: a hidden launcher in the Startup folder (Windows), a LaunchAgent (macOS),
// or an XDG autostart entry (Linux).
export function autostartFile() {
  if (process.platform === "win32")
    return join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "claudia.vbs");
  if (process.platform === "darwin") return join(homedir(), "Library", "LaunchAgents", "dev.claudia.daemon.plist");
  return join(homedir(), ".config", "autostart", "claudia.desktop");
}

export function enableAutostart() {
  const file = autostartFile();
  const node = process.execPath;
  const daemon = daemonPath();
  let content;
  if (process.platform === "win32") {
    content = `' Starts Claudia at login, without a console window.\r\nCreateObject("WScript.Shell").Run """${node}"" ""${daemon}""", 0, False\r\n`;
  } else if (process.platform === "darwin") {
    content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.claudia.daemon</string>
  <key>ProgramArguments</key><array><string>${node}</string><string>${daemon}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`;
  } else {
    content = `[Desktop Entry]\nType=Application\nName=Claudia\nExec="${node}" "${daemon}"\nNoDisplay=true\nX-GNOME-Autostart-enabled=true\n`;
  }
  mkdirSync(dirname(file), { recursive: true });
  // wscript reads UTF-16 with a BOM, which keeps non-ASCII user folders working
  if (process.platform === "win32") writeFileSync(file, `﻿${content}`, "utf16le");
  else writeFileSync(file, content);
  return file;
}

export function disableAutostart() {
  rmSync(autostartFile(), { force: true });
}

export const autostartEnabled = () => existsSync(autostartFile());
