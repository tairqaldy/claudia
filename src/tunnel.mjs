// A Cloudflare quick tunnel gives the Mini App the public https address Telegram requires.
// The address changes every time the tunnel starts; the daemon re-points the bot's menu button.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export function findCloudflared(config) {
  if (config.cloudflaredPath && existsSync(config.cloudflaredPath)) return config.cloudflaredPath;
  const candidates =
    process.platform === "win32"
      ? [
          join(process.env.LOCALAPPDATA ?? "", "Microsoft", "WinGet", "Links", "cloudflared.exe"),
          "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe",
          "C:\\Program Files\\cloudflared\\cloudflared.exe",
        ]
      : ["/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
  const found = candidates.find((p) => existsSync(p));
  if (found) return found;
  const which = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], { encoding: "utf8", windowsHide: true });
  return which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : null;
}

export function startTunnel({ bin, port, onUrl, log = () => {} }) {
  let child = null;
  let url = null;
  let stopped = false;
  let backoff = 5_000;

  const scan = (chunk) => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== url) {
      url = m[0];
      backoff = 5_000;
      onUrl(url);
    }
  };

  function run() {
    child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("error", (err) => log("tunnel:", err));
    child.on("exit", (code) => {
      child = null;
      url = null;
      if (stopped) return;
      log(`tunnel exited (${code}), retrying in ${backoff / 1000}s`);
      setTimeout(run, backoff).unref();
      backoff = Math.min(backoff * 2, 5 * 60_000);
    });
  }

  const stop = () => {
    stopped = true;
    child?.kill();
  };
  process.on("exit", stop);
  run();
  return { stop, url: () => url };
}
