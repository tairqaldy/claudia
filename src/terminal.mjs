// Opt-in terminal hook: Claudia pings you when a long command you ran yourself in a terminal finishes.
// It adds one marked block to your PowerShell profiles (Windows) or ~/.zshrc / ~/.bashrc, backing the
// file up first, like install.mjs does for Claude Code. The block posts to the daemon's /terminal
// route, and parseTerminalEvent checks what arrives there.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { clip } from "./util.mjs";

export const BEGIN = "# >>> claudia terminal hook >>>";
export const END = "# <<< claudia terminal hook <<<";
const BACKUP = ".before-claudia";
const SIGNED = /^# SIG # Begin signature block/m;

// ---------------------------------------------------------------------------------------------
// Which files

let windowsInfo;
// One PowerShell call: the real Documents folder (OneDrive can move it, and its name can be
// non-ASCII, hence base64) and the execution policy profiles will run under.
function windowsShellInfo() {
  if (windowsInfo) return windowsInfo;
  windowsInfo = { docs: join(homedir(), "Documents"), policy: "" };
  try {
    const env = { ...process.env };
    // a Bypass inherited from the shell that runs us would hide the policy new terminals get
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psexecutionpolicypreference") delete env[key];
    const script =
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('MyDocuments'))) + ' ' + (Get-ExecutionPolicy)";
    const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      env,
      windowsHide: true,
      timeout: 15_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [b64 = "", policy = ""] = out.trim().split(/\s+/);
    const docs = Buffer.from(b64, "base64").toString("utf8");
    if (docs) windowsInfo.docs = docs;
    windowsInfo.policy = policy;
  } catch {}
  return windowsInfo;
}

// [{ path, shell, blocked }] for this machine. blocked says why a profile can't run at all.
export function terminalProfiles() {
  if (process.platform === "win32") {
    const { docs, policy } = windowsShellInfo();
    const blocked = /^(Restricted|AllSigned|Undefined)$/i.test(policy)
      ? `Windows PowerShell won't run profile scripts here (execution policy ${policy}). To allow them: Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`
      : null;
    return [
      { path: join(docs, "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"), shell: "powershell", blocked },
      { path: join(docs, "PowerShell", "Microsoft.PowerShell_profile.ps1"), shell: "pwsh", blocked: null },
    ];
  }
  // rc files you already have, plus the one for your login shell
  const login = basename(process.env.SHELL || "");
  return [
    { path: join(homedir(), ".zshrc"), shell: "zsh", blocked: null },
    { path: join(homedir(), ".bashrc"), shell: "bash", blocked: null },
  ].filter((p) => existsSync(p.path) || p.shell === login);
}

const listProfiles = (profiles) =>
  (profiles ?? terminalProfiles()).map((p) => (typeof p === "string" ? { path: p, blocked: null } : p));

const kindOf = (path) => (/\.ps1$/i.test(path) ? "powershell" : /zsh/i.test(basename(path)) ? "zsh" : "bash");

// ---------------------------------------------------------------------------------------------
// Reading and writing profiles without touching anything but our block

// UTF-8 and ANSI files are handled as raw bytes (latin1), so everything outside our ASCII-only block
// comes back byte for byte. UTF-16 profiles (what `"..." > $PROFILE` makes in PowerShell 5.1) keep
// their encoding and BOM.
function decode(buf) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
    return { bom: buf.subarray(0, 3), encoding: "latin1", text: buf.subarray(3).toString("latin1") };
  const even = (b) => b.subarray(0, b.length & ~1);
  if (buf[0] === 0xff && buf[1] === 0xfe)
    return { bom: buf.subarray(0, 2), encoding: "utf16le", text: even(buf.subarray(2)).toString("utf16le") };
  if (buf[0] === 0xfe && buf[1] === 0xff)
    return { bom: buf.subarray(0, 2), encoding: "utf16be", text: Buffer.from(even(buf.subarray(2))).swap16().toString("utf16le") };
  return { bom: Buffer.alloc(0), encoding: "latin1", text: buf.toString("latin1") };
}

