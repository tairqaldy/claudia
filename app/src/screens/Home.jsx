// 06 Screens → 1 · Sessions
import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { NeedsYouCard } from "../needs.jsx";
import { haptic } from "../tg.js";
import { Bolt, Dots, HandArrow, Heart, Icon, Mark, MarkerUnderline, Odometer, Pill, Progress, StatusPill, dur, ease, slide, useNow, useToast } from "../ui.jsx";
import { fmtClock, fmtDur, rowState, timeOfDay } from "../util.js";

export function Home({ data, open, go, offline, staleAt, retry }) {
  const toast = useToast();
  const firstLoad = useRef(true);
  const [showAll, setShowAll] = useState(false);
  const sessions = data.sessions;
  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  const working = sessions.filter((s) => s.status === "working");

  // things waiting on you: holds first (answerable here), then questions only answerable on the laptop
  const asks = data.holds.filter((h) => h.kind !== "stop").map((h) => ({ key: h.id, hold: h, sessionId: h.sessionId }));
  const laptopOnly = sessions
    .filter((s) => s.status === "waiting" && !asks.some((a) => a.sessionId === s.id))
    .map((s) => ({ key: `w-${s.id}`, sessionId: s.id, text: s.waitingFor, since: s.waitingSince }));
  const finished = data.holds.filter((h) => h.kind === "stop").map((h) => ({ key: h.id, hold: h, sessionId: h.sessionId }));
  const needs = [...asks, ...laptopOnly, ...finished];
  const needsCount = asks.length + laptopOnly.length;
  const later = sessions.filter((s) => s.status !== "working" && s.status !== "waiting" && (s.status !== "idle" || s.lastDone)).slice(0, 5);
  const shownNeeds = showAll ? needs : needs.slice(0, 1);
  // stagger 40ms, max 5, on first load only (04 Motion → rule 06)
  const stagger = (i) => (firstLoad.current ? { delay: Math.min(i, 5) * 0.04 } : {});
  useEffect(() => {
    const t = setTimeout(() => (firstLoad.current = false), 600);
    return () => clearTimeout(t);
  }, []);

  const toggleAway = async () => {
    haptic.select();
    try {
      await api.act("away", { on: !data.away });
      toast(data.away ? "back at the laptop, nothing waits on your phone" : "away mode on, sessions wait for you here");
    } catch (err) {
      toast(err.message, "error");
    }
  };

  const recipes = data.recipes.filter((r) => r.key !== "continue");

  return (
    <div className="screen">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", paddingTop: 14 }}>
        <Mark busy={working.length > 0} />
        <m.button
          className="pill is-main"
          style={{ fontSize: 16, padding: "9px 20px", gap: 8 }}
          whileTap={{ y: 1, backgroundColor: "var(--color-surface-2)" }}
          transition={{ duration: dur.instant }}
          onClick={toggleAway}
          aria-pressed={data.away}
        >
          <span style={{ width: 8, height: 8, borderRadius: 4, background: data.away ? "var(--color-primary)" : "transparent", border: data.away ? 0 : "1.5px solid var(--color-text-2)" }} />
          {data.away ? "away" : "at the laptop"}
        </m.button>
      </div>

      <h1 className="headline" style={{ paddingTop: 26 }}>
        {working.length > 0 && (
          <div>
            <Odometer value={working.length} /> working{needsCount ? "," : ""}
          </div>
        )}
        {needsCount > 0 && (
          <div style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start" }}>
            <span style={{ color: "var(--color-primary)" }}>
              <Odometer value={needsCount} /> {needsCount === 1 ? "needs" : "need"} you
            </span>
            <MarkerUnderline replayKey={needsCount} />
          </div>
        )}
        {!working.length && !needsCount && <div>all quiet</div>}
      </h1>

      {needsCount > 0 && (
        <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "flex-end", gap: 6, padding: "10px 0 6px" }}>
          <HandArrow />
          <span className="caption">{asks.length + laptopOnly.length === 1 ? `${byId[needs[0].sessionId]?.project ?? "a session"} wants an answer` : `${needsCount} want answers`}</span>
        </div>
      )}

      {staleAt && !offline && (
        <div className="meta" style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 10 }}>
          <Dots /> showing {timeOfDay(staleAt)}, catching up
        </div>
      )}

      {offline && (
        <div style={{ marginTop: 20, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, padding: 22, borderRadius: "var(--radius-md)", background: "var(--color-danger-soft)" }}>
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, color: "var(--color-danger)" }}>can't reach the laptop</div>
          <div className="meta">it might be asleep, or the tunnel dropped. still trying{staleAt ? `, showing ${timeOfDay(staleAt)}` : ""}.</div>
          <Pill onClick={retry}>try now</Pill>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: needsCount ? 0 : 20 }}>
        <AnimatePresence initial={false}>
          {shownNeeds.map((item) => (
            <NeedsYouCard key={item.key} item={item} session={byId[item.sessionId]} recipes={recipes} onOpen={() => open(item.sessionId)} />
          ))}
        </AnimatePresence>
        {needs.length > 1 && !showAll && (
          <button className="link" style={{ alignSelf: "flex-start" }} onClick={() => setShowAll(true)}>
            +{needs.length - 1} more waiting
          </button>
        )}
      </div>

      {working.length > 0 && (
        <section style={{ paddingTop: 30 }}>
          <div className="section">
            working <Bolt />
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {working.map((s, i) => (
              <SessionRow key={s.id} s={s} onOpen={() => open(s.id)} transition={stagger(i)} />
            ))}
          </div>
        </section>
      )}

      {later.length > 0 && (
        <section style={{ paddingTop: 26 }}>
          <div className="section">lately</div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {later.map((s, i) => (
              <SessionRow key={s.id} s={s} onOpen={() => open(s.id)} transition={stagger(i + working.length)} />
            ))}
          </div>
        </section>
      )}

      {!sessions.length && !offline && (
        <div style={{ marginTop: 24, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 10, padding: 28, borderRadius: "var(--radius-md)", background: "var(--color-surface)" }}>
          <Heart />
          <div style={{ fontFamily: "var(--font-display)", fontSize: 22, fontWeight: 500, color: "var(--color-heading)" }}>all quiet</div>
          <div className="meta">nothing's running. start something, or enjoy it.</div>
        </div>
      )}

      <div style={{ marginTop: "auto", paddingTop: 28, display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
        <Pill main icon={Icon.plus} onClick={() => go("new")}>
          start something new
        </Pill>
        <div className="meta" style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span>{data.doneToday.count ? `${data.doneToday.count} done today · ${fmtDur(data.doneToday.totalMs)} of work` : "nothing finished yet today"}</span>
          <span>·</span>
          <button className="link" style={{ minHeight: 32 }} onClick={() => go("laptop")}>
            laptop{data.laptop.battery ? ` ${data.laptop.battery.percent}%` : ""} ›
          </button>
        </div>
      </div>
    </div>
  );
}

