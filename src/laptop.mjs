// Laptop vitals and helpers: battery, CPU, memory, node processes, keep-awake, screenshots.
// Built for a busy machine: every child is hidden and has a 15s timeout, and only one PowerShell runs at a time.
import { execFile, spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import { basename, join, resolve } from "node:path";
import { clip, sleep } from "./util.mjs";

const TIMEOUT_MS = 15_000;
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
const PS_PRELUDE = "$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ";

function run(cmd, args) {
  return new Promise((done, fail) => {
    const opts = { windowsHide: true, timeout: TIMEOUT_MS, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 };
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (!err) return done(stdout);
      err.message = err.killed ? `${cmd} timed out after ${TIMEOUT_MS / 1000}s` : `${cmd} failed: ${clip(stderr || err.message, 300)}`;
      fail(err);
    });
  });
}

let psQueue = Promise.resolve();
function powershell(script) {
  const next = psQueue.then(() => run("powershell.exe", [...PS_ARGS, PS_PRELUDE + script]));
  psQueue = next.catch(() => {});
  return next;
}

// Non-ASCII is escaped inside PowerShell, so the console code page can't garble the JSON.
const psJson = (pipeline) =>
  powershell(`$j = ${pipeline} | ConvertTo-Json -Compress; [regex]::Replace([string]$j, '[^\\x00-\\x7f]', { '\\u{0:x4}' -f [int][char]$args[0].Value })`);

// Single-quoted PowerShell literal. PowerShell also treats curly single quotes as quote marks.
const psQuote = (s) => `'${String(s).replace(/['\u2018-\u201b]/g, "$&$&")}'`;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const toList = (data) => (Array.isArray(data) ? data : data ? [data] : []);

// ---- battery

// Win32_Battery.BatteryStatus: 1 discharging, 4/5 low/critical (not charging), 2 on AC, 6-9 charging.
const DISCHARGING = new Set([1, 4, 5]);
const CHARGING = new Set([2, 6, 7, 8, 9]);

export function parseWindowsBattery(jsonText) {
  const list = toList(parseJson(jsonText)).filter((b) => Number.isFinite(b?.EstimatedChargeRemaining));
  if (!list.length) return null;
  const percent = Math.min(100, Math.round(list.reduce((sum, b) => sum + b.EstimatedChargeRemaining, 0) / list.length));
  const onBattery = list.some((b) => DISCHARGING.has(b.BatteryStatus));
  return { percent, charging: !onBattery && list.some((b) => CHARGING.has(b.BatteryStatus)), onBattery };
}

// "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=123)\t76%; discharging; 4:12 remaining"
export function parsePmset(text) {
  const s = String(text ?? "");
  const m = s.match(/^\s*-.*?(\d+)%;\s*([^;\n]*)/m);
  if (!m) return null;
  const state = m[2].trim().toLowerCase();
  const source = s.match(/drawing from '([^']+)'/)?.[1];
  const onBattery = source ? source === "Battery Power" : state === "discharging";
  return { percent: Math.min(100, Number(m[1])), charging: state === "charging" || state === "finishing charge", onBattery };
}

function linuxBattery() {
  const dir = "/sys/class/power_supply";
  const read = (name, file) => readFileSync(join(dir, name, file), "utf8").trim();
  let names = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("BAT"));
  } catch {}
  const list = [];
  for (const name of names) {
    try {
      list.push({ percent: Number(read(name, "capacity")), status: read(name, "status") });
    } catch {}
  }
  const ok = list.filter((b) => Number.isFinite(b.percent));
  if (!ok.length) return null;
  const onBattery = ok.some((b) => b.status === "Discharging");
  return {
    percent: Math.min(100, Math.round(ok.reduce((sum, b) => sum + b.percent, 0) / ok.length)),
    charging: !onBattery && ok.some((b) => b.status === "Charging"),
    onBattery,
  };
}

export async function battery() {
  if (IS_WIN) return parseWindowsBattery(await psJson("Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus"));
  if (IS_MAC) return parsePmset(await run("pmset", ["-g", "batt"]));
  return linuxBattery();
}

// ---- cpu and memory

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const { times } of cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

export async function cpuPercent(sampleMs = 500) {
  const a = cpuTimes();
  await sleep(sampleMs);
  const b = cpuTimes();
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round(100 * (1 - (b.idle - a.idle) / total))));
}

export function memory() {
  const total = totalmem();
  return { usedPct: Math.round(100 * (1 - freemem() / total)), totalGb: Math.round((total / 1024 ** 3) * 10) / 10 };
}

// ---- node processes

// Leading node executable, quoted or not: `"C:\Program Files\nodejs\node.exe" x.js`, `node x.js`
const NODE_EXE = /^\s*"?(?:[^"]*?[\\/])??node(?:\.exe)?"?(?=\s|$)/i;

