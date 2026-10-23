// Talks to the daemon on the laptop over plain requests (see live() below).
import { initData, inTelegram } from "./tg.js";
import { mockApi } from "./mock.js";

export const mock = !inTelegram && (location.search.includes("mock") || location.hostname === "localhost");
const headers = { authorization: `tma ${initData}`, "content-type": "application/json" };

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

// The last state seen, so reopening the app paints instantly (marked as stale until fresh data lands).
const CACHE = "claudia:state";
export function cachedState() {
  try {
    return JSON.parse(localStorage.getItem(CACHE));
  } catch {
    return null;
  }
}
function remember(state) {
  try {
    localStorage.setItem(CACHE, JSON.stringify(state));
  } catch {}
}

const real = {
  session: (id) => request(`/api/session?id=${encodeURIComponent(id)}`),
  processes: () => request("/api/processes"),
  act: (route, body) => request(`/api/${route}`, { method: "POST", body: JSON.stringify(body) }),

  // Long polling: the first request answers at once, every later one waits on the laptop until
  // something changes (or ~25s pass), so updates land within half a second through any tunnel.
  live(onState, onStatus) {
    let stopped = false;
    let version = 0;
    let controller;
    let kicked = false; // the request was cut short on purpose, to ask again right away
    let backingOff = false;
    let wake = () => {};

    const loop = async () => {
      let delay = 2_000;
      while (!stopped) {
        controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 40_000);
        try {
          const state = await request(`/api/state${version ? `?since=${version}` : ""}`, { signal: controller.signal });
          version = state.version ?? 0;
          kicked = false;
          remember(state);
          onState(state);
          onStatus("live");
          delay = 2_000;
          continue;
        } catch (err) {
          if (stopped) return;
          if (err.status === 401) return onStatus("unauthorized");
          if (kicked) {
            kicked = false;
            continue;
          }
          if (err.name !== "AbortError") onStatus("offline");
        } finally {
          clearTimeout(timer);
        }
        // back off, unless retry() or coming back to the app asks for a fresh look now
        backingOff = true;
        await new Promise((r) => {
          wake = r;
          setTimeout(r, delay);
        });
        backingOff = false;
        delay = Math.min(delay * 2, 10_000);
      }
    };
    loop();

    const now = () => {
      version = 0;
      if (backingOff) return wake();
      kicked = true;
      controller?.abort();
    };
    const onVisible = () => !document.hidden && now();
    document.addEventListener("visibilitychange", onVisible);

    return {
      stop: () => {
        stopped = true;
        document.removeEventListener("visibilitychange", onVisible);
        controller?.abort();
        wake();
      },
      retry: now,
    };
  },
};

export const api = mock ? mockApi : real;
