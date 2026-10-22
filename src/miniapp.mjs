// The Telegram Mini App's server: static files plus a small JSON API with a live stream.
// It listens on its own port, separate from the hook port, and that is the only port the tunnel
// exposes. Every API call must carry Telegram's signed initData for the paired user.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { ROOT } from "./config.mjs";

const DIST = join(ROOT, "app", "dist");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".ico": "image/x-icon",
};
const MAX_AGE_S = 24 * 3600;

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function verifyInitData(initData, botToken, now = Date.now()) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const sign = (p) => createHmac("sha256", secret).update([...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n")).digest("hex");
  const matches = (calc) => calc.length === hash.length && timingSafeEqual(Buffer.from(calc), Buffer.from(hash));
  let ok = matches(sign(params));
  if (!ok && params.has("signature")) {
    // some clients sign without the newer third-party "signature" field
    const without = new URLSearchParams(params);
    without.delete("signature");
    ok = matches(sign(without));
  }
  if (!ok) return null;
  const authDate = Number(params.get("auth_date"));
  if (!authDate || now / 1000 - authDate > MAX_AGE_S) return null;
  try {
    return JSON.parse(params.get("user"));
  } catch {
    return null;
  }
}

export function createAppServer({ config, api, log = () => {} }) {
  const streams = new Set();
  let pending = null;

  function broadcast() {
    if (!streams.size || pending) return;
    pending = setTimeout(async () => {
      pending = null;
      let body;
      try {
        body = `event: state\ndata: ${JSON.stringify(await api.state())}\n\n`;
      } catch (err) {
        return log("app state:", err);
      }
      for (const res of streams) res.write(body);
    }, 400);
  }

  const heartbeat = setInterval(() => {
    for (const res of streams) res.write(": ping\n\n");
  }, 25_000);
  heartbeat.unref();

  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body ?? {}));
  };

  function serveStatic(req, res) {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(DIST, path));
    if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 404, { error: "not found" });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // single-page app
    if (!existsSync(file)) return send(res, 503, { error: "the app isn't built yet: npm run build:app" });
    const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2)$/.test(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    res.end(readFileSync(file));
  }

  async function readBody(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 64_000) throw new Error("too big");
    }
    return body ? JSON.parse(body) : {};
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

    const auth = String(req.headers.authorization ?? "");
    const user = auth.startsWith("tma ") ? verifyInitData(auth.slice(4), config.telegramToken) : null;
    if (!user || user.id !== config.chatId) return send(res, 401, { error: "open this from your claudia chat in telegram" });

    try {
      if (req.method === "GET" && url.pathname === "/api/state") return send(res, 200, await api.state());
      if (req.method === "GET" && url.pathname === "/api/session") return send(res, 200, await api.session(url.searchParams.get("id")));
      if (req.method === "GET" && url.pathname === "/api/processes") return send(res, 200, await api.processes());
      if (req.method === "GET" && url.pathname === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.write(`event: state\ndata: ${JSON.stringify(await api.state())}\n\n`);
        streams.add(res);
        api.watching(streams.size);
        req.on("close", () => {
          streams.delete(res);
          api.watching(streams.size);
        });
        return;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const route = url.pathname.slice("/api/".length);
        if (typeof api.actions[route] !== "function") return send(res, 404, { error: "not found" });
        const result = await api.actions[route](body);
        broadcast();
        return send(res, result?.error ? 400 : 200, result ?? { ok: true });
      }
      send(res, 404, { error: "not found" });
    } catch (err) {
      log("app api:", err);
      send(res, 500, { error: "something broke on the laptop" });
    }
  });

  return {
    broadcast,
    watchers: () => streams.size,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
  };
}
