import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuPercent, killProcess, memory, parsePmset, parsePs, parseWindowsBattery, parseWindowsProcesses } from "../src/laptop.mjs";

const MB = 1024 * 1024;

test("windows battery json: one battery, several, or none", () => {
  assert.deepEqual(parseWindowsBattery('{"EstimatedChargeRemaining":76,"BatteryStatus":1}'), { percent: 76, charging: false, onBattery: true });
  assert.deepEqual(parseWindowsBattery('{"EstimatedChargeRemaining":95,"BatteryStatus":2}'), { percent: 95, charging: true, onBattery: false });
  const two = '[{"EstimatedChargeRemaining":80,"BatteryStatus":6},{"EstimatedChargeRemaining":61,"BatteryStatus":2}]';
  assert.deepEqual(parseWindowsBattery(two), { percent: 71, charging: true, onBattery: false });
  for (const junk of ["", "\r\n", "null", "[]", "{}", "not json", undefined]) assert.equal(parseWindowsBattery(junk), null);
});

test("pmset: on battery, charging on AC, charged, and a Mac without a battery", () => {
  const onBatt = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4653155)\t76%; discharging; 4:12 remaining present: true\n";
  assert.deepEqual(parsePmset(onBatt), { percent: 76, charging: false, onBattery: true });
  const charging = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t80%; charging; 0:45 remaining present: true\n";
  assert.deepEqual(parsePmset(charging), { percent: 80, charging: true, onBattery: false });
  const full = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4653155)\t100%; charged; 0:00 remaining present: true\n";
  assert.deepEqual(parsePmset(full), { percent: 100, charging: false, onBattery: false });
  assert.equal(parsePmset("Now drawing from 'AC Power'\n"), null);
  assert.equal(parsePmset(""), null);
});

test("windows node processes: path stripped, self excluded, biggest first", () => {
  const json = JSON.stringify([
    { ProcessId: 100, WorkingSetSize: 50 * MB, CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\app\\node_modules\\vite\\bin\\vite.js --port 5173' },
    { ProcessId: 200, WorkingSetSize: 300 * MB, CommandLine: "C:\\Program Files\\nodejs\\node.exe  server.mjs " },
    { ProcessId: 4242, WorkingSetSize: 900 * MB, CommandLine: "node daemon.mjs" },
    { ProcessId: 300, WorkingSetSize: Math.round(1.4 * MB), CommandLine: null },
    { ProcessId: 400, WorkingSetSize: 20 * MB, CommandLine: "node C:\\tools\\node x.js" },
  ]);
  assert.deepEqual(parseWindowsProcesses(json, 4242), [
    { pid: 200, mb: 300, command: "server.mjs" },
    { pid: 100, mb: 50, command: "C:\\app\\node_modules\\vite\\bin\\vite.js --port 5173" },
    { pid: 400, mb: 20, command: "C:\\tools\\node x.js" },
    { pid: 300, mb: 1, command: "" },
  ]);
});

test("windows node processes: a single object, long commands, junk", () => {
  const one = JSON.stringify({ ProcessId: 7, WorkingSetSize: 10 * MB, CommandLine: `node.exe ${"x".repeat(300)}` });
  const [p, ...rest] = parseWindowsProcesses(one, 1);
  assert.equal(rest.length, 0);
  assert.equal(p.pid, 7);
  assert.equal(p.mb, 10);
  assert.equal(p.command.length, 160);
  assert.ok(p.command.startsWith("xxx") && p.command.endsWith("…"));
  assert.deepEqual(parseWindowsProcesses(one, 7), []);
  assert.deepEqual(parseWindowsProcesses("", 1), []);
  assert.deepEqual(parseWindowsProcesses("garbage", 1), []);
});

test("ps output: only node executables, rss in KB", () => {
  const text = [
    "  101  51200 /usr/local/bin/node /srv/app.js --x",
    "  102  10240 /bin/zsh -l",
    "  103 204800 node vite",
    "  104  99999 /opt/node-v22/bin/node self.js",
    "  105   4096 /usr/bin/nodemon app.js",
  ].join("\n");
  assert.deepEqual(parsePs(text, 104), [
    { pid: 103, mb: 200, command: "vite" },
    { pid: 101, mb: 50, command: "/srv/app.js --x" },
  ]);
});

test("memory reports a whole used percent and total GB to one decimal", () => {
  const m = memory();
  assert.ok(Number.isInteger(m.usedPct) && m.usedPct >= 0 && m.usedPct <= 100);
  assert.ok(m.totalGb > 0);
  assert.equal(m.totalGb, Math.round(m.totalGb * 10) / 10);
});

test("cpu percent is a whole number between 0 and 100", async () => {
  const pct = await cpuPercent(50);
  assert.ok(Number.isInteger(pct) && pct >= 0 && pct <= 100, `got ${pct}`);
});

test("killProcess refuses itself and nonsense pids", () => {
  assert.equal(killProcess(process.pid), false);
  assert.equal(killProcess(0), false);
  assert.equal(killProcess(-1), false);
  assert.equal(killProcess("abc"), false);
});
