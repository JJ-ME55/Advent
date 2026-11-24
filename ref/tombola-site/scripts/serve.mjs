// Tiny static server for dist/, for local testing only. Also mocks the bot's POST /mock/swarm-check.
// Usage: node scripts/serve.mjs [port]
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, normalize } from "node:path";

const dist = fileURLToPath(new URL("../dist", import.meta.url));
const port = Number(process.argv[2] ?? 5180);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".txt": "text/plain" };
const COOLDOWN = 6 * 3600;

createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "POST" && url.pathname === "/mock/swarm-check") {
    const p = join(dist, "mock", "snapshot.json");
    const snap = JSON.parse(readFileSync(p, "utf8"));
    const now = Math.floor(Date.now() / 1000);
    const sc = snap.swarmCheck;
    if (now < sc.nextAllowedAt) {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "cooldown", nextAllowedAt: sc.nextAllowedAt }));
    }
    snap.swarmCheck = { ...sc, lastAt: now, nextAllowedAt: now + COOLDOWN, status: "pending", answer: null, attestationUrl: null };
    writeFileSync(p, JSON.stringify(snap, null, 2));
    res.writeHead(202, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, swarmCheck: snap.swarmCheck }));
  }
  let path = normalize(join(dist, decodeURIComponent(url.pathname)));
  if (!path.startsWith(dist)) return res.writeHead(403).end();
  if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "index.html");
  if (!existsSync(path)) return res.writeHead(404).end("not found");
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(path));
}).listen(port, "127.0.0.1", () => console.log(`Tombola site on http://127.0.0.1:${port}`));
