import { AnimatePresence, LayoutGroup, LazyMotion, MotionConfig, domMax, m } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, cachedState, mock } from "./api.js";
import { Home } from "./screens/Home.jsx";
import { Laptop } from "./screens/Laptop.jsx";
import { NewTask } from "./screens/NewTask.jsx";
import { Session } from "./screens/Session.jsx";
import { backButton, haptic } from "./tg.js";
import { Mark, Skeleton, ToastProvider, dur, ease } from "./ui.jsx";

const needing = (state) => state?.holds.filter((h) => h.kind !== "stop").length ?? 0;

export function App() {
  // paint the last state we saw right away; it's replaced as soon as the laptop answers
  const [data, setData] = useState(() => (mock ? null : cachedState()));
  const [fresh, setFresh] = useState(false);
  const [status, setStatus] = useState("connecting");
  const [stack, setStack] = useState([{ name: "home" }]);
  const live = useRef(null);
  const needsBefore = useRef(needing(data));

  useEffect(() => {
    live.current = api.live((next) => {
      // something new needs you: feel it (04 Motion → haptics)
      const needs = needing(next);
      if (needs > needsBefore.current) haptic.warning();
      needsBefore.current = needs;
      setData(next);
      setFresh(true);
    }, setStatus);
    return () => live.current?.stop();
  }, []);

  const screen = stack.at(-1);
  // every screen opens at its top (braces: newer Chromium returns a promise from scrollTo, and
  // React would take that for a cleanup function)
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stack.length]);
  const go = useCallback((name, params = {}) => setStack((s) => [...s, { name, ...params }]), []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  useEffect(() => (stack.length > 1 ? backButton(back) : undefined), [stack.length, back]);

  const offline = status === "offline";
  const staleAt = fresh && !offline ? null : data?.now;

  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">
        <ToastProvider>
          <div className="app">
            {status === "unauthorized" ? (
              <Notice title="open me from telegram" text="this page only works inside your claudia chat. tap the menu button there." />
            ) : !data ? (
              <Loading offline={offline} />
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
                    {screen.name === "home" && <Home data={data} open={(id) => go("session", { id })} go={go} offline={offline} staleAt={staleAt} retry={() => live.current?.retry()} />}
                    {screen.name === "session" && <Session id={screen.id} data={data} back={back} />}
                    {screen.name === "new" && <NewTask data={data} back={back} />}
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
        <div className="meta">can't reach the laptop yet. it might be asleep. still trying.</div>
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
