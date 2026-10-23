import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  BEGIN,
  END,
  bashSnippet,
  installTerminalHook,
  parseTerminalEvent,
  powershellSnippet,
  removeTerminalHook,
  terminalHookInstalled,
  withTerminalBlock,
  withoutTerminalBlock,
  zshSnippet,
} from "../src/terminal.mjs";

const PORT = 47999;
const temp = () => mkdtempSync(join(tmpdir(), "claudia-terminal-"));
const psProfiles = (dir) => [
  join(dir, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"),
  join(dir, "PowerShell", "Microsoft.PowerShell_profile.ps1"),
];
const count = (text, part) => text.split(part).length - 1;

test("creates missing profiles, installs once, and removing deletes what it created", () => {
  const profiles = psProfiles(temp());
  const first = installTerminalHook({ port: PORT, profiles });
  assert.deepEqual(first.changed, profiles);
  for (const file of profiles) {
    const text = readFileSync(file, "latin1");
    assert.equal(count(text, BEGIN), 1);
    assert.equal(count(text, END), 1);
    assert.ok(text.includes(`http://127.0.0.1:${PORT}/terminal`));
    assert.ok(text.includes("\r\n"), "new PowerShell profiles use CRLF");
    assert.ok(!existsSync(`${file}.before-claudia`), "nothing to back up");
  }
  assert.equal(terminalHookInstalled({ profiles }), true);

  const second = installTerminalHook({ port: PORT, profiles });
  assert.deepEqual(second.changed, []);
  assert.deepEqual(second.unchanged, profiles);
  assert.equal(count(readFileSync(profiles[0], "latin1"), BEGIN), 1);

  assert.deepEqual(removeTerminalHook({ profiles }), profiles);
  for (const file of profiles) assert.ok(!existsSync(file));
  assert.equal(terminalHookInstalled({ profiles }), false);
  assert.deepEqual(removeTerminalHook({ profiles }), []);
});

test("existing profile: backed up once, block replaced in place, removal is byte-identical", () => {
  const [file] = psProfiles(temp());
  const original = Buffer.from("Import-Module posh-git\r\noh-my-posh init pwsh | Invoke-Expression\r\n# привет\r\n", "utf8");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, original);

  installTerminalHook({ port: PORT, profiles: [file] });
  assert.deepEqual(readFileSync(`${file}.before-claudia`), original);
  const installed = readFileSync(file);
  assert.deepEqual(installed.subarray(0, original.length), original, "your lines stay first, untouched");

  // a new port or threshold replaces the block, it doesn't add one; the backup stays the first one
  installTerminalHook({ port: PORT + 1, minSeconds: 120, profiles: [file] });
  const text = readFileSync(file, "latin1");
  assert.equal(count(text, BEGIN), 1);
  assert.ok(text.includes(`127.0.0.1:${PORT + 1}/terminal`) && text.includes("MinMs = 120000"));
  assert.deepEqual(readFileSync(`${file}.before-claudia`), original);

  removeTerminalHook({ profiles: [file] });
  assert.deepEqual(readFileSync(file), original);
});

test("encodings and endings survive: UTF-8 BOM, UTF-16 LE, LF, no trailing newline", () => {
  const dir = temp();
  const cases = {
    "bom.ps1": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Set-Alias g git\r\n# ünïcödé\r\n")]),
    "utf16.ps1": Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Set-Alias g git\r\n# ünïcödé\r\n", "utf16le")]),
    "lf.ps1": Buffer.from("Set-Alias g git\n"),
    "nonewline.ps1": Buffer.from("Set-Alias g git"),
    "ansi.ps1": Buffer.from([0x23, 0x20, 0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2, 0x0d, 0x0a]), // cp1251 bytes
  };
  for (const [name, bytes] of Object.entries(cases)) {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    const { changed } = installTerminalHook({ port: PORT, profiles: [file] });
    assert.deepEqual(changed, [file], name);
    const after = readFileSync(file);
    assert.deepEqual(after.subarray(0, 2), bytes.subarray(0, 2), `${name}: BOM kept`);
    if (name === "utf16.ps1") assert.ok(after.toString("utf16le").includes(BEGIN), "block written as UTF-16");
    if (name === "lf.ps1") assert.ok(!after.includes("\r\n"), "LF file stays LF");
    removeTerminalHook({ profiles: [file] });
    assert.deepEqual(readFileSync(file), bytes, `${name}: byte-identical after removal`);
  }
});

test("lines you add after the block survive removal", () => {
  const original = "a\r\n";
  const installed = withTerminalBlock(original, "x\ny", "\r\n");
  assert.equal(withoutTerminalBlock(`${installed}b\r\n`), "a\r\nb\r\n");
  const noNewline = withTerminalBlock("a", "x", "\n");
  assert.equal(withoutTerminalBlock(noNewline), "a");
  assert.equal(withoutTerminalBlock(`${noNewline}\nb`), "a\nb");
  assert.equal(withoutTerminalBlock(withTerminalBlock("", "x")), "");
});

test("skips blocked and signed profiles", () => {
  const dir = temp();
  const signed = join(dir, "signed.ps1");
  writeFileSync(signed, "Get-Date\r\n# SIG # Begin signature block\r\n# MIIx\r\n# SIG # End signature block\r\n");
  const blocked = join(dir, "blocked.ps1");
  const res = installTerminalHook({ port: PORT, profiles: [signed, { path: blocked, blocked: "execution policy Restricted" }] });
  assert.deepEqual(res.changed, []);
  assert.deepEqual(res.skipped.map((s) => s.path), [signed, blocked]);
  assert.ok(!existsSync(blocked));
});