function encode({ bom, encoding }, text) {
  const body = encoding === "utf16be" ? Buffer.from(text, "utf16le").swap16() : Buffer.from(text, encoding);
  return Buffer.concat([bom, body]);
}

function readProfile(path) {
  if (!existsSync(path)) return { exists: false, bom: Buffer.alloc(0), encoding: "latin1", text: "" };
  return { exists: true, ...decode(readFileSync(path)) };
}

function findBlock(text) {
  const endAt = text.lastIndexOf(END);
  const start = endAt < 0 ? -1 : text.lastIndexOf(BEGIN, endAt);
  return start < 0 ? null : { start, end: endAt + END.length };
}

// Adds the block (or replaces the one that's there). If the file doesn't end with a newline, the
// block brings its own in front and none after, so removing it restores the file exactly.
export function withTerminalBlock(text, snippet, eol = "\n") {
  const block = [BEGIN, ...snippet.replace(/\s+$/, "").split(/\r?\n/), END].join(eol);
  const found = findBlock(text);
  if (found) return text.slice(0, found.start) + block + text.slice(found.end);
  if (!text) return block + eol;
  if (text.endsWith("\n")) return text + block + eol;
  return text + eol + block;
}

export function withoutTerminalBlock(text) {
  for (let found = findBlock(text); found; found = findBlock(text)) {
    let before = text.slice(0, found.start);
    let after = text.slice(found.end);
    if (after.startsWith("\r\n")) after = after.slice(2);
    else if (after.startsWith("\n")) after = after.slice(1);
    else if (!after) before = before.replace(/\r?\n$/, "");
    text = before + after;
  }
  return text;
}

function snippetFor(kind, opts) {
  if (kind === "powershell") return powershellSnippet(opts);
  return kind === "zsh" ? zshSnippet(opts) : bashSnippet(opts);
}

export function terminalHookStatus({ profiles } = {}) {
  return listProfiles(profiles).map((p) => ({ ...p, installed: findBlock(readProfile(p.path).text) !== null }));
}

export const terminalHookInstalled = (opts) => terminalHookStatus(opts).some((p) => p.installed);

