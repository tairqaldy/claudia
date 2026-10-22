// The needs-you card (02 Components → cards & rows): questions, plans, permissions, and finished
// sessions waiting for a reply while you're away.
import { m, useReducedMotion } from "motion/react";
import { useState } from "react";
import { api } from "./api.js";
import { haptic } from "./tg.js";
import { Chip, dur, ease, Icon, slide, useToast } from "./ui.jsx";
import { fmtDur, isLatin } from "./util.js";

const KIND = { ask: "asking", plan: "plan", permission: "permission", stop: "waiting for you", waiting: "asking" };

export function NeedsYouCard({ item, session, now, recipes, onOpen }) {
  const toast = useToast();
  const reduced = useReducedMotion();
  const [picked, setPicked] = useState([]); // labels chosen for the current question
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const hold = item.hold;
  const question = hold?.kind === "ask" ? hold.questions.find((q) => !(q.question in (hold.answers ?? {}))) : null;
  const qi = question ? hold.questions.indexOf(question) : -1;
  const age = now - (hold?.since ?? item.since ?? now);

  const act = async (action, value, label) => {
    try {
      await api.act("hold", { id: hold.id, action, value });
      haptic.success();
      if (label) toast(label);
    } catch (err) {
      haptic.error();
      toast(err.message, "error");
    }
  };

  const pick = (label) => {
    if (question.multiSelect) return setPicked((p) => (p.includes(label) ? p.filter((x) => x !== label) : [...p, label]));
    setPicked([label]);
    setTimeout(() => act("answer", { q: qi, value: label }), 400); // a beat to see the ✓
  };

  const title = session?.title ?? "a session";
  const meta = `${title}${session?.project && session.project !== title ? ` · ${session.project}` : ""} · ${KIND[hold?.kind ?? "waiting"]}`;
  const bigText = question?.question ?? (hold?.kind === "permission" ? null : item.text);

  return (
    <m.div
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: dur.emph * 0.7, ease: ease.exit } }}
      transition={slide}
      className="card"
      style={{ display: "flex", flexDirection: "column", gap: 14, padding: 20, overflow: "hidden" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13 }}>
        <span style={{ color: "var(--color-primary-ink)" }}>{meta}</span>
        <span className="mono" style={{ color: "var(--color-text-2)", flexShrink: 0 }}>
          {hold?.kind === "stop" ? `${fmtDur(Math.max(0, 8 * 60_000 - age))} left` : fmtDur(age)}
        </span>
      </div>

      {bigText && (
        <div
          style={{
            fontFamily: isLatin(bigText) ? "var(--font-display)" : "var(--font-sans)",
            fontSize: isLatin(bigText) ? 22 : 18,
            lineHeight: "28px",
            fontWeight: 500,
            color: "var(--color-heading)",
            display: "-webkit-box",
            WebkitLineClamp: hold?.kind === "plan" ? 6 : 3,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
            whiteSpace: "pre-wrap",
          }}
        >
          {bigText}
        </div>
      )}
      {hold?.kind === "permission" && (
        <div className="mono" style={{ fontSize: 14, lineHeight: "20px", padding: "10px 12px", borderRadius: "var(--radius-sm)", background: "var(--color-surface)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
          {hold.text}
        </div>
      )}

      {writing ? (
        <div className="composer">
          <textarea autoFocus rows={1} value={text} placeholder={hold?.kind === "plan" ? "what should change?" : "type your answer"} onChange={(e) => setText(e.target.value)} />
          <m.button
            className="send"
            aria-label="send"
            whileTap={{ scale: 0.9 }}
            transition={{ duration: dur.instant }}
            onClick={() => {
              if (!text.trim()) return;
              haptic.tap();
              if (hold.kind === "plan") act("change", text, "sent back with your changes");
              else if (hold.kind === "ask") act("answer", { q: qi, value: text });
              else act("deny", text, "denied");
            }}
          >
            {Icon.send}
          </m.button>
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {hold?.kind === "ask" && question && (
            <>
              {question.options.map((o) => (
                <m.div key={o.label} animate={{ opacity: picked.length && !question.multiSelect && !picked.includes(o.label) ? 0.4 : 1 }} transition={{ duration: dur.fast }}>
                  <Chip picked={picked.includes(o.label)} onClick={() => pick(o.label)}>
                    {picked.includes(o.label) && Icon.check}
                    {o.label}
                  </Chip>
                </m.div>
              ))}
              {question.multiSelect && picked.length > 0 && <Chip onClick={() => act("answer", { q: qi, value: picked })}>send</Chip>}
              <button className="ghost" onClick={() => setWriting(true)}>
                other…
              </button>
            </>
          )}
          {hold?.kind === "plan" && (
            <>
              <Chip onClick={() => act("approve", null, "plan approved")}>approve</Chip>
              <button className="ghost" onClick={() => setWriting(true)}>
                change it
              </button>
            </>
          )}
          {hold?.kind === "permission" && (
            <>
              <Chip onClick={() => act("allow", null, "allowed")}>allow</Chip>
              <Chip deny onClick={() => act("deny", null, "denied")}>
                deny
              </Chip>
            </>
          )}
          {hold?.kind === "stop" && (
            <>
              {recipes.slice(0, 2).map((r) => (
                <Chip key={r.key} onClick={() => act("recipe", r.key, `sent to ${title}`)}>
                  {r.label.toLowerCase()}
                </Chip>
              ))}
              <button className="ghost" onClick={onOpen}>
                reply ›
              </button>
            </>
          )}
          {!hold && (
            <div className="meta">answer on the laptop. with away mode on, questions can be answered right here.</div>
          )}
        </div>
      )}
    </m.div>
  );
}
