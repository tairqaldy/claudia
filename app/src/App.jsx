import { AnimatePresence, LayoutGroup, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { Home } from "./screens/Home.jsx";
import { Laptop } from "./screens/Laptop.jsx";
import { NewTask } from "./screens/NewTask.jsx";
import { Session } from "./screens/Session.jsx";
import { backButton, haptic } from "./tg.js";
import { Mark, Skeleton, ToastProvider, dur, ease, useNow } from "./ui.jsx";

export function App() {
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [stack, setStack] = useState([{ name: "home" }]);
  const stream = useRef(null);
  const needsBefore = useRef(0);

  useEffect(() => {
    stream.current = api.stream(
      (next) => {
        // something new needs you: feel it (04 Motion → haptics)
        const needs = next.holds.filter((h) => h.kind !== "stop").length;
        if (needs > needsBefore.current) haptic.warning();
        needsBefore.current = needs;
        setData(next);
      },
      setStatus,
    );
    return () => stream.current?.stop();
  }, []);

  const screen = stack.at(-1);
  useEffect(() => window.scrollTo(0, 0), [stack.length]); // every screen opens at its top
  const go = useCallback((name, params = {}) => setStack((s) => [...s, { name, ...params }]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  useEffect(() => (stack.length > 1 ? backButton(back) : undefined), [stack.length, back]);

  // timers tick only while something is running
  const ticking = Boolean(data?.sessions.some((s) => s.status === "working" || s.status === "waiting") || data?.holds.length);
  const now = useNow(ticking);

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <div className="app">
            {status === "unauthorized" ? (
              <Notice title="open me from telegram" text="this page only works inside your claudia chat. tap the menu button there." />
            ) : !data ? (
              <Loading offline={status === "offline"} />
            ) : (
              <LayoutGroup>
                <AnimatePresence mode="popLayout" initial={false}>
                  <m.div
                    key={screen.name + (screen.id ?? "")}
                    style={{ display: "flex", flexDirection: "column", flex: 1 }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1, transition: { duration: dur.emph, ease: ease.enter } }}
                    exit={{ opacity: 0, transition: { duration: 0.12, ease: ease.exit } }}
                  >
                    {screen.name === "home" && <Home data={data} now={now} open={(id) => go("session", { id })} go={go} offline={status === "offline"} retry={() => stream.current?.retry()} />}
                    {screen.name === "session" && <Session id={screen.id} data={data} now={now} back={back} />}
                    {screen.name === "new" && <NewTask data={data} now={now} back={back} />}
                    {screen.name === "laptop" && <Laptop data={data} back={back} />}
                  </m.div>
                </AnimatePresence>
              </LayoutGroup>
            )}
          </div>
        </ToastProvider>
      </MotionConfig>
    </LazyMotion>
  );
}

function Loading({ offline }) {
  return (
    <div className="screen" style={{ paddingTop: 14, gap: 18 }}>
      <Mark busy />
      <Skeleton width="70%" height={44} />
      <Skeleton width="45%" height={44} />
      {offline ? (
        <div className="meta">can't reach the laptop yet. it might be asleep. retrying every 10s.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 20 }}>
          <Skeleton width="60%" />
          <Skeleton width="35%" height={10} />
          <Skeleton height={6} />
        </div>
      )}
    </div>
  );
}

function Notice({ title, text }) {
  return (
    <div className="screen" style={{ paddingTop: 40, gap: 14 }}>
      <Mark />
      <h1 className="title">{title}</h1>
      <div className="meta" style={{ fontSize: 15 }}>
        {text}
      </div>
    </div>
  );
}
