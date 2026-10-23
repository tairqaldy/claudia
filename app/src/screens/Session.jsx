// 06 Screens → 2 · Session
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { NeedsYouCard } from "../needs.jsx";
import { guardTyping, haptic } from "../tg.js";
import { Chip, Dots, HandArrow, Icon, Skeleton, StatusSticker, dur, ease, slide, useNow, useToast } from "../ui.jsx";
import { fmtClock, fmtDur, isLatin, rowState } from "../util.js";

export function Session({ id, data, back }) {
  const toast = useToast();
  const s = data.sessions.find((x) => x.id === id);
  const [detail, setDetail] = useState(null);
  const [sent, setSent] = useState([]); // optimistic bubbles until the session's timeline catches up
  const [text, setText] = useState("");
  const [more, setMore] = useState(false);
  const bottom = useRef(null);

  const refresh = () =>
    api
      .session(id)
      .then((d) => {
        setDetail(d);
        setSent((list) => list.filter((b) => !d.timeline?.some((t) => t.type === "you" && t.text === b.text)));
      })
      .catch(() => {});
  useEffect(() => {
    refresh();
    if (s?.status !== "working") return;
    const t = setInterval(refresh, 10_000); // follow along while it works
    return () => clearInterval(t);
  }, [id, s?.status, s?.lastEventAt, data.holds.length]);
  useEffect(() => () => guardTyping(false), []);

  if (!s) {
    return (
      <div className="screen" style={{ paddingTop: 24 }}>
        <button className="link" onClick={back}>
          {Icon.back} sessions
        </button>
        <div className="meta">this session is gone. it might have been closed on the laptop.</div>
      </div>
    );
  }

  const r = rowState(s, Date.now()); // only the meta line below ticks
  const ask = data.holds.find((h) => h.sessionId === id && h.kind !== "stop");
  const hold = data.holds.find((h) => h.sessionId === id && h.kind === "stop");
  const sticker = { done: "done", paused: "paused", failed: "failed", needs: "needs" }[ask ? "needs" : r.kind];
  const recipes = data.recipes.filter((x) => (r.kind === "failed" ? true : x.key !== "continue"));
  const ordered = r.kind === "failed" ? [...recipes.filter((x) => x.key === "continue"), ...recipes.filter((x) => x.key !== "continue")] : recipes;
  const shown = more ? ordered : ordered.slice(0, 3);
  const timeline = detail?.timeline ?? [];
  const lastClaude = timeline.map((t) => t.type).lastIndexOf("claude");

  const send = async (payload, label) => {
    const bubble = { id: Date.now(), text: label, state: "sending" };
    setSent((list) => [...list, bubble]);
    setText("");
    guardTyping(false);
    setTimeout(() => bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" }), 50);
    try {
      if (hold) await api.act("hold", { id: hold.id, ...payload.hold });
      else await api.act(payload.route, { sessionId: id, ...payload.body });
      haptic.success();
      setSent((list) => list.map((b) => (b.id === bubble.id ? { ...b, state: "sent" } : b)));
    } catch (err) {
      haptic.error();
      setSent((list) => list.map((b) => (b.id === bubble.id ? { ...b, state: "failed", error: err.message } : b)));
    }
  };

  const reply = () => {
    if (!text.trim()) return; // the composer shakes instead (see below)
    haptic.tap();
    send({ hold: { action: "reply", value: text }, route: "reply", body: { text } }, text);
  };

  return (
    <div className="screen">
      <m.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: dur.fast }} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 12, minHeight: 56 }}>
        <button className="link" style={{ fontSize: 15 }} onClick={back}>
          {Icon.back} sessions
        </button>
        <AnimatePresence mode="wait">{sticker && <StatusSticker key={sticker} kind={sticker} />}</AnimatePresence>
      </m.div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 6 }}>
        <m.h1 layoutId={`title-${id}`} className={`title${isLatin(s.title) ? "" : " is-content"}`} transition={{ duration: dur.slow, ease: ease.standard }}>
          {s.title}
        </m.h1>
        <SessionMeta s={s} />
      </div>

      <m.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ ...slide, delay: 0.08 }} style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 28 }}>
        {!detail && (
          <>
            <Skeleton width="70%" height={44} />
            <Skeleton width="50%" />
            <Skeleton height={88} />
          </>
        )}
        {timeline.map((t, i) =>
          t.type === "you" ? (
            <div key={i} className="bubble">
              {t.text}
            </div>
          ) : t.type === "activity" ? (
            <div key={i} className="meta" style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {Icon.activity}
              {t.text}
            </div>
          ) : (
            <div key={i} className={`claude card${i === lastClaude ? "" : " is-old"}`}>
              {t.text}
            </div>
          ),
        )}
        <AnimatePresence initial={false}>
          {sent.map((b) => (
            <m.div key={b.id} layout initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={slide} style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
              <div className="bubble">{b.text}</div>
              {b.state === "failed" ? (
                <button className="meta" style={{ color: "var(--color-danger)" }} onClick={() => setSent((list) => list.filter((x) => x.id !== b.id))}>
                  didn't send: {b.error}. tap to dismiss
                </button>
              ) : (
                <div className="meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <Dots /> on it
                </div>
              )}
            </m.div>
          ))}
        </AnimatePresence>
        {detail?.activity && <Activity a={detail.activity} working={r.kind === "working"} />}
        {ask && <NeedsYouCard item={{ key: ask.id, hold: ask, sessionId: id }} session={s} recipes={recipes} />}
        <div ref={bottom} />
      </m.div>

      <div style={{ marginTop: "auto", paddingTop: 24, display: "flex", flexDirection: "column", gap: 14 }}>
        {r.kind === "working" ? (
          <>
            <Composer value={text} onChange={(v) => (setText(v), guardTyping(Boolean(v.trim())))} onSend={reply} />
            <div className="meta" style={{ textAlign: "center" }}>
              it's mid-task. it gets this as soon as it stops
            </div>
          </>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 6, paddingLeft: 4 }}>
              <span className="caption" style={{ fontSize: 19, transform: "rotate(-2deg)" }}>
                one tap, it keeps going
              </span>
              <HandArrow flip />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {shown.map((x) => (
                <Chip key={x.key} onClick={() => send({ hold: { action: "recipe", value: x.key }, route: "recipe", body: { key: x.key } }, x.label)}>
                  {x.label.toLowerCase()}
                </Chip>
              ))}
              {!more && ordered.length > 3 && (
                <button className="ghost" onClick={() => setMore(true)}>
                  more
                </button>
              )}
            </div>
            <Composer value={text} onChange={(v) => (setText(v), guardTyping(Boolean(v.trim())))} onSend={reply} />
            <div className="meta" style={{ textAlign: "center" }}>
              {hold ? "runs in the same session on your laptop" : "resumes it in the background on your laptop"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// what this turn has done so far, from the session's log: the current step, tests, edited files
function Activity({ a, working }) {
  const files = a.files ?? [];
  if (!(working && a.now) && !a.tests && !files.length) return null;
  return (
    <div className="meta" style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {working && a.now && <span style={{ color: "var(--color-text)" }}>▸ {a.now}</span>}
      {a.tests && (
        <span style={{ color: a.tests.failed ? "var(--color-danger)" : undefined }}>
          tests: {a.tests.failed ? `${a.tests.failed} failed, ` : ""}
          {a.tests.passed} passed
        </span>
      )}
      {files.length > 0 && (
        <span>
          edited {files.slice(0, 4).join(", ")}
          {files.length > 4 ? ` +${files.length - 4}` : ""}
        </span>
      )}
    </div>
  );
}

function SessionMeta({ s }) {
  const r = rowState(s, useNow());
  const usual = s.usualMs ? `, usually ~${fmtDur(s.usualMs)}` : "";
  return (
    <div className="meta" style={{ fontSize: 14 }}>
      {r.kind === "working" ? `${s.project} · working ${fmtClock(r.elapsed)}${usual}` : `${s.project}${s.lastDone?.took ? ` · took ${fmtDur(s.lastDone.took)}` : ""}${usual}`}
    </div>
  );
}

function Composer({ value, onChange, onSend }) {
  const [shake, setShake] = useState(0);
  return (
    <m.div className="composer" animate={{ x: shake ? [0, -4, 4, -4, 4, 0] : 0 }} transition={{ duration: 0.3 }} onAnimationComplete={() => setShake(0)}>
      <textarea
        rows={1}
        value={value}
        placeholder="tell it what to do next"
        onChange={(e) => {
          onChange(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`; // grows to 6 lines, then scrolls
        }}
      />
      <m.button
        className="send"
        aria-label="send reply"
        whileTap={{ scale: 0.9 }}
        transition={{ duration: dur.instant }}
        onClick={() => (value.trim() ? onSend() : setShake((n) => n + 1))}
      >
        {Icon.send}
      </m.button>
    </m.div>
  );
}
