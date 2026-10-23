// Claudia's voice. Haiku writes every ping and chat reply; plain templates take over if the API is unreachable.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { displayName } from "./sessions.mjs";
import { lastAssistantText, readTail } from "./transcript.mjs";
import { clip, fmtDur } from "./util.mjs";

const PERSONA = readFileSync(new URL("./persona.md", import.meta.url), "utf8");
const DAY_MS = 24 * 3_600_000;

const PING_RULES = {
  hello: `You were just connected to their Telegram. Say hi in two or three short lines: who you are, that you'll text when a session starts something long, finishes or needs them, and that they can text you any time (/status gives a quick look).`,
  digest: `Write their daily digest: what got finished since yesterday (grouped by project, with rough total time), what's still running or waiting on them, and one useful observation if there is one (a project eating lots of time, something waiting for days). If almost nothing happened, keep it to one friendly line. At most 6 short lines, plain text, no headers.`,
};

const CARD_RULES = `You're filling in a status card on their phone. The card already shows the session's name, an icon for its state, and how long it took, so never repeat those. "gist" is ONE plain sentence, at most 160 characters: what happened, and what they need to do if anything. No greetings, no code, no file paths unless they matter. "label" is 2 to 5 lowercase words naming the task, without the project name.`;

const SUMMARY_RULES = {
  start: `The session just started working on the task below. gist: a few words on what it's doing. verdict: "done".`,
  done: `The session just stopped. Read its final message. verdict: "done" if it finished and nothing's needed, "needs" if it asked a question or wants a decision, review or approval, "stuck" if it hit a problem it couldn't get past. gist: the outcome, plus what they have to do if anything.`,
  failed: `The session stopped because of an error. gist: the error in plain words; if it's a usage limit, say so and when it resets if known. verdict: "stuck".`,
  paused: `The turn ended but work it started in the background is still running. gist: what's still running and what it did so far. verdict: "done".`,
};

const SUMMARY = {
  type: "object",
  properties: { verdict: { type: "string", enum: ["done", "needs", "stuck"] }, gist: { type: "string" }, label: { type: "string" } },
  required: ["verdict", "gist", "label"],
  additionalProperties: false,
};

// how to refer to sessions, shared by every ping
const NAMING = `Refer to a session by its title when there is one; folder names like scratch-2026-10-15-fe816a mean nothing to a person.`;

const TOOLS = [
  {
    name: "remember",
    description: "Save one short fact about them to your notebook, so you still know it next week.",
    input_schema: {
      type: "object",
      properties: { note: { type: "string", description: "One fact, short, in third person." } },
      required: ["note"],
      additionalProperties: false,
    },
  },
  {
    name: "forget",
    description: "Delete a note that is wrong or outdated, by its #id.",
    input_schema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "set_quiet_hours",
    description:
      "Set the daily hours when your pings arrive without sound. They still arrive, just silently. Use 24h local times like 01:00 and 09:00, or off: true to remove them.",
    input_schema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" }, off: { type: "boolean" } },
      additionalProperties: false,
    },
  },
  {
    name: "set_away",
    description:
      "Turn away mode on or off. On: finished sessions wait a few minutes for their reply here, and questions and permission prompts come to Telegram as buttons. Turn it on when they say they're leaving the laptop, off when they're back.",
    input_schema: { type: "object", properties: { on: { type: "boolean" } }, required: ["on"], additionalProperties: false },
  },
  {
    name: "continue_session",
    description:
      "Give a session on the laptop its next instruction, like 'tell qn5 to commit and push' or 'have it run the tests again'. Only when they clearly ask for it. Works for a session that's waiting for their reply or idle, not one that's mid-task.",
    input_schema: {
      type: "object",
      properties: {
        session: { type: "string", description: "Session title or project name from the sessions list." },
        instruction: { type: "string", description: "What the session should do, in their words." },
        mode: { type: "string", enum: ["do", "plan"], description: "plan: it only plans and sends the plan to their phone for approval first." },
      },
      required: ["session", "instruction"],
      additionalProperties: false,
    },
  },
  {
    name: "start_task",
    description:
      "Start a new Claude Code session in one of their project folders, running on the laptop. It can do anything they'd ask Claude Code to do there: install packages, run and fix tests, build or change features, refactor, review, design with their tools, deploy. Its questions, plans and risky commands come to their phone as buttons. Only when they clearly ask for new work to be started.",
    input_schema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project name from the list of projects you can start work in." },
        task: { type: "string", description: "The full task for the new session, in their words, plus any context from this chat it needs (an error from their terminal, say)." },
        mode: { type: "string", enum: ["do", "plan"], description: "plan: when they want to see a plan first. It plans, then the plan comes to their phone to approve or change." },
      },
      required: ["project", "task"],
      additionalProperties: false,
    },
  },
  {
    name: "look_at_session",
    description:
      "Read a session's full current task and the latest thing it said. Use it when they ask what a session did, found, or is asking.",
    input_schema: {
      type: "object",
      properties: { project: { type: "string", description: "Project name, or part of it, from the sessions list." } },
      required: ["project"],
      additionalProperties: false,
    },
  },
];

