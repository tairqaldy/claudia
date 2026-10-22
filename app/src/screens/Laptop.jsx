// 06 Screens → 4 · Laptop
import { AnimatePresence, m } from "motion/react";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { confirmIdentity, haptic } from "../tg.js";
import { BackLink, Heart, Icon, Pill, Skeleton, Toggle, dur, ease, slide, useToast } from "../ui.jsx";
import { timeOfDay } from "../util.js";

export function Laptop({ data, back }) {
  const toast = useToast();
  const { battery, cpu, mem, awakeUntil } = data.laptop;
  const [procs, setProcs] = useState(null);

  const load = () =>
    api
      .processes()
      .then((r) => setProcs(r.processes))
      .catch(() => setProcs([]));
  useEffect(() => {
    load();
  }, []);

  const caption = !battery
    ? "no battery, always plugged in"
    : battery.onBattery
      ? battery.percent <= 20
        ? `${battery.percent}% left, plug it in`
        : "on battery, all good for now"
      : battery.charging && battery.percent < 100
        ? "charging"
        : "plugged in, all good";

  const stop = async (p) => {
    if (!(await confirmIdentity(`stop ${p.command} on your laptop`))) return;
    try {
      await api.act("laptop", { action: "kill", pid: p.pid });
      haptic.error(); // stopping a process gets the error haptic (04 Motion → haptics)
      setProcs((list) => list.filter((x) => x.pid !== p.pid));
      toast(`stopped ${p.pid}`);
    } catch (err) {
      toast(err.message, "error");
    }
  };

  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", paddingTop: 8 }}>
        <BackLink onBack={back} />
        <div className="meta" style={{ fontSize: 14, paddingTop: 6 }}>
          your laptop
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
          <div className="mono" style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-7xl)", lineHeight: "112px", fontWeight: 600, color: "var(--color-heading)" }}>
            {battery ? `${battery.percent}%` : "—"}
          </div>
          <div style={{ paddingBottom: 30 }}>
            <Heart />
          </div>
        </div>
        <div className="caption" style={{ transform: "rotate(-2deg)", color: battery?.onBattery && battery.percent <= 20 ? "var(--color-danger)" : undefined }}>
          {caption}
        </div>
      </div>

      <m.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={slide} style={{ display: "flex", gap: 12, paddingTop: 24 }}>
        <Gauge label="cpu" value={cpu} />
        <Gauge label="memory" value={mem?.usedPct} />
      </m.div>

      <div style={{ paddingTop: 20 }}>
        <label className="row" style={{ flexDirection: "row", alignItems: "center", gap: 12, borderBottom: 0 }}>
          <span style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
            <span style={{ fontSize: 16, fontWeight: 500 }}>keep awake</span>
            <span className="meta">{awakeUntil ? `on until ${timeOfDay(awakeUntil)}` : "off, the laptop sleeps as usual"}</span>
          </span>
          <Toggle
            on={Boolean(awakeUntil)}
            label="keep awake"
            onChange={(on) =>
              api
                .act("laptop", { action: on ? "awake" : "sleep" })
                .then(() => toast(on ? "staying awake for 2h" : "it can sleep again"))
                .catch((err) => toast(err.message, "error"))
            }
          />
        </label>

        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "22px 0 2px" }}>
          <div className="section">leftover dev servers</div>
          <div className="meta">{procs ? `${procs.length} node` : ""}</div>
        </div>
        {!procs && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "14px 0" }}>
            <Skeleton width="40%" />
            <Skeleton width="70%" height={10} />
          </div>
        )}
        <AnimatePresence initial={false}>
          {procs?.map((p) => (
            <m.div
              key={p.pid}
              layout
              className="row"
              style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
              exit={{ opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, transition: { duration: dur.emph * 0.7, ease: ease.exit } }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="mono" style={{ fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p.command}
                </span>
                <span className="meta">
                  pid {p.pid} · {p.mb} MB
                </span>
              </span>
              <m.button className="chip" style={{ fontSize: 14, minHeight: 32, padding: "4px 16px" }} whileTap={{ y: 1 }} onClick={() => stop(p)}>
                stop
              </m.button>
            </m.div>
          ))}
        </AnimatePresence>
        {procs && !procs.length && <div className="meta" style={{ padding: "14px 0" }}>no leftover node processes. nice and tidy.</div>}
      </div>

      <div style={{ marginTop: "auto", paddingTop: 22, display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <Pill main icon={Icon.camera} busyLabel="taking it" doneLabel="sent" onClick={() => api.act("laptop", { action: "shot" }).then((r) => toast(r.message ?? "sent to your chat"))}>
          show me the screen
        </Pill>
        <div className="meta">sent only to you, never saved</div>
      </div>
    </div>
  );
}

function Gauge({ label, value }) {
  const busy = value > 85;
  return (
    <div className="gauge">
      <div className="meta">{busy ? `${label} · busy` : label}</div>
      <div className="gauge-value">{value == null ? "—" : `${value}%`}</div>
      <div className="track">
        <div className={`fill${busy ? " is-over" : ""}`} style={{ width: `${value ?? 0}%`, transitionDuration: "200ms" }} />
      </div>
    </div>
  );
}