test("zsh and bash rc files get their own snippet", () => {
  const dir = temp();
  const zshrc = join(dir, ".zshrc");
  const bashrc = join(dir, ".bashrc");
  writeFileSync(bashrc, "export PATH=$HOME/bin:$PATH\n");
  installTerminalHook({ port: PORT, profiles: [zshrc, bashrc] });
  const z = readFileSync(zshrc, "utf8");
  const b = readFileSync(bashrc, "utf8");
  assert.ok(z.includes("add-zsh-hook preexec") && !z.includes("\r"));
  assert.ok(b.includes("PROMPT_COMMAND") && b.includes("trap '__claudia_debug' DEBUG") && !b.includes("\r"));
  assert.ok(!b.includes("$\\{") && b.includes("${BASH_REMATCH[1]}"), "shell braces come out as ${");
  removeTerminalHook({ profiles: [zshrc, bashrc] });
  assert.equal(readFileSync(bashrc, "utf8"), "export PATH=$HOME/bin:$PATH\n");
  assert.ok(!existsSync(zshrc));
});

test("powershell snippet: guards, port, threshold, 5.1-safe and ASCII", () => {
  const ps = powershellSnippet({ port: PORT, minSeconds: 90 });
  assert.ok(ps.includes(`'http://127.0.0.1:${PORT}/terminal'`));
  assert.ok(ps.includes("MinMs = 90000"));
  for (const guard of ["$env:CLAUDECODE", "$env:CLAUDIA_REMOTE", "-NonInteractive", "'^noni'", "'^noe'", "GetCommandLineArgs()", "IsInputRedirected", "'ConsoleHost'"])
    assert.ok(ps.includes(guard), guard);
  for (const part of ["$global:?", "Start-Transcript", "-Tail 60", "Get-History -Count 1", "TimeoutSec = 1", "Invoke-RestMethod @request", "'x-claudia' = '1'", "$function:prompt", "Write-Error 'claudia' -ErrorAction Ignore"])
    assert.ok(ps.includes(part), part);
  assert.ok(ps.indexOf("$claudiaOk = $global:?") < ps.indexOf("$claudiaState = "), "$? is read first");
  assert.match(ps, /^try \{/m);
  assert.doesNotMatch(ps, /\?\?|\?\.|&&|\|\||`/, "no PowerShell 7-only operators, no backticks");
  assert.doesNotMatch(ps + zshSnippet({ port: PORT }) + bashSnippet({ port: PORT }), /[^\x00-\x7f]/, "ASCII only");
  assert.throws(() => powershellSnippet({ port: "47833; rm" }));
});

test("parseTerminalEvent: normalises a real event", () => {
  const e = parseTerminalEvent(
    JSON.stringify({
      command: "npm run build",
      ok: false,
      exitCode: 1,
      startedAt: 1_760_000_000_000,
      endedAt: 1_760_000_095_000,
      durationMs: 95_000,
      cwd: "C:\\code\\app",
      shell: "PowerShell",
      pid: 4242,
      output: ["", "\x1b[31merror\x1b[0m TS2345: nope", "\x1b]0;title\x07done 50%\rdone 100%", ""],
    }),
  );
  assert.deepEqual(e, {
    command: "npm run build",
    ok: false,
    exitCode: 1,
    startedAt: 1_760_000_000_000,
    endedAt: 1_760_000_095_000,
    durationMs: 95_000,
    cwd: "C:\\code\\app",
    shell: "powershell",
    pid: 4242,
    output: ["error TS2345: nope", "done 100%"],
  });
});

test("parseTerminalEvent: clips output to 15 lines and 1500 chars, and fills gaps", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
  assert.deepEqual(parseTerminalEvent({ command: "x", durationMs: 1, output: lines }).output, lines.slice(-15));
  const wide = parseTerminalEvent({ command: "x", durationMs: 1, output: Array(15).fill("y".repeat(300)) }).output;
  assert.ok(wide.join("\n").length <= 1500 && wide.length === 4);
  const one = parseTerminalEvent({ command: "x", durationMs: 1, output: "z".repeat(5000) }).output;
  assert.equal(one.length, 1);
  assert.equal(one[0].length, 1500);
  assert.ok(one[0].startsWith("…"));

  const e = parseTerminalEvent({ command: `  ${"c".repeat(3000)}  `, startedAt: 1000, endedAt: 61_000, exitCode: "0", cwd: "a\nb", shell: "nushell", pid: -3 });
  assert.equal(e.command.length, 1000);
  assert.equal(e.durationMs, 60_000);
  assert.equal(e.exitCode, 0);
  assert.equal(e.ok, true, "ok follows the exit code when missing");
  assert.equal(e.cwd, "a b");
  assert.equal(e.shell, "shell");
  assert.equal(e.pid, null);
  assert.deepEqual(e.output, []);
  assert.equal(parseTerminalEvent({ command: "x", durationMs: 5, exitCode: 1.5, ok: "yes" }).exitCode, null);
  assert.equal(parseTerminalEvent({ command: "x", durationMs: 5 }).ok, null);
});

test("parseTerminalEvent: junk is null", () => {
  for (const junk of [
    undefined,
    null,
    "",
    "not json",
    "[]",
    "42",
    [],
    { durationMs: 5 },
    { command: "   ", durationMs: 5 },
    { command: 7, durationMs: 5 },
    { command: "x" },
    { command: "x", durationMs: -1 },
    { command: "x", durationMs: "soon" },
    { command: "x", durationMs: Infinity },
    { command: "x", startedAt: 5000, endedAt: 1000 },
  ])
    assert.equal(parseTerminalEvent(junk), null, JSON.stringify(junk) ?? String(junk));
  assert.ok(parseTerminalEvent(Buffer.from('{"command":"ls","durationMs":0}')));
});