export function createBrain({ config, memory, tracker, prefs, actions, onError = () => {} }) {
  const client = config.anthropicKey
    ? new Anthropic({
        apiKey: config.anthropicKey,
        maxRetries: 2,
        timeout: 60_000,
        ...(config.anthropicWorkspace ? { defaultHeaders: { "anthropic-workspace-id": config.anthropicWorkspace } } : {}),
      })
    : null;
  const persona = PERSONA.replaceAll("{{name}}", config.name);

  const notes = () => memory.notes().map((n) => `#${n.id} ${n.text}`).join("\n") || "(empty)";
  const now = () =>
    new Date().toLocaleString("en-GB", {
      timeZone: config.timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

  function recentChat() {
    const since = Date.now() - DAY_MS;
    const recent = memory.history().filter((m) => m.at > since);
    while (recent.length && recent[0].role !== "user") recent.shift(); // a conversation has to open with them
    return recent.map((m) => ({ role: m.role, content: m.text }));
  }

  async function ping(kind, session, extra = {}) {
    if (!client) return { text: template(kind, session, extra, config) };
    try {
      const lastWords = memory
        .history()
        .filter((m) => m.role === "user")
        .slice(-3)
        .map((m) => `- ${clip(m.text, 200)}`)
        .join("\n");
      const system = [
        persona,
        `## your notes\n${notes()}`,
        `## their last few messages (for tone and language)\n${lastWords || "(none yet)"}`,
        `## what you're writing\nThis is a ping, not a reply. It lands on their phone, so the first few words should say what happened. ${NAMING}\n${PING_RULES[kind]}`,
      ].join("\n\n");
      const res = await client.messages.create({
        model: config.model,
        max_tokens: 1024,
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: facts(kind, session, extra, config) }],
      });
      const text = textOf(res);
      if (res.stop_reason === "refusal" || !text) return { text: template(kind, session, extra, config) };
      return { text };
    } catch (err) {
      onError(err);
      return { text: template(kind, session, extra, config) };
    }
  }

  // The words on a status card: a verdict, one sentence of gist, and a short label for the task.
  // The card itself (icon, name, time) is laid out in code, so this never repeats those.
  async function summarize(kind, session, extra = {}) {
    const fallback = summaryTemplate(kind, session, extra);
    if (!client) return fallback;
    try {
      const system = [
        persona,
        `## your notes\n${notes()}`,
        `## what you're writing\n${CARD_RULES}\n${SUMMARY_RULES[kind]}`,
      ].join("\n\n");
      const res = await client.messages.create({
        model: config.model,
        max_tokens: 600,
        output_config: { effort: "low", format: { type: "json_schema", schema: SUMMARY } },
        system,
        messages: [{ role: "user", content: facts(kind, session, extra, config) }],
      });
      const text = textOf(res);
      if (res.stop_reason === "refusal" || !text) return fallback;
      const out = JSON.parse(text);
      return {
        verdict: kind === "done" ? out.verdict : kind === "failed" ? "stuck" : kind === "paused" ? "paused" : "done",
        gist: clip(out.gist, 300),
        label: clip(out.label, 40) || null,
      };
    } catch (err) {
      onError(err);
      return fallback;
    }
  }

  async function reply(userText, images = []) {
    if (!client) return "my brain isn't connected yet (no anthropic key in setup). /status still works though";
    const quiet = prefs.quietHours();
    const system = [
      persona,
      `## right now\n${now()} (${config.timezone})`,
      `## sessions on the laptop\n${tracker.describe({ detail: true })}`,
      `## your notes\n${notes()}`,
      `## sound\n${quiet ? `quiet hours ${quiet.from}–${quiet.to}: pings arrive silently then` : "no quiet hours set"}${prefs.mutedUntil() > Date.now() ? `; muted for now` : ""}`,
      `## away mode\n${actions.away() ? "on: finished sessions wait for their reply here, questions and permissions come as buttons" : "off: they're at the laptop, nothing waits on them"}`,
      `## projects you can start work in\n${actions.projects().join(", ") || "(none seen yet)"}`,
      `## long commands they ran in their terminal lately\n${actions.terminal() || "(none)"}`,
      `## acting for them\nYou can do on the laptop whatever they'd do with Claude Code: start_task for new work in a project, continue_session for the next step in an existing session, look_at_session to see what a session is doing right now. When they reply to one of your cards about a session, that's usually an instruction for that session. Say plainly what you started; don't promise results you haven't seen.`,
    ].join("\n\n");
    const content = [
      ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
      { type: "text", text: userText || "(sent a photo)" },
    ];
    const messages = [...recentChat(), { role: "user", content }];

    for (let step = 0; step < 5; step++) {
      const res = await client.messages.create({
        model: config.model,
        max_tokens: 2048,
        output_config: { effort: "low" },
        system,
        tools: TOOLS,
        messages,
      });
      if (res.stop_reason === "refusal") return "hm, i'll pass on that one";
      if (res.stop_reason !== "tool_use") return textOf(res) || "…";
      messages.push({ role: "assistant", content: res.content });
      const results = res.content
        .filter((b) => b.type === "tool_use")
        .map(async (b) => ({ type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input) }));
      messages.push({ role: "user", content: await Promise.all(results) });
    }
    return "sorry, got a bit tangled there. ask me again?";
  }

  async function runTool(name, input) {
    switch (name) {
      case "set_away":
        actions.setAway(Boolean(input.on));
        return input.on ? "away mode is on" : "away mode is off";
      case "continue_session":
        return actions.continueSession(String(input.session ?? ""), String(input.instruction ?? ""), input.mode === "plan");
      case "start_task":
        return actions.startTask(String(input.project ?? ""), String(input.task ?? ""), input.mode === "plan");
      case "remember": {
        const note = memory.remember(String(input.note ?? ""));
        return note ? `saved as #${note.id}` : "nothing to save";
      }
      case "forget":
        return memory.forget(input.id) ? "deleted" : `there's no note #${input.id}`;
      case "set_quiet_hours": {
        if (input.off) {
          prefs.setQuietHours(null);
          return "quiet hours removed";
        }
        const from = hhmm(input.from);
        const to = hhmm(input.to);
        if (!from || !to || from === to) return "need two different times like 01:00 and 09:00";
        prefs.setQuietHours({ from, to });
        return `quiet hours set: ${from}–${to}`;
      }
      case "look_at_session": {
        const s = tracker.find(input.project);
        if (!s) return "no session like that in the last day";
        const said = lastAssistantText(readTail(s.transcript)) || s.lastDone?.summary || "(nothing yet)";
        return [
          `project: ${s.project}`,
          `status: ${s.status}`,
          `task: ${clip(s.prompt, 2000) || "(unknown)"}`,
          `this turn so far:\n${actions.sessionActivity(s) || "(nothing recorded)"}`,
          `latest message:\n${clip(said, 4000)}`,
        ].join("\n");
      }
      default:
        return `unknown tool ${name}`;
    }
  }

  // Looks over the prompts they typed lately for one request they keep repeating that no shortcut covers yet.
  async function suggestShortcut(prompts, existing) {
    if (!client || prompts.length < 6) return null;
    try {
      const res = await client.messages.create({
        model: config.model,
        max_tokens: 2048,
        output_config: {
          effort: "low",
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                found: { type: "boolean" },
                label: { type: "string" },
                prompt: { type: "string" },
                times: { type: "integer" },
              },
              required: ["found", "label", "prompt", "times"],
              additionalProperties: false,
            },
          },
        },
        system: `You find habits. Given prompts someone typed to Claude Code, find the ONE kind of request they made at least 3 times in different sessions that isn't covered by their existing shortcuts (${existing.join(", ")}). Return found=false if there's none. Otherwise: label = 1 to 3 words in sentence case, prompt = a clear, general instruction that does what they keep asking for (no project-specific names), times = how often you saw it.`,
        messages: [{ role: "user", content: prompts.map((p) => `- [${p.project}] ${clip(p.text, 300)}`).join("\n") }],
      });
      const out = JSON.parse(textOf(res));
      return out.found && out.times >= 3 ? out : null;
    } catch (err) {
      onError(err);
      return null;
    }
  }

  return { ping, summarize, reply, suggestShortcut };
}

