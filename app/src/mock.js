// Sample data matching the Paper screens, for design review in a plain browser (?mock).
const MIN = 60_000;
const now = Date.now();
let listener = () => {};

const state = {
  now,
  name: "Tair",
  away: true,
  muted: false,
  sessions: [
    { id: "q", title: "checkout tests", project: "qn5", cwd: "C:/code/qn5", status: "waiting", turnStart: now - 9 * MIN, usualMs: 15 * MIN, lastActivity: now - 2 * MIN, waitingFor: "postgres or sqlite?", waitingSince: now - 2 * MIN, background: [], prompt: "the checkout tests are flaky on CI, figure out why and fix them", lastDone: null },
    { id: "f", title: "Кейс 11: проверка мест v2", project: "finow", cwd: "C:/code/finow", status: "working", turnStart: now - 6 * MIN - 12_000, usualMs: 8 * MIN, lastActivity: now - 20_000, background: [], prompt: "проверь места моделью v2", lastDone: null },
    { id: "h", title: "Help page test investigation", project: "qaldy design system", cwd: "C:/code/qaldy", status: "working", turnStart: now - 22 * MIN - 40_000, usualMs: 15 * MIN, lastActivity: now - 40_000, background: [], prompt: "investigate the help page tests", lastDone: null },
    { id: "e", title: "evals run", project: "finow", cwd: "C:/code/finow", status: "background", background: ["eval run", "report"], prompt: "run the evals", lastDone: { at: now - 4 * MIN, took: 11 * MIN, summary: "Started the evals in the background." } },
    { id: "c", title: "quiet hours", project: "claudia", cwd: "C:/code/claudia", status: "idle", background: [], prompt: "add quiet hours", lastDone: { at: now - 3 * MIN, took: 14 * MIN, summary: "Quiet hours work." } },
  ],
  holds: [
    {
      id: "h1",
      kind: "ask",
      sessionId: "q",
      since: now - 2 * MIN,
      answers: {},
      questions: [{ question: "postgres or sqlite for the local dev database?", multiSelect: false, options: [{ label: "postgres", description: "" }, { label: "sqlite", description: "" }] }],
      text: "",
    },
  ],
  doneToday: { count: 3, totalMs: 72 * MIN },
  laptop: { battery: { percent: 86, charging: false, onBattery: false }, cpu: 31, mem: { usedPct: 47, totalGb: 47.7 }, awakeUntil: now + 95 * MIN },
  projects: [
    { cwd: "C:/code/qn5", name: "qn5", lastSeen: now - 2 * MIN },
    { cwd: "C:/code/finow", name: "finow", lastSeen: now },
    { cwd: "C:/code/sathustle", name: "sathustle", lastSeen: now - 20 * 60 * MIN },
  ],
  recipes: [
    { key: "ship", label: "Ship it" },
    { key: "test", label: "Test it" },
    { key: "review", label: "Review" },
    { key: "deploy", label: "Deploy" },
    { key: "polish", label: "Polish UI" },
    { key: "optimize", label: "Optimize" },
    { key: "docs", label: "Sync docs" },
    { key: "summary", label: "Save summary" },
    { key: "continue", label: "Continue" },
  ],
};

const emit = () => listener({ ...state, now: Date.now() });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export const mockApi = {
  stream(onState, onStatus) {
    listener = onState;
    setTimeout(() => {
      onStatus("live");
      emit();
    }, 350);
    return { stop() {}, retry() {} };
  },
  async session(id) {
    await wait(200);
    const s = state.sessions.find((x) => x.id === id) ?? state.sessions[0];
    return {
      ...s,
      hold: id === "c" ? "stop1" : null,
      timeline: [
        { type: "you", text: s.prompt },
        { type: "activity", text: "ran 20 commands · edited 3 files" },
        { type: "claude", text: "Workers shared one Stripe mock and clobbered each other. Each worker gets its own now. All 42 tests pass, 20 runs in a row. Nothing's committed yet. Want me to commit and open a PR?" },
      ],
    };
  },
  async processes() {
    await wait(300);
    return {
      processes: [
        { pid: 4412, mb: 412, command: "vite dev  (qaldy-site)" },
        { pid: 5120, mb: 288, command: "vitest --watch  (qn5)" },
      ],
    };
  },
  async act(route, body) {
    await wait(450);
    if (route === "away") state.away = Boolean(body.on);
    if (route === "hold" && body.action === "answer") {
      state.holds = state.holds.filter((h) => h.id !== body.id);
      const s = state.sessions.find((x) => x.id === "q");
      if (s) s.status = "working";
    }
    if (route === "laptop" && body.action === "awake") state.laptop.awakeUntil = Date.now() + 120 * MIN;
    if (route === "laptop" && body.action === "sleep") state.laptop.awakeUntil = 0;
    emit();
    return { ok: true, message: route === "laptop" && body.action === "shot" ? "sent to your chat" : "sent" };
  },
};
