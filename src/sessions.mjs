// Follows Claude Code sessions through their hook events and decides when Claudia should ping.
import { basename } from "node:path";
import { lastActivity, lastAssistantText, lastUserPrompt, readTail } from "./transcript.mjs";
import { clip, fmtDur, median, sleep } from "./util.mjs";

const ASK_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);
const FORGET_AFTER_MS = 24 * 3_600_000;
const QUIET_FOR_MS = 5 * 60_000;

const realTimers = { set: setTimeout, clear: clearTimeout };
const realTranscripts = { read: readTail, activity: lastActivity, settle: () => sleep(800) };

export class Tracker {
  constructor({
    state,
    notify,
    save = () => {},
    quietMs = 30_000,
    askDelayMs = 20_000,
    now = Date.now,
    timers = realTimers,
    transcripts = realTranscripts,
    onError = () => {},
    forceLoud = () => false, // e.g. while you're away, every finished turn pings
  }) {
    state.sessions ??= {};
    state.durations ??= {};
    state.projects ??= {};
    state.log ??= [];
    Object.assign(this, { state, notify, save, quietMs, askDelayMs, now, timers, transcripts, onError, forceLoud });
    this.pending = new Map(); // "<session>:<kind>" -> timer handle
    this.inflight = new Map(); // session -> the "started" ping being sent
  }

  async handle(ev) {
    if (!ev?.session_id) return;
    const s = this.touch(ev);
    switch (ev.hook_event_name) {
      case "UserPromptSubmit":
        this.begin(s, ev.prompt, Boolean(ev.claudia_remote));
        break;
      case "PreToolUse":
        if (ASK_TOOLS.has(ev.tool_name)) this.waitFor(s, describeAsk(ev), false);
        break;
      case "PostToolUse":
        if (ASK_TOOLS.has(ev.tool_name)) this.resume(s);
        break;
      case "Notification":
        if (needsYou(ev)) this.waitFor(s, ev.message, true);
        else if (ev.notification_type === "quota_auto_resume_fired") await this.notify("resumed", s, {});
        break;
      case "Stop":
        await this.finish(s, ev);
        break;
      case "StopFailure":
        await this.finish(s, ev, true);
        break;
      case "SessionEnd":
        this.cancel(s.id);
        delete this.state.sessions[s.id];
        break;
    }
    this.save();
  }

  touch(ev) {
    const s = (this.state.sessions[ev.session_id] ??= { id: ev.session_id, status: "idle", turn: 0 });
    if (ev.cwd) {
      s.cwd = ev.cwd;
      s.project = basename(ev.cwd) || ev.cwd;
    }
    s.project ??= "claude";
    if (ev.transcript_path) s.transcript = ev.transcript_path;
    if (ev.session_title) s.label = clip(ev.session_title, 60);
    s.lastEventAt = this.now();
    if (s.cwd) this.rememberProject(s);
    return s;
  }

  // recent project folders, so you can start new work in them from your phone
  rememberProject(s) {
    const projects = this.state.projects;
    projects[s.cwd] = { name: s.project, lastSeen: this.now() };
    const stale = Object.entries(projects).sort((a, b) => b[1].lastSeen - a[1].lastSeen).slice(30);
    for (const [cwd] of stale) delete projects[cwd];
  }

  recentProjects(limit = 8) {
    return Object.entries(this.state.projects)
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .slice(0, limit)
      .map(([cwd, p]) => ({ cwd, name: p.name }));
  }

  begin(s, prompt, remote = false) {
    this.cancel(s.id);
    s.turn += 1;
    Object.assign(s, {
      remote,
      status: "working",
      prompt: clip(prompt, 1500),
      turnStart: this.now(),
      startMsgId: null,
      announced: false,
      waitingFor: null,
    });
    const turn = s.turn;
    this.after(s, "start", this.quietMs, () => {
      const ping = this.announce(s, turn);
      this.inflight.set(s.id, ping);
      return ping.finally(() => this.inflight.delete(s.id));
    });
  }