// What to tell them when the chat call itself fails.
export function explainError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError)
    return "my anthropic key isn't working, so i can't think right now. /status still works";
  if (err instanceof Anthropic.RateLimitError) return "i'm being rate limited, give me a minute";
  if (err instanceof Anthropic.APIConnectionError) return "can't reach anthropic right now. is the wifi ok?";
  if (err instanceof Anthropic.APIError) return `anthropic returned an error (${err.status}). try again in a bit?`;
  return "something broke on my side, sorry. check `npm run logs` on the laptop";
}

// "1:00", "01:00", "9" -> "01:00", "09:00"
function hhmm(text) {
  const m = String(text ?? "").trim().match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!m || Number(m[1]) > 23 || Number(m[2] ?? 0) > 59) return null;
  return `${m[1].padStart(2, "0")}:${m[2] ?? "00"}`;
}

function textOf(res) {
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function facts(kind, s, x, config) {
  if (kind === "hello") return `their name: ${config.name}`;
  if (kind === "digest") return x.facts;
  const lines = [`session: ${displayName(s)}`, `project folder: ${s.project}`];
  if (s.prompt) lines.push(`task they gave it: """${clip(s.prompt, 1200)}"""`);
  if (x.took != null) lines.push(`took: ${fmtDur(x.took)}`);
  if (x.elapsed != null) lines.push(`running for: ${fmtDur(x.elapsed)}`);
  if (x.usually) lines.push(`usually: ~${fmtDur(x.usually)} in this project`);
  if (kind === "ask") lines.push(`what it needs: ${s.waitingFor}`);
  if (x.finalText) lines.push(`its final message:\n"""${x.finalText}"""`);
  if (x.error) lines.push(`error: ${x.error}`);
  if (x.background?.length) lines.push(`still running in the background: ${x.background.join("; ")}`);
  return lines.join("\n");
}

function summaryTemplate(kind, s, x) {
  const firstLine = clip((x.finalText ?? "").split("\n").find((l) => l.trim()) ?? "", 200);
  if (kind === "failed") return { verdict: "stuck", gist: x.error ?? "an API error", label: null };
  if (kind === "paused") return { verdict: "paused", gist: `still running: ${(x.background ?? []).join(", ")}`, label: null };
  return { verdict: "done", gist: kind === "done" ? firstLine : "", label: null };
}

// when the API is unreachable: the hello and the digest still go out, plainly
function template(kind, s, x, config) {
  if (kind === "hello") return `hi ${config.name}, it's claudia. every task gets one card here: quiet while it works, a sound when it's done or needs you. text me any time, /status for a quick look`;
  return x.facts ?? "";
}