export function SessionRow({ s, onOpen, transition }) {
  // the row and its shared title re-render only when the data changes; only the small parts
  // that show time tick every second
  const { kind } = rowState(s, Date.now());
  return (
    <m.button
      layout="position"
      className="row"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: dur.fast, ease: ease.exit } }}
      transition={{ ...slide, ...transition }}
      onClick={() => {
        haptic.tap();
        onOpen();
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, width: "100%" }}>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
          <m.div layoutId={`title-${s.id}`} className="row-title" style={{ color: kind === "idle" ? "var(--color-text-2)" : undefined }}>
            {s.title}
          </m.div>
          <RowMeta s={s} />
        </div>
        {kind === "working" ? (
          <RowClock s={s} />
        ) : kind === "idle" ? (
          <span style={{ width: 8, height: 8, borderRadius: 4, background: "var(--color-neutral-400)", flexShrink: 0, marginTop: 8 }} />
        ) : (
          <StatusPill kind={kind} />
        )}
      </div>
      {kind === "working" && <RowProgress s={s} />}
    </m.button>
  );
}

function RowMeta({ s }) {
  const r = rowState(s, useNow());
  const project = s.title !== s.project ? s.project : "";
  return <div className="meta">{[project, r.kind !== "working" && r.note].filter(Boolean).join(" · ")}</div>;
}

function RowClock({ s }) {
  const r = rowState(s, useNow());
  return (
    <span className="mono" style={{ width: 96, flexShrink: 0, textAlign: "right", fontSize: 15, color: r.tone === "quiet" ? "var(--color-text-2)" : undefined }}>
      {fmtClock(r.elapsed)}
    </span>
  );
}

function RowProgress({ s }) {
  const r = rowState(s, useNow());
  if (r.progress === null && !r.note) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
      {r.progress !== null ? <Progress value={r.progress} tone={r.tone} /> : <div style={{ flex: 1 }} />}
      <span style={{ width: 96, flexShrink: 0, textAlign: "right", fontSize: 12, color: r.tone === "over" ? "var(--color-primary-ink)" : "var(--color-text-2)" }}>{r.note}</span>
    </div>
  );
}
