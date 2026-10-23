// The Telegram Mini App's server: static files plus a small JSON API kept live by long polling.
// It listens on its own port, separate from the hook port, and that is the only port the tunnel
// exposes. Every API call must carry Telegram's signed initData for the paired user.
// Long polling rather than server-sent events: Cloudflare quick tunnels hold SSE bodies back, while
// a request that answers once something changes passes through any tunnel or proxy.
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
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
const HOLD_MS = 25_000; // well under the tunnel's own response timeout
const VIEWER_GONE_MS = 45_000;

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
  let version = 1; // bumps on every change; the app sends the one it has and waits for a newer one
  const waiting = new Set(); // held /api/state requests
  let pending = null;
  let viewerTimer = null;

  const current = async () => ({ ...(await api.state()), version });

  function broadcast() {
    version++;
    if (!waiting.size || pending) return;
    pending = setTimeout(async () => {
      pending = null;
      let body;
      try {
        body = await current();
      } catch (err) {
        return log("app state:", err);
      }
      for (const w of waiting) {
        clearTimeout(w.timer);
        send(w.res, 200, body);
      }
      waiting.clear();
    }, 400);
  }

  // someone has the app open while it keeps asking; the daemon refreshes laptop stats meanwhile
  function viewer() {
    api.watching?.(1);
    clearTimeout(viewerTimer);
    viewerTimer = setTimeout(() => api.watching?.(0), VIEWER_GONE_MS);
    viewerTimer.unref?.();
  }

  const send = (res, code, body) => {
    const json = Buffer.from(JSON.stringify(body ?? {}));
    const gz = json.length > 1400 && /\bgzip\b/.test(String(res.req?.headers["accept-encoding"] ?? ""));
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", vary: "accept-encoding", ...(gz ? { "content-encoding": "gzip" } : {}) });
    res.end(gz ? gzipSync(json) : json);
  };

  // Files are compressed once (brotli and gzip) and kept in memory; the tunnel is the slow part.
  const packed = new Map();
  function pack(file) {
    const mtime = statSync(file).mtimeMs;
    const hit = packed.get(file);
    if (hit?.mtime === mtime) return hit;
    const raw = readFileSync(file);
    const text = /\.(html|js|css|svg|json)$/.test(file);
    const entry = {
      mtime,
      raw,
      br: text ? brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 10 } }) : null,
      gz: text ? gzipSync(raw, { level: 9 }) : null,
    };
    packed.set(file, entry);
    return entry;
  }

  function serveStatic(req, res) {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let file = normalize(join(DIST, path));
    if (!file.startsWith(DIST + sep) && file !== DIST) return send(res, 404, { error: "not found" });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html"); // single-page app
    if (!existsSync(file)) return send(res, 503, { error: "the app isn't built yet: npm run build:app" });
    const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2)$/.test(file);
    const { raw, br, gz } = pack(file);
    const accepts = String(req.headers["accept-encoding"] ?? "");
    const [body, encoding] = br && /\bbr\b/.test(accepts) ? [br, "br"] : gz && /\bgzip\b/.test(accepts) ? [gz, "gzip"] : [raw, null];
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
      vary: "accept-encoding",
      ...(encoding ? { "content-encoding": encoding } : {}),
    });
    res.end(body);
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
    if (url.pathname === "/healthz") {
      // the tunnel watchdog checks this through the public address
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      return res.end("ok");
    }
    if (!url.pathname.startsWith("/api/")) return serveStatic(req, res);

    const auth = String(req.headers.authorization ?? "");
    const user = auth.startsWith("tma ") ? verifyInitData(auth.slice(4), config.telegramToken) : null;
    if (!user || user.id !== config.chatId) return send(res, 401, { error: "open this from your claudia chat in telegram" });

    try {
      if (req.method === "GET" && url.pathname === "/api/state") {
        viewer();
        const since = Number(url.searchParams.get("since"));
        if (since !== version) return send(res, 200, await current());
        // nothing new yet: answer when something changes, or after HOLD_MS with the same state
        const w = { res };
        w.timer = setTimeout(async () => {
          waiting.delete(w);
          send(res, 200, await current().catch(() => ({ version })));
        }, HOLD_MS);
        waiting.add(w);
        req.on("close", () => {
          clearTimeout(w.timer);
          waiting.delete(w);
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/session") return send(res, 200, await api.session(url.searchParams.get("id")));
      if (req.method === "GET" && url.pathname === "/api/processes") return send(res, 200, await api.processes());
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
    watchers: () => waiting.size,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      }),
    close() {
      for (const w of waiting) clearTimeout(w.timer);
      clearTimeout(viewerTimer);
      server.closeAllConnections();
      server.close();
    },
  };
}