export function parseWindowsProcesses(jsonText, selfPid = process.pid) {
  return toList(parseJson(jsonText))
    .filter((p) => Number.isInteger(p?.ProcessId) && p.ProcessId !== selfPid)
    .map((p) => ({
      pid: p.ProcessId,
      mb: Math.round((Number(p.WorkingSetSize) || 0) / 1024 ** 2),
      command: clip(String(p.CommandLine ?? "").replace(NODE_EXE, ""), 160),
    }))
    .sort((a, b) => b.mb - a.mb);
}

// `ps -A -o pid=,rss=,command=` lines; rss is KB
export function parsePs(text, selfPid = process.pid) {
  const list = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(.*)$/);
    if (!m || basename(m[3]) !== "node" || Number(m[1]) === selfPid) continue;
    list.push({ pid: Number(m[1]), mb: Math.round(Number(m[2]) / 1024), command: clip(m[4], 160) });
  }
  return list.sort((a, b) => b.mb - a.mb);
}

export async function nodeProcesses() {
  if (IS_WIN) {
    const json = await psJson(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Select-Object ProcessId,WorkingSetSize,CommandLine`);
    return parseWindowsProcesses(json, process.pid);
  }
  // -A rather than -ax: it means "all processes" on both BSD (macOS) and procps (Linux) ps
  return parsePs(await run("ps", ["-A", "-o", "pid=,rss=,command="]), process.pid);
}

export function killProcess(pid) {
  const n = Number(pid);
  // pid 0 and negative pids signal whole process groups on Unix
  if (!Number.isInteger(n) || n <= 0 || n === process.pid) return false;
  try {
    process.kill(n);
    return true;
  } catch {
    return false;
  }
}

// ---- keep-awake

const MAX_AWAKE_MIN = 24 * 60; // setTimeout can't go past ~24.8 days anyway
let awake = null; // { child, until, timer }

function startHelper() {
  if (IS_WIN) {
    // 2147483649 = ES_CONTINUOUS | ES_SYSTEM_REQUIRED (0x80000001; the hex literal would be a negative Int32 in PS 5.1).
    // The loop also ends on its own within a minute if this Node process dies without running its exit hook.
    const script = [
      `Add-Type -Name Power -Namespace Claudia -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'`,
      "[void][Claudia.Power]::SetThreadExecutionState(2147483649)",
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`,
    ].join("; ");
    return spawn("powershell.exe", [...PS_ARGS, PS_PRELUDE + script], { windowsHide: true, stdio: "ignore" });
  }
  if (IS_MAC) return spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
  // own process group, so stopping it takes `sleep infinity` down too
  return spawn("systemd-inhibit", ["--what=sleep", "--why=Claudia", "sleep", "infinity"], { stdio: "ignore", detached: true });
}

export function keepAwake(minutes) {
  const until = Date.now() + Math.min(Math.max(Number(minutes) || 0, 1), MAX_AWAKE_MIN) * 60_000;
  if (!awake) {
    const child = startHelper();
    const forget = () => {
      if (awake?.child !== child) return;
      clearTimeout(awake.timer);
      awake = null;
    };
    child.on("error", forget).on("exit", forget).unref();
    awake = { child, until: 0, timer: null };
  }
  if (until > awake.until) {
    awake.until = until;
    clearTimeout(awake.timer);
    awake.timer = setTimeout(stopKeepAwake, until - Date.now()).unref();
  }
  return { until: awake.until };
}

export function stopKeepAwake() {
  if (!awake) return false;
  const { child, timer } = awake;
  awake = null;
  clearTimeout(timer);
  try {
    if (IS_WIN || IS_MAC) child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {}
  return true;
}

export function keepAwakeUntil() {
  return awake?.until ?? 0;
}

process.on("exit", stopKeepAwake);

// ---- screenshot

function isSaved(file) {
  try {
    return statSync(file).size > 0;
  } catch {
    return false;
  }
}

async function linuxScreenshot(file) {
  for (const [cmd, ...args] of [["gnome-screenshot", "-f", file], ["import", "-window", "root", file]]) {
    try {
      await run(cmd, args);
      if (isSaved(file)) return;
    } catch {}
  }
  throw new Error("couldn't take a screenshot: neither gnome-screenshot nor ImageMagick's import worked");
}

export async function screenshot(filePath) {
  const file = resolve(filePath);
  if (IS_WIN) {
    // DPI awareness first, so VirtualScreen reports real pixels on scaled displays
    await powershell(
      [
        `Add-Type -Name Dpi -Namespace Claudia -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'`,
        "[void][Claudia.Dpi]::SetProcessDPIAware()",
        "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
        "$b = [System.Windows.Forms.SystemInformation]::VirtualScreen",
        "$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height",
        "$g = [System.Drawing.Graphics]::FromImage($bmp)",
        "$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)",
        `$bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Jpeg)`,
        "$g.Dispose(); $bmp.Dispose()",
      ].join("; "),
    );
  } else if (IS_MAC) {
    await run("screencapture", ["-x", "-t", "jpg", file]);
  } else {
    await linuxScreenshot(file);
  }
  if (!isSaved(file)) throw new Error(`screenshot wasn't saved to ${file}`);
  return filePath;
}
