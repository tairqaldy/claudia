// A Cloudflare quick tunnel gives the Mini App the public https address Telegram requires.
// The address changes every time the tunnel starts; the daemon re-points the bot's menu button.
// Quick tunnels can die silently (laptop asleep, network drop) while cloudflared keeps running,
// so the tunnel checks itself through the public address and starts over when it's unreachable.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CHECK_EVERY_MS = 60_000;

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
  let restarting = false;
  let backoff = 5_000;
  let failures = 0;
  let lastTick = Date.now();

  const scan = (chunk) => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && m[0] !== url) {
      url = m[0];
      backoff = 5_000;
      failures = 0;
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
      if (restarting) {
        restarting = false;
        return run();
      }
      log(`tunnel exited (${code}), retrying in ${backoff / 1000}s`);
      setTimeout(run, backoff).unref();
      backoff = Math.min(backoff * 2, 5 * 60_000);
    });
  }

  function restart(why) {
    log(`tunnel: ${why}, starting a fresh one`);
    failures = 0;
    url = null;
    if (!child) return run();
    restarting = true;
    child.kill();
  }

  async function reachable() {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
      return res.ok && (await res.text()) === "ok";
    } catch {
      return false;
    }
  }

  const watchdog = setInterval(async () => {
    const slept = Date.now() - lastTick > CHECK_EVERY_MS + 30_000; // timers stall while the laptop sleeps
    lastTick = Date.now();
    if (stopped || !child) return;
    if (slept) return restart("the laptop was asleep");
    if (!url) return;
    if (await reachable()) return void (failures = 0);
    if (++failures >= 2) restart("its public address stopped answering");
  }, CHECK_EVERY_MS);
  watchdog.unref();

  const stop = () => {
    stopped = true;
    clearInterval(watchdog);
    child?.kill();
  };
  process.on("exit", stop);
  run();
  return { stop, restart, url: () => url };
}
