// Components from 02 Components, with the motion from 04 Motion.
import { AnimatePresence, m, useReducedMotion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { haptic } from "./tg.js";

// ---- motion tokens
export const ease = {
  standard: [0.2, 0, 0, 1],
  enter: [0.05, 0.7, 0.1, 1],
  exit: [0.3, 0, 1, 1],
};
export const dur = { instant: 0.08, fast: 0.14, base: 0.2, emph: 0.28, stamp: 0.32, slow: 0.36, draw: 0.42 };
export const stamp = { type: "spring", stiffness: 500, damping: 18 };
// cards and rows never overshoot (rule 05)
export const slide = { duration: dur.emph, ease: ease.enter };

// One shared clock: a single interval, and only the small pieces that show time re-render each
// second (never whole screens). It runs only while something on screen shows a timer.
const clock = { now: Date.now(), subs: new Set(), timer: 0 };
function subscribe(fn) {
  clock.subs.add(fn);
  if (!clock.timer) {
    clock.now = Date.now();
    clock.timer = setInterval(() => {
      if (document.hidden) return;
      clock.now = Date.now();
      for (const f of clock.subs) f();
    }, 1000);
  }
  return () => {
    clock.subs.delete(fn);
    if (clock.subs.size) return;
    clearInterval(clock.timer);
    clock.timer = 0;
  };
}
export const useNow = () => useSyncExternalStore(subscribe, () => clock.now);

// ---- marks

const Asterisk = ({ size = 22, color = "#FDFBF9" }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" stroke={color} strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
    <line x1="11" y1="2" x2="11" y2="20" />
    <line x1="2" y1="11" x2="20" y2="11" />
    <line x1="4.6" y1="4.6" x2="17.4" y2="17.4" />
    <line x1="17.4" y1="4.6" x2="4.6" y2="17.4" />
  </svg>
);

// The asterisk turns once every 6s while anything works, then eases to rest (the app's one loop).
// Plain CSS keeps Motion's standalone animation engine out of the bundle.
export function Mark({ busy }) {
  const ref = useRef(null);
  const reduced = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    if (busy) {
      el.style.transition = "none";
      el.style.animation = "spin 6s linear infinite";
      return;
    }
    // freeze where it is, then ease forward to the next 45° (the asterisk looks the same every 45°)
    const m = new DOMMatrix(getComputedStyle(el).transform);
    const deg = ((Math.atan2(m.b, m.a) * 180) / Math.PI + 360) % 360;
    el.style.animation = "none";
    el.style.transform = `rotate(${deg}deg)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform 900ms cubic-bezier(0.2, 0, 0, 1)";
      el.style.transform = `rotate(${Math.ceil(deg / 45) * 45}deg)`;
    });
  }, [busy, reduced]);
  return (
    <div className="mark" aria-label={busy ? "claudia, sessions working" : "claudia"}>
      <div ref={ref} style={{ display: "flex" }}>
        <Asterisk />
      </div>
    </div>
  );
}

export function MarkerUnderline({ width = 228, replayKey }) {
  const reduced = useReducedMotion();
  return (
    <svg width={width} height="10" viewBox="0 0 228 10" fill="none" preserveAspectRatio="none" aria-hidden="true" style={{ display: "block" }}>
      <m.path
        key={replayKey}
        d="M2 6.5 C 40 2.5, 80 8.5, 120 4.8 S 196 3.2, 226 6"
        stroke="var(--color-primary)"
        strokeWidth="2.6"
        strokeLinecap="round"
        initial={reduced ? false : { pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: dur.draw, ease: "easeOut", delay: 0.12 }}
      />
    </svg>
  );
}

export const HandArrow = ({ flip = false }) => (
  <svg width="44" height="34" viewBox="0 0 44 34" fill="none" stroke="var(--color-stroke)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0, transform: flip ? "scaleX(-1)" : undefined }}>
    <path d="M40 6 C 30 4, 14 8, 9 26" />
    <path d="M4 20 L 9 27 L 15 22" />
  </svg>
);

const stickerStroke = { stroke: "var(--color-stroke)", strokeWidth: 2, strokeLinejoin: "round" };
export const Bolt = ({ size = 30, tilt = 12 }) => (
  <svg width={size} height={size * 1.13} viewBox="0 0 30 34" aria-hidden="true" style={{ transform: `rotate(${tilt}deg)`, flexShrink: 0 }}>
    <path d="M17 2 L4 19 H13 L10 32 L26 13 H16 Z" fill="#3B82F6" {...stickerStroke} />
  </svg>
);
export const Heart = ({ size = 38, tilt = 10 }) => (
  <svg width={size} height={size * 0.9} viewBox="0 0 38 34" aria-hidden="true" style={{ transform: `rotate(${tilt}deg)`, flexShrink: 0 }}>
    <path d="M19 31 C 6 22, 2 15, 2 9.5 C 2 5, 5.5 2, 10 2 C 14 2, 17 4.5, 19 8 C 21 4.5, 24 2, 28 2 C 32.5 2, 36 5, 36 9.5 C 36 15, 32 22, 19 31 Z" fill="#FF66CF" {...stickerStroke} />
  </svg>
);
export const Sparkle = ({ size = 26, tilt = -12 }) => (
  <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true" style={{ transform: `rotate(${tilt}deg)`, flexShrink: 0 }}>
    <path d="M13 2 C 14 9, 17 12, 24 13 C 17 14, 14 17, 13 24 C 12 17, 9 14, 2 13 C 9 12, 12 9, 13 2 Z" fill="#FF66CF" {...stickerStroke} />
  </svg>
);

export const Icon = {
  back: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 3 L5 8 L10 13" />
    </svg>
  ),
  plus: (
    <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <line x1="7" y1="1.5" x2="7" y2="12.5" />
      <line x1="1.5" y1="7" x2="12.5" y2="7" />
    </svg>
  ),
  activity: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <path d="M2 4 L5 7 L2 10" />
      <line x1="7" y1="10.5" x2="12" y2="10.5" />
    </svg>
  ),
  send: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="8" y1="13" x2="8" y2="3" />
      <path d="M3.5 7.5 L8 3 L12.5 7.5" />
    </svg>
  ),
  play: (
    <svg width="14" height="16" viewBox="0 0 14 16" aria-hidden="true">
      <path d="M2 1.5 L12.5 8 L2 14.5 Z" fill="currentColor" />
    </svg>
  ),
  camera: (
    <svg width="18" height="16" viewBox="0 0 18 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="3" width="16" height="11" rx="2.5" />
      <circle cx="9" cy="8.5" r="3" />
      <path d="M6 3 L7.2 1 H10.8 L12 3" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 7.5 L5.5 10.5 L11.5 3.5" />
    </svg>
  ),
};

// Mirrors Telegram's BackButton for Telegram Desktop and plain browsers.
export const BackLink = ({ onBack }) => (
  <button className="link" style={{ fontSize: 15, alignSelf: "flex-start" }} onClick={onBack}>
    {Icon.back} sessions
  </button>
);

// Numbers roll like an odometer when they change.
export function Odometer({ value }) {
  const reduced = useReducedMotion();
  return (
    <span style={{ display: "inline-flex", overflow: "hidden", verticalAlign: "bottom" }}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={value}
          initial={reduced ? false : { y: "100%" }}
          animate={{ y: 0 }}
          exit={{ y: "-100%" }}
          transition={{ duration: dur.emph, ease: ease.standard }}
          style={{ display: "inline-block" }}
        >
          {value}
        </m.span>
      </AnimatePresence>
    </span>
  );
}

// ---- actions

const press = { y: 1, backgroundColor: "var(--color-surface-2)", boxShadow: "0 0 0 rgba(0,0,0,0)" };

// Pill with the busy → done cycle from the components page. No disabled state, ever.
export function Pill({ main, icon, children, onClick, busyLabel, doneLabel, ...rest }) {
  const [phase, setPhase] = useState("idle");
  const run = async (e) => {
    if (phase !== "idle") return;
    haptic.tap();
    const result = onClick?.(e);
    if (!result?.then) return;
    setPhase("busy");
    try {
      const ok = await result;
      if (ok === false) return setPhase("idle");
      haptic.success();
      setPhase("done");
      setTimeout(() => setPhase("idle"), 1200);
    } catch {
      haptic.error();
      setPhase("idle");
    }
  };
  return (
    <m.button
      className={`pill${main ? " is-main" : ""}${phase === "done" ? " is-done" : ""}`}
      whileTap={phase === "idle" ? press : undefined}
      transition={{ duration: dur.instant }}
      onClick={run}
      {...rest}
    >
      {phase === "busy" ? (
        <>
          <Dots /> {busyLabel ?? "working"}
        </>
      ) : phase === "done" ? (
        <>
          {doneLabel ?? "done"} {Icon.check}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </m.button>
  );
}

export function Dots() {
  return (
    <span style={{ display: "inline-flex", gap: 4 }} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <m.span
          key={i}
          style={{ width: 6, height: 6, borderRadius: 3, background: "currentColor" }}
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}

export function Chip({ on, picked, deny, onClick, children }) {
  return (
    <m.button
      className={`chip${on ? " is-on" : ""}${picked ? " is-picked" : ""}${deny ? " is-deny" : ""}`}
      whileTap={press}
      transition={{ duration: dur.instant }}
      onClick={() => {
        haptic.select();
        onClick?.();
      }}
    >
      {children}
    </m.button>
  );
}

export function Toggle({ on, onChange, label }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`toggle${on ? " is-on" : ""}`}
      onClick={() => {
        haptic.select();
        onChange(!on);
      }}
    >
      <m.span layout className="knob" transition={{ duration: dur.instant * 2, ease: ease.standard }} />
    </button>
  );
}

export const Radio = ({ on }) => <span className="radio">{on && <m.span className="radio-dot" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={stamp} />}</span>;

// ---- state

export function Progress({ value, tone }) {
  return (
    <div className="track">
      <div className={`fill${tone === "over" ? " is-over" : tone === "quiet" ? " is-quiet" : ""}`} style={{ width: `${Math.round((value ?? 0) * 100)}%` }} />
    </div>
  );
}

const STATUS = { done: "done", paused: "paused", failed: "failed", needs: "needs you" };
export const StatusPill = ({ kind }) => <span className={`status ${kind}`}>{STATUS[kind]}</span>;

const STICKERS = {
  done: { bg: "var(--color-sticker-sprout)", color: "#171717", label: "done", tilt: 4 },
  paused: { bg: "var(--color-sticker-sky)", color: "#FDFBF9", label: "paused", tilt: -3 },
  failed: { bg: "var(--color-danger)", color: "#FDFBF9", label: "stuck", tilt: -4 },
  needs: { bg: "var(--color-primary)", color: "#171717", label: "needs you", tilt: 3 },
};

// Stamped on arrival: lands from 1.4× and −12°, settles at its tilt (04 Motion → done stamp).
export function StatusSticker({ kind }) {
  const s = STICKERS[kind];
  const reduced = useReducedMotion();
  if (!s) return null;
  return (
    <m.div
      key={kind}
      initial={reduced ? { opacity: 0 } : { scale: 1.4, rotate: -12, opacity: 0 }}
      animate={{ scale: 1, rotate: s.tilt, opacity: 1 }}
      transition={reduced ? { duration: 0.12 } : stamp}
      onAnimationStart={() => (kind === "done" ? haptic.success() : kind === "needs" ? haptic.warning() : kind === "failed" ? haptic.error() : haptic.tap())}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 14px",
        borderRadius: "var(--radius-pill)",
        border: "2px solid var(--color-stroke)",
        background: s.bg,
        color: s.color,
        fontFamily: "var(--font-display)",
        fontSize: 15,
        fontWeight: 600,
      }}
    >
      {kind === "done" && Icon.check}
      {s.label}
    </m.div>
  );
}

export const Skeleton = ({ width = "100%", height = 14 }) => <div className="skeleton" style={{ width, height }} />;

// ---- toast: the one dark element (bottom, 3s)

const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null);
  const timer = useRef();
  const show = useCallback((text, tone = "ok") => {
    clearTimeout(timer.current);
    setToast({ text, tone, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), 3000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <AnimatePresence>
        {toast && (
          <m.div
            key={toast.id}
            className="toast"
            role="status"
            initial={{ opacity: 0, y: 12, x: "-50%" }}
            animate={{ opacity: 1, y: 0, x: "-50%" }}
            exit={{ opacity: 0, y: 8, x: "-50%", transition: { duration: dur.fast, ease: ease.exit } }}
            transition={slide}
          >
            <span style={{ color: toast.tone === "ok" ? "#22C55E" : "#FF7B6E", display: "flex" }}>{toast.tone === "ok" ? Icon.check : "!"}</span>
            {toast.text}
          </m.div>
        )}
      </AnimatePresence>
    </ToastContext.Provider>
  );
}