  async announce(s, turn) {
    const usually = this.usual(s.project);
    const res = await this.notify("start", s, { usually });
    if (s.turn !== turn) return;
    s.announced = true;
    s.startMsgId = res?.messageId ?? null;
    if (res?.label && !s.label) s.label = res.label;
    // one calm check-in if it runs well past the usual time (or an hour when there's no history yet)
    const checkAt = usually ? Math.max(usually * 2, usually + 10 * 60_000) : 60 * 60_000;
    const elapsed = this.now() - s.turnStart;
    this.after(s, "long", Math.max(checkAt - elapsed, 60_000), async () => {
      // an interrupted turn never sends Stop; a silent transcript means it isn't really still going
      const active = this.transcripts.activity(s.transcript);
      if (s.turn !== turn || (active && this.now() - active > QUIET_FOR_MS)) return;
      await this.notify("long", s, { usually, elapsed: this.now() - s.turnStart, replyTo: s.startMsgId });
    });
  }

  waitFor(s, what, checkActivity) {
    s.status = "waiting";
    s.waitingFor = clip(what || "something", 300);
    const since = (s.waitingSince = this.now());
    const turn = s.turn;
    this.after(s, "ask", this.askDelayMs, async () => {
      if (s.turn !== turn || s.status !== "waiting" || s.waitingSince !== since) return;
      // permission prompts have no "answered" event; if the transcript moved on, it was answered
      if (checkActivity && this.transcripts.activity(s.transcript) > since + 3000) return;
      await this.notify("ask", s, { replyTo: s.startMsgId });
    });
  }

  resume(s) {
    this.cancel(s.id, ["ask"]);
    if (s.status === "waiting") {
      s.status = "working";
      s.waitingFor = null;
    }
  }

  async finish(s, ev, failed = false) {
    this.cancel(s.id);
    await this.inflight.get(s.id); // let a "started" ping in flight land first, so "done" can reply to it
    this.cancel(s.id);

    let entries = null;
    const read = async () => {
      if (!entries) {
        await this.transcripts.settle();
        entries = this.transcripts.read(s.transcript);
      }
      return entries;
    };

    let start = s.status === "idle" ? null : s.turnStart;
    if (!start) {
      // the turn started while Claudia was asleep, or without a typed prompt: recover it from the transcript
      const prompt = lastUserPrompt(await read());
      if (prompt?.at && prompt.at > (s.lastDone?.at ?? 0)) start = prompt.at;
    }
    const took = start ? this.now() - start : null;
    const usually = this.usual(s.project);
    const long = took !== null && took >= this.quietMs;
    // the turn ended but work it started in the background is still going: that's a pause, not done
    const background = failed ? [] : backgroundTasks(ev);
    if (long && !background.length) this.record(s, took);

    const loud = long || s.announced || failed || this.forceLoud(s);
    const error = failed ? describeFailure(ev) : null;
    const finalText = loud && !failed ? ev.last_assistant_message || lastAssistantText(await read()) : "";
    const replyTo = s.startMsgId;
    Object.assign(s, {
      status: background.length ? "background" : "idle",
      background,
      waitingFor: null,
      announced: false,
      startMsgId: null,
      lastDone: { at: this.now(), took, summary: clip(error ?? finalText, 600) },
    });
    if (failed) await this.notify("failed", s, { took, error, replyTo });
    else if (background.length) await this.notify("paused", s, { took, background, finalText: clip(finalText, 3000), replyTo });
    else if (loud) await this.notify("done", s, { took, usually, finalText: clip(finalText, 3000), replyTo });
  }

  record(s, ms) {
    const list = (this.state.durations[s.project] ??= []);
    list.push(Math.round(ms / 1000));
    if (list.length > 20) list.shift();
    // a small diary of finished work, for the daily digest
    this.state.log.push({ at: this.now(), project: s.project, label: s.label ?? null, took: Math.round(ms / 1000) });
    if (this.state.log.length > 500) this.state.log.splice(0, this.state.log.length - 500);
  }

  // typical length of a real (non-quick) turn in this project, once there's a little history
  usual(project) {
    const list = this.state.durations[project];
    return list?.length >= 2 ? median(list) * 1000 : null;
  }

  after(s, kind, ms, fn) {
    const key = `${s.id}:${kind}`;
    this.timers.clear(this.pending.get(key));
    const handle = this.timers.set(async () => {
      this.pending.delete(key);
      try {
        await fn();
      } catch (err) {
        this.onError(err);
      }
      this.save();
    }, ms);
    this.pending.set(key, handle);
  }

