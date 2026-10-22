// Claudia's voice. Haiku writes every ping and chat reply; plain templates take over if the API is unreachable.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { lastAssistantText, readTail } from "./transcript.mjs";
import { clip, fmtDur } from "./util.mjs";

const PERSONA = readFileSync(new URL("./persona.md", import.meta.url), "utf8");
const DAY_MS = 24 * 3_600_000;

const PING_RULES = {
  hello: `You were just connected to their Telegram. Say hi in two or three short lines: who you are, that you'll text when a session starts something long, finishes or needs them, and that they can text you any time (/status gives a quick look).`,
  start: `A session has been working for a bit, and you're letting them know it's on it. Name the project and say in a few plain words what it's doing, based on the task. If a usual time is given, add it, like "usually ~12m here". One line. It arrives silently.
Also give the task a label of 2 to 5 lowercase words, without the project name.`,
  done: `A session just stopped. Read its final message and lead with exactly one of: "done" (finished, nothing needed), "needs you" (it asked a question or wants a decision, review or approval), or "stuck" (it hit a problem). Then give the gist in a few plain words, plus what they have to do, if anything. End with how long it took, like "took 14m". Two short lines at most, under 250 characters. No code, and no file paths unless they matter.`,
  ask: `A session is blocked until they answer. Start with the project and that it needs them, then the question or permission in a few words. One or two lines.`,
  long: `A task is running longer than usual. Say so calmly in one line, with how long it's been and the usual time if one is given.`,
  failed: `A session stopped because of an error, not because it finished. Say which project, that it hit an error, and what the error was in plain words. One or two lines.`,
};

const LABELLED = {
  type: "object",
  properties: { label: { type: "string" }, text: { type: "string" } },
  required: ["label", "text"],
  additionalProperties: false,
};

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

export function createBrain({ config, memory, tracker, prefs, onError = () => {} }) {
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
        `## what you're writing\nThis is a ping, not a reply. It lands on their phone, so the first few words should say what happened.\n${PING_RULES[kind]}`,
      ].join("\n\n");
      const res = await client.messages.create({
        model: config.model,
        max_tokens: 1024,
        output_config: { effort: "low", ...(kind === "start" ? { format: { type: "json_schema", schema: LABELLED } } : {}) },
        system,
        messages: [{ role: "user", content: facts(kind, session, extra, config) }],
      });
      const text = textOf(res);
      if (res.stop_reason === "refusal" || !text) return { text: template(kind, session, extra, config) };
      if (kind === "start") {
        const parsed = JSON.parse(text);
        return { text: parsed.text, label: clip(parsed.label, 40) };
      }
      return { text };
    } catch (err) {
      onError(err);
      return { text: template(kind, session, extra, config) };
    }
  }

  async function reply(userText) {
    if (!client) return "my brain isn't connected yet (no anthropic key in setup). /status still works though";
    const quiet = prefs.quietHours();
    const system = [
      persona,
      `## right now\n${now()} (${config.timezone})`,
      `## sessions on the laptop\n${tracker.describe({ detail: true })}`,
      `## your notes\n${notes()}`,
      `## sound\n${quiet ? `quiet hours ${quiet.from}–${quiet.to}: pings arrive silently then` : "no quiet hours set"}${prefs.mutedUntil() > Date.now() ? `; muted for now` : ""}`,
    ].join("\n\n");
    const messages = [...recentChat(), { role: "user", content: userText }];

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
        .map((b) => ({ type: "tool_result", tool_use_id: b.id, content: runTool(b.name, b.input) }));
      messages.push({ role: "user", content: results });
    }
    return "sorry, got a bit tangled there. ask me again?";
  }

  function runTool(name, input) {
    switch (name) {
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
        return [`project: ${s.project}`, `status: ${s.status}`, `task: ${clip(s.prompt, 2000) || "(unknown)"}`, `latest message:\n${clip(said, 4000)}`].join("\n");
      }
      default:
        return `unknown tool ${name}`;
    }
  }

  return { ping, reply };
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
  const lines = [`project: ${s.project}`];
  if (s.label) lines.push(`task label: ${s.label}`);
  if (s.prompt) lines.push(`task they gave it: """${clip(s.prompt, 1200)}"""`);
  if (x.took != null) lines.push(`took: ${fmtDur(x.took)}`);
  if (x.elapsed != null) lines.push(`running for: ${fmtDur(x.elapsed)}`);
  if (x.usually) lines.push(`usually: ~${fmtDur(x.usually)} in this project`);
  if (kind === "ask") lines.push(`what it needs: ${s.waitingFor}`);
  if (x.finalText) lines.push(`its final message:\n"""${x.finalText}"""`);
  if (x.error) lines.push(`error: ${x.error}`);
  return lines.join("\n");
}

function template(kind, s, x, config) {
  const name = s.label ? `${s.project} · ${s.label}` : s.project;
  const usual = x.usually ? `, usually ~${fmtDur(x.usually)}` : "";
  switch (kind) {
    case "hello":
      return `hi ${config.name}, it's claudia. i'll text you when a claude code session starts something long, finishes, or needs you. text me any time, /status for a quick look`;
    case "start":
      return `on it · ${name}${usual}`;
    case "done": {
      const gist = clip((x.finalText ?? "").split("\n").find((l) => l.trim()) ?? "", 200);
      return [`done · ${name}${x.took ? ` · took ${fmtDur(x.took)}` : ""}`, gist].filter(Boolean).join("\n");
    }
    case "ask":
      return `${name} needs you: ${s.waitingFor}`;
    case "long":
      return `still going · ${name} · ${fmtDur(x.elapsed ?? 0)} in${usual}`;
    case "failed":
      return `${name} hit an error: ${x.error}`;
  }
  return name;
}
