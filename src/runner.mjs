// Starts Claude Code sessions on the laptop without a window (`claude -p`), for work you kick off
// from your phone. Their hooks report back to Claudia like any other session.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clip } from "./util.mjs";

const MAX_RUNNING = 2; // the laptop is busy enough already

export function claudeBin(config) {
  if (config.claudePath) return config.claudePath;
  const local = join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return existsSync(local) ? local : "claude";
}

export function createRunner({ config, onFinish = () => {}, log = () => {} }) {
  const running = new Set();

  function run({ cwd, prompt, resume = null, permissionMode = config.remotePermissionMode }) {
    if (running.size >= MAX_RUNNING) return { ok: false, error: `${MAX_RUNNING} remote tasks are already running` };
    if (!cwd || !existsSync(cwd)) return { ok: false, error: `can't find the folder ${cwd}` };
    const args = ["-p", prompt, "--output-format", "stream-json", "--verbose", "--permission-mode", permissionMode];
    if (resume) args.push("--resume", resume);

    const child = spawn(claudeBin(config), args, {
      cwd,
      env: { ...process.env, CLAUDIA_REMOTE: "1" }, // its hooks tell Claudia this one was started from the phone
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.add(child);
    let pending = "";
    let result = null;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let i;
      while ((i = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 1);
        try {
          const msg = JSON.parse(line);
          if (msg.type === "result") result = msg;
        } catch {}
      }
    });
    child.stderr.on("data", (chunk) => (stderr = clip(stderr + chunk, 2000)));
    const done = (error) => {
      if (!running.delete(child)) return;
      log(`remote run in ${cwd} ended${error ? `: ${error}` : ""}`);
      onFinish({ cwd, resume, error, needsLogin: Boolean(error && /authenticat|log ?in|oauth/i.test(error)) });
    };
    child.on("error", (err) => done(err.message));
    child.on("close", (code) => done(result?.is_error ? clip(result.result, 300) : code ? clip(stderr || `exited with code ${code}`, 300) : null));
    return { ok: true };
  }

  return { run, count: () => running.size };
}
