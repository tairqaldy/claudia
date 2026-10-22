// Talks to the daemon on the laptop. Live state arrives over one server-sent-events stream.
import { initData, inTelegram } from "./tg.js";
import { mockApi } from "./mock.js";

export const mock = !inTelegram && (location.search.includes("mock") || location.hostname === "localhost");
const headers = { authorization: `tma ${initData}`, "content-type": "application/json" };

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `HTTP ${res.status}`), { status: res.status });
  return body;
}

const real = {
  session: (id) => request(`/api/session?id=${encodeURIComponent(id)}`),
  processes: () => request("/api/processes"),
  act: (route, body) => request(`/api/${route}`, { method: "POST", body: JSON.stringify(body) }),

  // fetch-based SSE so the auth header travels in a header, never in a URL
  stream(onState, onStatus) {
    let stopped = false;
    let controller;
    const connect = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const res = await fetch("/api/stream", { headers, signal: controller.signal });
          if (res.status === 401) return onStatus("unauthorized");
          if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
          onStatus("live");
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let i;
            while ((i = buf.indexOf("\n\n")) >= 0) {
              const event = buf.slice(0, i);
              buf = buf.slice(i + 2);
              const data = event.split("\n").find((l) => l.startsWith("data: "));
              if (data) onState(JSON.parse(data.slice(6)));
            }
          }
        } catch {
          if (stopped) return;
        }
        onStatus("offline");
        await new Promise((r) => setTimeout(r, 10_000)); // retries every 10s, like the design says
      }
    };
    connect();
    return {
      stop: () => {
        stopped = true;
        controller?.abort();
      },
      retry: () => controller?.abort(),
    };
  },
};

export const api = mock ? mockApi : real;
