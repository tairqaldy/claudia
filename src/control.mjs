// Away mode. While you're away from the laptop, a session that finishes waits for your reply on
// Telegram, and its questions, plan approvals and permission prompts become buttons.
// At the laptop nothing ever waits: every hook gets an empty answer right away.
import { randomBytes } from "node:crypto";
import { esc } from "./cards.mjs";
import { displayName } from "./sessions.mjs";
import { clip } from "./util.mjs";

const BUTTON_OPS = new Set(["r", "m", "x", "a", "s", "o", "pa", "pc", "ya", "yd"]);
const ORPHAN_MS = 2 * 60_000; // a finished-session hold with no ping to reply to is let go

export function createControl({ state, save, tg, config, tracker, recipes, log = () => {}, onChange = () => {} }) {
  const holds = new Map();
  const chat = () => config.chatId;
  const nameOf = (h) => {
    const s = tracker.state.sessions[h.sessionId];
    return s ? displayName(s) : "a session";
  };

  const away = () => Boolean(state.away);
  function setAway(on) {
    state.away = Boolean(on);
    save();
    if (!on) for (const h of [...holds.values()]) settle(h, {}, "↳ you're back at the laptop");
  }

  // Called by the synchronous hooks. Resolves with the hook's JSON output; {} means carry on as usual.
  function decide(ev) {
    if (!chat() || !(away() || ev.claudia_remote)) return Promise.resolve({});
    const { hook_event_name: name, tool_name: tool } = ev;
    if (name === "Stop") return open(ev, "stop");
    if (name === "PermissionRequest") return open(ev, "permission", sendPermission);
    if (name === "PreToolUse" && tool === "AskUserQuestion") return open(ev, "ask", sendQuestions);
    if (name === "PreToolUse" && tool === "ExitPlanMode") return open(ev, "plan", sendPlan);
    return Promise.resolve({});
  }

  function open(ev, kind, send) {
    return new Promise((resolve) => {
      const h = { id: randomBytes(4).toString("hex"), kind, ev, sessionId: ev.session_id, resolve, since: Date.now() };
      Object.assign(h, { messages: [], texts: {}, qMsg: [], answers: {}, picks: {}, awaiting: null });
      const timeout = kind === "stop" ? "↳ no reply, so it stopped there" : "↳ no answer here, so it's waiting on the laptop";
      h.timer = setTimeout(() => settle(h, {}, timeout), config.holdMinutes * 60_000);
      // the "done" ping is sent by the tracker and attached below; if it never comes, don't keep the session waiting
      if (kind === "stop") h.orphan = setTimeout(() => !h.messages.length && settle(h, {}), ORPHAN_MS);
      holds.set(h.id, h);
      onChange();
      send?.(h).catch((err) => {
        log("control:", err);
        settle(h, {});
      });
    });
  }

  function settle(h, output, note = null) {
    if (!holds.delete(h.id)) return;
    clearTimeout(h.timer);
    clearTimeout(h.orphan);
    h.resolve(output);
    onChange();
    for (const m of h.messages) {
      // cards are HTML (see cards.mjs); question and plan messages are plain text
      if (note && h.texts[m]) tg.edit(chat(), m, `${h.texts[m]}\n\n${h.html?.[m] ? esc(note) : note}`, undefined, { html: Boolean(h.html?.[m]) });
      else tg.setButtons(chat(), m);
    }
  }

  function continueWith(h, instruction, shown = clip(instruction, 80)) {
    settle(h, { decision: "block", reason: `${config.name} replied from Telegram: ${instruction}` }, `↳ ${shown}`);
    const s = tracker.state.sessions[h.sessionId];
    if (s) tracker.begin(s, instruction, s.remote);
    save();
  }

  // ---- finished sessions: the tracker's "done" ping becomes the place to reply

  const stopHold = (sessionId) =>
    [...holds.values()].find((h) => h.kind === "stop" && h.sessionId === sessionId && !h.messages.length) ?? null;

  function attach(h, messageId, text, html = false) {
    h.messages.push(messageId);
    h.texts[messageId] = text;
    if (html) (h.html ??= {})[messageId] = true;
  }

  function stopButtons(h, all = false) {
    const list = recipes();
    const shown = (all ? list : list.slice(0, 3)).map((r) => ({ text: r.label, callback_data: `r:${h.id}:${r.key}` }));
    const rows = chunk(shown, all ? 2 : 3);
    rows.push(all ? [{ text: "Done for now", callback_data: `x:${h.id}` }] : [
      { text: "More", callback_data: `m:${h.id}` },
      { text: "Done for now", callback_data: `x:${h.id}` },
    ]);
    return { inline_keyboard: rows };
  }

  // a question or permission is already on its way as buttons, so the tracker's plain "needs you" ping is redundant
  const asking = (sessionId) => [...holds.values()].some((h) => h.sessionId === sessionId && h.kind !== "stop");

  // ---- questions (AskUserQuestion)

  const questionsOf = (h) => (h.ev.tool_input?.questions ?? []).filter((q) => q?.question);

  async function sendQuestions(h) {
    const questions = questionsOf(h);
    if (!questions.length) return settle(h, {});
    for (const [qi, q] of questions.entries()) {
      const details = (q.options ?? []).filter((o) => o.description).map((o) => `· ${o.label}: ${clip(o.description, 120)}`);
      const text = [`${nameOf(h)} is asking:`, q.question, details.length ? `\n${details.join("\n")}` : ""].join("\n").trim();
      const msg = await tg.send(chat(), text, { markup: questionButtons(h, qi) });
      attach(h, msg.message_id, text);
      h.qMsg[qi] = msg.message_id;
    }
  }

  function questionButtons(h, qi) {
    const q = questionsOf(h)[qi];
    const picked = h.picks[qi] ?? new Set();
    const options = (q.options ?? []).map((o, oi) => ({
      text: `${picked.has(o.label) ? "✓ " : ""}${clip(o.label, 40)}`,
      callback_data: `a:${h.id}:${qi}:${oi}`,
    }));
    const short = options.every((o) => o.text.length <= 18);
    const rows = short ? chunk(options, 2) : options.map((o) => [o]);
    rows.push([{ text: "Other…", callback_data: `o:${h.id}:${qi}` }, ...(q.multiSelect ? [{ text: "Send", callback_data: `s:${h.id}:${qi}` }] : [])]);
    return { inline_keyboard: rows };
  }

  function answer(h, qi, value) {
    const questions = questionsOf(h);
    const q = questions[qi];
    if (!q || !value) return;
    h.answers[q.question] = value;
    const m = h.qMsg[qi];
    if (m) {
      h.texts[m] = `${h.texts[m]}\n\n↳ ${value}`;
      tg.edit(chat(), m, h.texts[m]);
    }
    onChange();
    if (Object.keys(h.answers).length < questions.length) return;
    settle(h, {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...h.ev.tool_input, answers: h.answers },
      },
    });
  }

  // ---- plans (ExitPlanMode) and permission prompts

  async function sendPlan(h) {
    const text = `${nameOf(h)} has a plan ready:\n\n${clip(h.ev.tool_input?.plan ?? "", 3300)}`;
    const msg = await tg.send(chat(), text, {
      markup: { inline_keyboard: [[{ text: "Approve", callback_data: `pa:${h.id}` }, { text: "Change it", callback_data: `pc:${h.id}` }]] },
    });
    attach(h, msg.message_id, text);
  }

  async function sendPermission(h) {
    const text = `${nameOf(h)} wants to ${describeTool(h.ev)}`;
    const msg = await tg.send(chat(), text, {
      markup: { inline_keyboard: [[{ text: "Allow", callback_data: `ya:${h.id}` }, { text: "Deny", callback_data: `yd:${h.id}` }]] },
    });
    attach(h, msg.message_id, text);
  }

  const allowTool = (h) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: h.ev.tool_input } });
  const changePlan = (feedback) => ({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `${config.name} wants changes to the plan: ${feedback}` },
  });
  const permission = (behavior, why) => ({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: behavior === "allow" ? { behavior } : { behavior, message: why ? `${config.name} denied this: ${why}` : `${config.name} denied this from Telegram` },
    },
  });

  async function askForText(h, awaiting, prompt) {
    h.awaiting = awaiting;
    const msg = await tg.send(chat(), prompt, { markup: { force_reply: true, input_field_placeholder: "type here" } });
    h.messages.push(msg.message_id);
  }

  // ---- Telegram input

  async function onButton(q) {
    const [op, hid, a, b] = String(q.data ?? "").split(":");
    if (!BUTTON_OPS.has(op)) return false;
    const h = holds.get(hid);
    const messageId = q.message?.message_id;
    if (!h) {
      await tg.answerButton(q.id, "that one's already settled");
      if (messageId) await tg.setButtons(chat(), messageId);
      return true;
    }
    await tg.answerButton(q.id);
    switch (op) {
      case "r": {
        const recipe = recipes().find((r) => r.key === a);
        if (recipe) continueWith(h, recipe.prompt, recipe.label);
        break;
      }
      case "m":
        await tg.setButtons(chat(), messageId, stopButtons(h, true));
        break;
      case "x":
        settle(h, {}, "↳ left it there");
        break;
      case "a": {
        const q2 = questionsOf(h)[Number(a)];
        const label = q2?.options?.[Number(b)]?.label;
        if (!label) break;
        if (!q2.multiSelect) answer(h, Number(a), label);
        else {
          const set = (h.picks[a] ??= new Set());
          set.has(label) ? set.delete(label) : set.add(label);
          await tg.setButtons(chat(), messageId, questionButtons(h, Number(a)));
        }
        break;
      }
      case "s":
        answer(h, Number(a), [...(h.picks[a] ?? [])].join(", "));
        break;
      case "o":
        await askForText(h, { type: "other", q: Number(a) }, "type your answer");
        break;
      case "pa":
        settle(h, allowTool(h), "↳ approved");
        break;
      case "pc":
        await askForText(h, { type: "plan" }, "what should change?");
        break;
      case "ya":
        settle(h, permission("allow"), "↳ allowed");
        break;
      case "yd":
        settle(h, permission("deny"), "↳ denied");
        break;
    }
    return true;
  }

  // A reply (swipe left) to one of the waiting messages. Returns true when it was for a session.
  function onReply(msg, text) {
    const to = msg.reply_to_message?.message_id;
    const h = to && [...holds.values()].find((x) => x.messages.includes(to));
    if (!h || !text) return false;
    tg.react(chat(), msg.message_id, "👨‍💻");
    if (h.kind === "stop") continueWith(h, text);
    else if (h.kind === "ask") answer(h, h.awaiting?.type === "other" ? h.awaiting.q : Math.max(0, h.qMsg.indexOf(to)), text);
    else if (h.kind === "plan") settle(h, changePlan(text), "↳ sent back with your changes");
    else if (h.kind === "permission") settle(h, permission("deny", text), "↳ denied");
    return true;
  }

  // From chat ("tell qn5 to commit"). Returns null when that session isn't waiting for you.
  function continueSession(sessionId, instruction) {
    const h = [...holds.values()].find((x) => x.kind === "stop" && x.sessionId === sessionId);
    if (!h) return null;
    continueWith(h, instruction);
    return true;
  }

  const release = (h) => settle(h, {});

  // ---- the Mini App sees the same holds and answers through the same paths as Telegram buttons

  function list() {
    return [...holds.values()].map((h) => ({
      id: h.id,
      kind: h.kind,
      sessionId: h.sessionId,
      since: h.since,
      answers: h.answers,
      questions:
        h.kind === "ask"
          ? questionsOf(h).map((q) => ({
              question: q.question,
              multiSelect: Boolean(q.multiSelect),
              options: (q.options ?? []).map((o) => ({ label: o.label, description: o.description ?? "" })),
            }))
          : [],
      text: h.kind === "plan" ? clip(h.ev.tool_input?.plan ?? "", 3000) : h.kind === "permission" ? describeTool(h.ev) : "",
    }));
  }

  function act(holdId, action, value) {
    const h = holds.get(holdId);
    if (!h) return false;
    const fits = { answer: "ask", reply: "stop", recipe: "stop", done: "stop", approve: "plan", change: "plan", allow: "permission", deny: "permission" };
    if (fits[action] !== h.kind) return false;
    switch (action) {
      case "answer":
        answer(h, Number(value?.q), Array.isArray(value?.value) ? value.value.join(", ") : String(value?.value ?? ""));
        return true;
      case "reply":
        continueWith(h, clip(value, 4000));
        return true;
      case "recipe": {
        const recipe = recipes().find((r) => r.key === value);
        if (!recipe) return false;
        continueWith(h, recipe.prompt, recipe.label);
        return true;
      }
      case "done":
        settle(h, {}, "↳ left it there");
        return true;
      case "approve":
        settle(h, allowTool(h), "↳ approved");
        return true;
      case "change":
        settle(h, changePlan(clip(value, 2000) || "make changes"), "↳ sent back with your changes");
        return true;
      case "allow":
        settle(h, permission("allow"), "↳ allowed");
        return true;
      case "deny":
        settle(h, permission("deny", value ? clip(value, 500) : undefined), "↳ denied");
        return true;
    }
    return false;
  }

  return { away, setAway, decide, stopHold, attach, release, stopButtons, asking, onButton, onReply, continueSession, list, act, count: () => holds.size };
}

function describeTool(ev) {
  const input = ev.tool_input ?? {};
  if (ev.tool_name === "Bash" || ev.tool_name === "PowerShell") return `run:\n${clip(input.command, 500)}`;
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(ev.tool_name)) return `edit ${input.file_path ?? input.notebook_path ?? "a file"}`;
  if (ev.tool_name === "WebFetch") return `open ${input.url}`;
  return `use ${ev.tool_name}`;
}

function chunk(items, size) {
  const rows = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