  cancel(id, kinds = ["start", "ask", "long"]) {
    for (const kind of kinds) {
      const key = `${id}:${kind}`;
      this.timers.clear(this.pending.get(key));
      this.pending.delete(key);
    }
  }

  sessions() {
    const now = this.now();
    for (const [id, s] of Object.entries(this.state.sessions)) {
      if (now - (s.lastEventAt ?? 0) > FORGET_AFTER_MS) delete this.state.sessions[id];
    }
    return Object.values(this.state.sessions).sort((a, b) => (b.lastEventAt ?? 0) - (a.lastEventAt ?? 0));
  }

  // One line per session. `detail` adds the task and last result, for Claudia's own context.
  describe({ detail = false } = {}) {
    const now = this.now();
    const list = this.sessions();
    if (!list.length) return "no sessions seen in the last day";
    return list
      .map((s) => {
        const name = displayName(s);
        const parts = [];
        if (s.status === "working") {
          parts.push(`${name}: working, ${fmtDur(now - s.turnStart)} in`);
          const usually = this.usual(s.project);
          if (usually) parts.push(`usually ~${fmtDur(usually)}`);
          const active = this.transcripts.activity(s.transcript);
          if (active && now - active > QUIET_FOR_MS) parts.push(`no activity for ${fmtDur(now - active)}`);
        } else if (s.status === "waiting") {
          parts.push(`${name}: waiting on you for ${fmtDur(now - s.waitingSince)} (${s.waitingFor})`);
        } else if (s.status === "background") {
          parts.push(`${name}: paused ${fmtDur(now - s.lastDone.at)}, ${s.background.length} background task${s.background.length > 1 ? "s" : ""} still running`);
        } else if (s.lastDone) {
          const took = s.lastDone.took ? `, took ${fmtDur(s.lastDone.took)}` : "";
          parts.push(`${name}: idle, finished ${fmtDur(now - s.lastDone.at)} ago${took}`);
        } else {
          parts.push(`${name}: open, idle`);
        }
        if (detail && s.prompt) parts.push(`task: "${clip(s.prompt, 200)}"`);
        if (detail && s.status !== "working" && s.lastDone?.summary) parts.push(`its last message: "${clip(s.lastDone.summary, 300)}"`);
        return `- ${parts.join(" · ")}`;
      })
      .join("\n");
  }

  find(query) {
    const q = String(query ?? "").toLowerCase();
    const list = this.sessions();
    return list.find((s) => s.project.toLowerCase() === q) ?? list.find((s) => `${s.project} ${s.label ?? ""}`.toLowerCase().includes(q)) ?? null;
  }
}

const NEEDS_YOU = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

// A session's title when it has one; folder names like scratch-2026-10-15-fe816a mean nothing to a person.
export function displayName(s) {
  if (!s.label) return s.project;
  return /^scratch-|^[0-9a-f-]{20,}$/i.test(s.project) ? s.label : `${s.label} · ${s.project}`;
}

function backgroundTasks(ev) {
  const list = Array.isArray(ev.background_tasks) ? ev.background_tasks : [];
  return list
    .filter((t) => !/^(completed|done|failed|killed|stopped)$/i.test(t?.status ?? ""))
    .map((t) => clip(typeof t === "string" ? t : (t?.description ?? t?.command ?? t?.name ?? "a task"), 80));
}

function needsYou(ev) {
  if (ev.notification_type) return NEEDS_YOU.has(ev.notification_type);
  return /permission/i.test(ev.message ?? "");
}

function describeFailure(ev) {
  const err = ev.error ?? ev.message ?? ev.reason;
  const text = typeof err === "string" ? err : (err?.message ?? (err ? JSON.stringify(err) : ""));
  return clip(text || "an API error", 300);
}

function describeAsk(ev) {
  if (ev.tool_name === "ExitPlanMode") return "wants you to approve its plan";
  const questions = ev.tool_input?.questions;
  if (Array.isArray(questions) && questions.length) return questions.map((q) => q.question).filter(Boolean).join(" / ");
  return "has a question for you";
}