// Returns { changed, unchanged, skipped: [{ path, reason }] }. Creates missing profiles, backs each
// existing one up once to <profile>.before-claudia, and never adds a second block.
export function installTerminalHook({ port, minSeconds = 60, profiles } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  const result = { changed: [], unchanged: [], skipped: [] };
  for (const { path, blocked } of listProfiles(profiles)) {
    if (blocked) {
      result.skipped.push({ path, reason: blocked });
      continue;
    }
    const file = readProfile(path);
    if (SIGNED.test(file.text)) {
      result.skipped.push({ path, reason: "it's a signed script, and editing it would break the signature" });
      continue;
    }
    const kind = kindOf(path);
    const eol = kind === "powershell" && !(file.text.includes("\n") && !file.text.includes("\r\n")) ? "\r\n" : "\n";
    const next = withTerminalBlock(file.text, snippetFor(kind, { port, minSeconds }), eol);
    if (next === file.text) {
      result.unchanged.push(path);
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    if (file.exists && !existsSync(path + BACKUP)) copyFileSync(path, path + BACKUP);
    writeFileSync(path, encode(file, next));
    result.changed.push(path);
  }
  return result;
}

// Returns the files it changed. A profile that only ever held our block (we created it) is deleted.
export function removeTerminalHook({ profiles } = {}) {
  const changed = [];
  for (const { path } of listProfiles(profiles)) {
    const file = readProfile(path);
    const next = withoutTerminalBlock(file.text);
    if (next === file.text) continue;
    if (!next && !file.bom.length && !existsSync(path + BACKUP)) rmSync(path, { force: true });
    else writeFileSync(path, encode(file, next));
    changed.push(path);
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------
// The snippets. ASCII only. Shell code below writes ${ as $\{ so JS leaves it alone.

const code = (strings, ...values) =>
  strings.raw.reduce((out, s, i) => out + s.replaceAll("$\\{", "${") + (i < values.length ? values[i] : ""), "");

function settings({ port, minSeconds = 60 } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`);
  const seconds = Number.isFinite(Number(minSeconds)) ? Math.max(1, Math.round(Number(minSeconds))) : 60;
  return { url: `http://127.0.0.1:${port}/terminal`, seconds, minMs: seconds * 1000 };
}

// Windows PowerShell 5.1 and PowerShell 7. Runs only in an interactive console, wraps whatever prompt
// is there (oh-my-posh, starship, ...), and does nothing on most prompts but one Get-History call.
export function powershellSnippet(opts) {
  const { url, seconds, minMs } = settings(opts);
  return code`# Claudia texts you when a command that ran ${seconds}s or more finishes, with how it ended and its
# last lines. Managed by "claudia terminal on|off". Skipped in Claude Code's shells (CLAUDECODE),
# Claudia's headless runs (CLAUDIA_REMOTE), non-console hosts, and powershell -Command/-c/-File/-NonInteractive.
try {
  & {
    Set-StrictMode -Off
    if ($global:ClaudiaTerminal -or $env:CLAUDECODE -or $env:CLAUDIA_REMOTE) { return }
    if ($Host.Name -ne 'ConsoleHost' -or -not [Environment]::UserInteractive -or [Console]::IsInputRedirected) { return }
    $batch = $false
    $noExit = $false
    $argv = [Environment]::GetCommandLineArgs()
    for ($i = 1; $i -lt $argv.Count; $i++) {
      $a = [string]$argv[$i]
      if ($a -notmatch '^[-/]') { $batch = $true; break }
      $n = $a.TrimStart('-', '/').ToLowerInvariant()
      if ($n -match '^noni') { return }
      if ($n -match '^noe') { $noExit = $true; continue }
      if ($n -match '^(c|e|ec|f|fi|cwa)$' -or ($n.Length -ge 3 -and @('command', 'commandwithargs', 'encodedcommand', 'file' | Where-Object { $_.StartsWith($n) }).Count)) { $batch = $true; break }
      if ($n -match '^(ex|ep|wd|wo|wi|w|o|of|ou|if|in|v|ve|se|cu|ea)$' -or ($n.Length -ge 3 -and @('executionpolicy', 'workingdirectory', 'windowstyle', 'outputformat', 'inputformat', 'configurationname', 'configurationfile', 'version', 'settingsfile', 'custompipename', 'psconsolefile', 'encodedarguments' | Where-Object { $_.StartsWith($n) }).Count)) { $i++ }
    }
    if ($batch -and -not $noExit) { return }

    # Output capture: a transcript per console, read back only when a long command finishes.
    $dir = $env:CLAUDIA_HOME
    if (-not $dir) { $dir = Join-Path $HOME '.claudia' }
    $dir = Join-Path $dir 'terminal'
    $log = Join-Path $dir ([string]$PID + '.log')
    try {
      if (Test-Path -LiteralPath $dir) {
        $old = (Get-Date).AddDays(-1)
        Get-ChildItem -LiteralPath $dir -Filter '*.log' -File -ErrorAction Ignore | Where-Object { $_.LastWriteTime -lt $old } | Remove-Item -Force -ErrorAction Ignore
      } else {
        $null = New-Item -ItemType Directory -Path $dir -Force -ErrorAction Stop
      }
      $null = Start-Transcript -Path $log -Append -ErrorAction Ignore
    } catch { $log = $null }

    $shell = 'powershell'
    if ($PSVersionTable.PSEdition -eq 'Core') { $shell = 'pwsh' }
    $state = @{ Url = '${url}'; MinMs = ${minMs}; Log = $log; Shell = $shell; LastId = 0; LastCode = $global:LASTEXITCODE; Prompt = $function:prompt }
    $last = Get-History -Count 1
    if ($last) { $state.LastId = $last.Id }

    # The last lines of output: what follows the line that echoes the command, minus transcript noise.
    $state.Tail = {
      param([string]$commandLine)
      $log = $global:ClaudiaTerminal.Log
      if (-not $log -or -not (Test-Path -LiteralPath $log)) { return }
      $lines = @(((Get-Content -LiteralPath $log -Tail 60 -Encoding UTF8 -ErrorAction Stop) -join [char]10) -split '\r?\n')
      $echo = @($commandLine -split '\r?\n' | Where-Object { $_.Trim() }) | Select-Object -Last 1
      $from = -1
      if ($echo) {
        $echo = $echo.Trim()
        for ($i = $lines.Count - 1; $i -ge 0; $i--) {
          $t = $lines[$i].TrimEnd()
          if ($t -eq $echo -or $t.EndsWith(' ' + $echo, [StringComparison]::Ordinal) -or $t.EndsWith('>' + $echo, [StringComparison]::Ordinal)) { $from = $i + 1; break }
        }
      }
      if ($from -lt 0) {
        $from = 0
        for ($i = $lines.Count - 1; $i -ge 0; $i--) { if ($lines[$i] -match '^\*{10,}\s*$') { $from = $i + 1; break } }
      }
      $keep = New-Object System.Collections.Generic.List[string]
      foreach ($l in @($lines | Select-Object -Skip $from)) {
        if ($l -match '^\*{10,}\s*$' -or $l -match '^PS[^>]*>' -or $l -match '^Transcript (started|stopped)' -or $l -match '^(Windows )?PowerShell transcript (start|end)') { continue }
        if ($l.Length -gt 500) { $l = $l.Substring(0, 500) }
        $keep.Add($l.TrimEnd())
      }
      while ($keep.Count -gt 0 -and -not $keep[0].Trim()) { $keep.RemoveAt(0) }
      while ($keep.Count -gt 0 -and -not $keep[$keep.Count - 1].Trim()) { $keep.RemoveAt($keep.Count - 1) }
      if ($keep.Count -gt 15) { $keep.RemoveRange(0, $keep.Count - 15) }
      $keep.ToArray()
    }

    # After each command: if it is new in history and ran long enough, tell Claudia (1s timeout).
    $state.Check = {
      param([bool]$ok)
      Set-StrictMode -Off
      $ErrorActionPreference = 'Stop'
      $ProgressPreference = 'SilentlyContinue'
      $c = $global:ClaudiaTerminal
      $code = $global:LASTEXITCODE
      $codeChanged = $code -ne $c.LastCode
      $c.LastCode = $code
      $h = Get-History -Count 1
      if (-not $h -or $h.Id -eq $c.LastId) { return }
      $c.LastId = $h.Id
      $ms = [long]($h.EndExecutionTime - $h.StartExecutionTime).TotalMilliseconds
      if ($ms -lt $c.MinMs -or [string]$h.ExecutionStatus -eq 'Stopped') { return }
      # $LASTEXITCODE only belongs to this command if it ran a native exe (or a script that exits)
      $native = $false
      if ($null -ne $code) {
        $native = $codeChanged
        if (-not $native) {
          $ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$h.CommandLine, [ref]$null, [ref]$null)
          foreach ($cmd in $ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.CommandAst] }, $true)) {
            $name = $cmd.GetCommandName()
            if (-not $name) { continue }
            $info = Get-Command -Name $name -ErrorAction Ignore | Select-Object -First 1
            if ($info -and @('Application', 'ExternalScript') -contains [string]$info.CommandType) { $native = $true; break }
          }
        }
      }
      $exitCode = $null
      if ($native) { $exitCode = [int]$code }
      $output = @()
      try { $output = @(& $c.Tail ([string]$h.CommandLine)) } catch { $output = @() }
      $body = [ordered]@{
        command = [string]$h.CommandLine
        ok = $ok
        exitCode = $exitCode
        startedAt = ([DateTimeOffset]$h.StartExecutionTime).ToUnixTimeMilliseconds()
        endedAt = ([DateTimeOffset]$h.EndExecutionTime).ToUnixTimeMilliseconds()
        durationMs = $ms
        cwd = [string]$executionContext.SessionState.Path.CurrentLocation.Path
        shell = $c.Shell
        pid = $PID
        output = $output
      }
      $json = ConvertTo-Json -InputObject $body -Compress -Depth 3
      $request = @{ Uri = $c.Url; Method = 'Post'; Body = [Text.Encoding]::UTF8.GetBytes($json); ContentType = 'application/json; charset=utf-8'; Headers = @{ 'x-claudia' = '1' }; TimeoutSec = 1 }
      if ($PSVersionTable.PSVersion.Major -ge 6) { $request.NoProxy = $true }
      $null = Invoke-RestMethod @request
    }
    $global:ClaudiaTerminal = $state

    # Wraps the prompt that is there now. $? is read first, and put back before the old prompt runs.
    function global:prompt {
      $claudiaOk = $global:?
      $claudiaState = $global:ClaudiaTerminal
      $claudiaPrompt = $null
      if ($claudiaState) {
        $claudiaPrompt = $claudiaState.Prompt
        $claudiaErrors = $global:Error.Count
        try { & $claudiaState.Check $claudiaOk } catch {}
        try { while ($global:Error.Count -gt $claudiaErrors) { $global:Error.RemoveAt(0) } } catch {}
      }
      if (-not $claudiaPrompt) { $claudiaPrompt = { 'PS ' + $executionContext.SessionState.Path.CurrentLocation + ('>' * ($NestedPromptLevel + 1)) + ' ' } }
      if ($claudiaOk) { $null = 0 } else { Write-Error 'claudia' -ErrorAction Ignore }
      & $claudiaPrompt
    }
  }
} catch {}`;
}

// zsh: preexec/precmd hooks, command + exit code + duration, no output. Posts in the background.
export function zshSnippet(opts) {
  const { url, seconds, minMs } = settings(opts);
  return code`# Claudia texts you when a command that ran ${seconds}s or more finishes. Managed by "claudia terminal on|off".
# Skipped in non-interactive shells, Claude Code's shells (CLAUDECODE) and Claudia's headless runs (CLAUDIA_REMOTE).
if [[ -o interactive && -z "$CLAUDECODE" && -z "$CLAUDIA_REMOTE" && -z "$__claudia_url" ]] && (( $+commands[curl] )); then
  zmodload zsh/datetime 2>/dev/null
  typeset -g __claudia_url='${url}' __claudia_min=${minMs} __claudia_cmd='' __claudia_t0=''
  __claudia_json() {
    local s=$1
    s=$\{s//\\/\\\\}; s=$\{s//\"/\\\"}; s=$\{s//$'\n'/\\n}; s=$\{s//$'\r'/\\r}; s=$\{s//$'\t'/\\t}; s=$\{s//[[:cntrl:]]/}
    print -rn -- "\"$s\""
  }
  __claudia_preexec() { __claudia_cmd=$1; __claudia_t0=$EPOCHREALTIME; }
  __claudia_precmd() {
    local code=$?
    if [[ -n $__claudia_t0 ]]; then
      local -i t0 t1
      (( t0 = __claudia_t0 * 1000, t1 = EPOCHREALTIME * 1000 ))
      __claudia_t0=''
      if (( t1 - t0 >= __claudia_min )); then
        local ok=false body
        (( code == 0 )) && ok=true
        body="{\"command\":$(__claudia_json "$__claudia_cmd"),\"ok\":$ok,\"exitCode\":$code,\"startedAt\":$t0,\"endedAt\":$t1,\"durationMs\":$(( t1 - t0 )),\"cwd\":$(__claudia_json "$PWD"),\"shell\":\"zsh\",\"pid\":$$,\"output\":[]}"
        ( curl -s -m 1 -o /dev/null -H 'content-type: application/json' -H 'x-claudia: 1' --data-binary "$body" "$__claudia_url" >/dev/null 2>&1 & )
      fi
    fi
    return $code
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook preexec __claudia_preexec
  precmd_functions=(__claudia_precmd $precmd_functions)
fi`;
}

// bash 4.2+: PROMPT_COMMAND plus a DEBUG trap (or bash-preexec's hooks when that's loaded).
// Leaves a DEBUG trap that someone else set alone.
export function bashSnippet(opts) {
  const { url, seconds, minMs } = settings(opts);
  return code`# Claudia texts you when a command that ran ${seconds}s or more finishes. Managed by "claudia terminal on|off".
# Skipped in non-interactive shells, Claude Code's shells (CLAUDECODE) and Claudia's headless runs (CLAUDIA_REMOTE).
if [[ $- == *i* && -z "$CLAUDECODE" && -z "$CLAUDIA_REMOTE" && -z "$__claudia_url" ]] && (( BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1] >= 402 )) && command -v curl >/dev/null 2>&1; then
  __claudia_url='${url}'
  __claudia_min=${minMs}
  __claudia_cmd='' __claudia_t0='' __claudia_armed=''
  __claudia_json() {
    local s=$1
    s=$\{s//\\/\\\\}; s=$\{s//\"/\\\"}; s=$\{s//$'\n'/\\n}; s=$\{s//$'\r'/\\r}; s=$\{s//$'\t'/\\t}; s=$\{s//[[:cntrl:]]/}
    printf '"%s"' "$s"
  }
  __claudia_start() { __claudia_cmd=$1; printf -v __claudia_t0 '%(%s)T' -1; }
  __claudia_debug() {
    [[ -n $__claudia_armed ]] || return 0
    __claudia_armed=''
    [[ $BASH_COMMAND == __claudia_precmd* ]] && return 0
    __claudia_start "$BASH_COMMAND"
  }
  __claudia_precmd() {
    local code=$?
    if [[ -n $__claudia_t0 ]]; then
      local -i t0=$__claudia_t0 t1
      local now cmd=$__claudia_cmd line ok=false body re='^[[:space:]]*[0-9]+[*]?[[:space:]]+(.*)$'
      printf -v now '%(%s)T' -1
      t1=$now
      __claudia_t0=''
      if (( (t1 - t0) * 1000 >= __claudia_min )); then
        line=$(HISTTIMEFORMAT= builtin history 1)
        [[ $line =~ $re ]] && [[ $\{BASH_REMATCH[1]} == *"$cmd"* ]] && cmd=$\{BASH_REMATCH[1]}
        (( code == 0 )) && ok=true
        body="{\"command\":$(__claudia_json "$cmd"),\"ok\":$ok,\"exitCode\":$code,\"startedAt\":$(( t0 * 1000 )),\"endedAt\":$(( t1 * 1000 )),\"durationMs\":$(( (t1 - t0) * 1000 )),\"cwd\":$(__claudia_json "$PWD"),\"shell\":\"bash\",\"pid\":$$,\"output\":[]}"
        ( curl -s -m 1 -o /dev/null -H 'content-type: application/json' -H 'x-claudia: 1' --data-binary "$body" "$__claudia_url" >/dev/null 2>&1 & )
      fi
    fi
    return $code
  }
  __claudia_arm() { local code=$?; __claudia_armed=1; return $code; }
  if [[ -n $bash_preexec_imported || -n $__bp_imported ]]; then
    preexec_functions+=(__claudia_start)
    precmd_functions=(__claudia_precmd "$\{precmd_functions[@]}")
  elif [[ -z $(trap -p DEBUG) ]]; then
    trap '__claudia_debug' DEBUG
    if [[ $(declare -p PROMPT_COMMAND 2>/dev/null) == 'declare -a'* ]]; then
      PROMPT_COMMAND=(__claudia_precmd "$\{PROMPT_COMMAND[@]}" __claudia_arm)
    else
      PROMPT_COMMAND=$'__claudia_precmd\n'"$PROMPT_COMMAND"$'\n__claudia_arm'
    fi
  fi
fi`;
}

// ---------------------------------------------------------------------------------------------
// What the hook posts

const MAX_LINES = 15;
const MAX_OUTPUT = 1500;
const SHELLS = new Set(["powershell", "pwsh", "bash", "zsh", "fish", "cmd"]);
// CSI, OSC, DCS/PM/APC strings, other escapes, and 8-bit CSI
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[PX^_][^\x1b]*(?:\x1b\\)?|\x1b[ -/]+[0-~]|\x1b[@-Z\\-_]|\x9b[0-?]*[ -/]*[@-~]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g; // keeps \t, \n, \r

export const stripAnsi = (s) => String(s).replace(ANSI, "");

const num = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const int = (v) => {
  const n = num(v);
  return n !== null && Number.isInteger(n) && Math.abs(n) <= 2 ** 32 ? n : null;
};
const time = (v) => {
  const n = num(v);
  return n !== null && n > 0 && n < 1e14 ? Math.round(n) : null;
};
const text = (v, max, { multiline = false } = {}) => {
  if (typeof v !== "string") return "";
  let s = stripAnsi(v).replace(/\r\n?/g, "\n").replace(CONTROL, "");
  if (!multiline) s = s.replace(/[\n\t]+/g, " ");
  return clip(s, max);
};

// A progress bar redraws its line with \r; what's left on screen is the last part.
const screenLine = (line) => (line.split("\r").filter(Boolean).at(-1) ?? "").replace(CONTROL, "").trimEnd();

function outputLines(raw) {
  const items = typeof raw === "string" ? [raw.slice(-20_000)] : Array.isArray(raw) ? raw.slice(-200) : [];
  let lines = [];
  for (const item of items) {
    if (typeof item !== "string" && typeof item !== "number") continue;
    for (const line of stripAnsi(String(item).slice(-4000)).split(/\r?\n/)) lines.push(screenLine(line));
  }
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  lines = lines.slice(-MAX_LINES);
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const add = lines[i].length + (kept.length ? 1 : 0);
    if (size + add > MAX_OUTPUT) {
      if (!kept.length) kept.unshift(`…${lines[i].slice(-(MAX_OUTPUT - 1))}`);
      break;
    }
    kept.unshift(lines[i]);
    size += add;
  }
  while (kept.length && !kept[0].trim()) kept.shift();
  return kept;
}

// The body the hook posts (a JSON string, a Buffer, or already parsed) -> a clean event, or null.
// { command, ok, exitCode, startedAt, endedAt, durationMs, cwd, shell, pid, output: [≤15 lines, ≤1500 chars] }
export function parseTerminalEvent(body) {
  let e = body;
  if (typeof e === "string" || Buffer.isBuffer(e)) {
    try {
      e = JSON.parse(String(e));
    } catch {
      return null;
    }
  }
  if (!e || typeof e !== "object" || Array.isArray(e)) return null;
  const command = text(e.command, 1000, { multiline: true });
  if (!command) return null;
  const startedAt = time(e.startedAt);
  const endedAt = time(e.endedAt);
  let durationMs = num(e.durationMs);
  if (durationMs === null && startedAt !== null && endedAt !== null) durationMs = endedAt - startedAt;
  if (durationMs === null || durationMs < 0) return null;
  const exitCode = int(e.exitCode);
  const shell = typeof e.shell === "string" ? e.shell.trim().toLowerCase() : "";
  const pid = int(e.pid);
  return {
    command,
    ok: typeof e.ok === "boolean" ? e.ok : exitCode !== null ? exitCode === 0 : null,
    exitCode,
    startedAt,
    endedAt,
    durationMs: Math.round(Math.min(durationMs, 366 * 86_400_000)),
    cwd: text(e.cwd, 300),
    shell: SHELLS.has(shell) ? shell : "shell",
    pid: pid !== null && pid > 0 ? pid : null,
    output: outputLines(e.output),
  };
}
