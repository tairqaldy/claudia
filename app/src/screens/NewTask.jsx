// 06 Screens → 3 · New task
import { m } from "motion/react";
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { confirmIdentity, guardTyping, haptic } from "../tg.js";
import { BackLink, Chip, Icon, Pill, Radio, Sparkle, Toggle, slide, useToast } from "../ui.jsx";
import { fmtAgo } from "../util.js";

export function NewTask({ data, back }) {
  const toast = useToast();
  const [cwd, setCwd] = useState(data.projects[0]?.cwd ?? null);
  const [recipe, setRecipe] = useState(null);
  const [text, setText] = useState("");
  const [careful, setCareful] = useState(true);
  const project = data.projects.find((p) => p.cwd === cwd);
  const recipes = data.recipes.filter((r) => r.key !== "continue" && r.key !== "summary").slice(0, 6);

  useEffect(() => {
    guardTyping(Boolean(text.trim()));
  }, [text]);
  useEffect(() => () => guardTyping(false), []);

  const run = async () => {
    if (!project) return toast("pick a project first", "error"), false;
    if (!text.trim()) return toast("describe the task first", "error"), false;
    if (!(await confirmIdentity(`run this in ${project.name} on your laptop`))) return false;
    await api.act("task", { cwd, prompt: text, careful });
    guardTyping(false);
    setTimeout(() => {
      toast(`started in ${project.name}. you'll get the usual pings`);
      back();
    }, 1200);
  };

  return (
    <div className="screen">
      <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingTop: 8 }}>
        <BackLink onBack={back} />
        <h1 className="title">start something</h1>
        <div className="meta" style={{ fontSize: 14 }}>
          it runs on your laptop, you get the usual pings
        </div>
      </div>

      <m.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={slide} style={{ paddingTop: 26 }}>
        <div className="section" style={{ paddingBottom: 8 }}>
          where
        </div>
        <div role="radiogroup" aria-label="project">
          {data.projects.slice(0, 6).map((p) => (
            <button
              key={p.cwd}
              role="radio"
              aria-checked={p.cwd === cwd}
              className="row"
              style={{ flexDirection: "row", alignItems: "center", gap: 12, padding: "12px 0" }}
              onClick={() => {
                haptic.select();
                setCwd(p.cwd);
              }}
            >
              <Radio on={p.cwd === cwd} />
              <span style={{ flex: 1, fontSize: 16, fontWeight: p.cwd === cwd ? 500 : 400 }}>{p.name}</span>
              <span className="meta" style={{ width: 80, textAlign: "right" }}>
                {fmtAgo(Date.now() - p.lastSeen)}
              </span>
            </button>
          ))}
          {!data.projects.length && <div className="meta">open a project in claude code once and it shows up here.</div>}
        </div>
      </m.section>

      <m.section initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ ...slide, delay: 0.04 }} style={{ paddingTop: 24, display: "flex", flexDirection: "column", gap: 12 }}>
        <div className="section">
          what <Sparkle />
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {recipes.map((r) => (
            <Chip
              key={r.key}
              on={recipe === r.key}
              onClick={() => {
                setRecipe(r.key);
                setText(r.prompt ?? r.label);
              }}
            >
              {r.label.toLowerCase()}
            </Chip>
          ))}
        </div>
        <textarea className="field" rows={4} value={text} placeholder="describe the task, like you'd type it on the laptop" onChange={(e) => setText(e.target.value)} />
      </m.section>

      <div style={{ marginTop: "auto", paddingTop: 24, display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
        <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", fontSize: 14, minHeight: 44 }}>
          ask me before risky commands
          <Toggle on={careful} onChange={setCareful} label="ask me before risky commands" />
        </label>
        <Pill main icon={Icon.play} onClick={run} busyLabel="starting" doneLabel="started">
          {project ? `run in ${project.name}` : "pick a project"}
        </Pill>
        <div className="meta">confirms with face id first</div>
      </div>
    </div>
  );
}
