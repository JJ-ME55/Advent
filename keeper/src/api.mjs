// The site's API: reads what the keeper publishes (DRAWS_DIR/snapshot.json, door-<d>.json, deltas.json) and
// answers wallet-signed requests. No database; everything is a file the keeper writes. The village game's
// endpoints are stubs until the game exists.
//   PORT=8787 DRAWS_DIR=draws node src/api.mjs
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { replay, buildList, weightFor, MIN_BALANCE, ELIGIBLE_AFTER } from "./drum.mjs";
import { doorTime, snapshotTime, nextDoor, LAST_DOOR } from "./doors.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const DRAWS_DIR = process.env.DRAWS_DIR ?? "draws";
const ENTRANTS_FILE = process.env.BONUS_ENTRANTS_FILE ?? "state/bonus-entrants.json";
const ORIGIN = process.env.SITE_ORIGIN ?? "*";
const now = () => Math.floor(Date.now() / 1000);

const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };
const snapshot = () => readJson(join(DRAWS_DIR, "snapshot.json"), {});
const door = (d) => readJson(join(DRAWS_DIR, `door-${d}.json`));
let deltaCache = { at: 0, deltas: [] };
function deltas() {
  if (now() - deltaCache.at > 20) { const raw = readJson(join(DRAWS_DIR, "deltas.json"), []); deltaCache = { at: now(), deltas: raw.map((x) => ({ ...x, delta: BigInt(x.delta) })) }; }
  return deltaCache.deltas;
}

// nonces for wallet-signed requests: GET /nonce/:wallet → sign "ADVENT <action> <wallet> <nonce>"
const nonces = new Map();
function verifySigned(body, action) {
  const { wallet, nonce, signature } = body ?? {};
  if (!wallet || !nonce || !signature) return { error: "wallet, nonce and signature are required" };
  const issued = nonces.get(wallet);
  if (!issued || issued.nonce !== nonce || now() - issued.at > 300) return { error: "unknown or expired nonce" };
  const msg = Buffer.from(`ADVENT ${action} ${wallet} ${nonce}`, "utf8");
  let good = false;
  try { good = nacl.sign.detached.verify(msg, bs58.decode(signature), bs58.decode(wallet)); } catch { good = false; }
  if (!good) return { error: "bad signature" };
  nonces.delete(wallet);
  return { wallet };
}

function eligibility(wallet, at = now()) {
  const st = replay(deltas(), at, { exclude: new Set(snapshot().exclude ?? []) });
  const s = st.get(wallet);
  if (!s) return { wallet, holder: false, inDrum: false, balance: "0", tickets: "0", reason: "no balance" };
  const t = BigInt(at);
  const w = weightFor(s.balance, s.holdStart, t);
  const { totalWeight } = buildList(st, at);
  const held = Number(t - s.holdStart);
  let reason = null;
  if (s.balance < MIN_BALANCE) reason = `holds ${s.balance} of the ${MIN_BALANCE} minimum`;
  else if (held < Number(ELIGIBLE_AFTER)) reason = `held ${held} s of the ${ELIGIBLE_AFTER} s minimum`;
  return { wallet, holder: true, inDrum: w > 0n, balance: s.balance.toString(), holdStart: Number(s.holdStart), heldSeconds: held, tickets: w.toString(), totalTickets: totalWeight.toString(), odds: w > 0n && totalWeight > 0n ? Number((w * 1_000_000n) / totalWeight) / 1_000_000 : 0, reason };
}

const routes = {
  "GET /pot": () => { const s = snapshot(); return { at: s.at, pots: s.pots, claimed: s.claimed, nextDoor: s.nextDoor, nextDoorAt: s.nextDoorAt, totalPaid: Object.values(s.doors ?? {}).flatMap((d) => d.winners ?? []).reduce((a, w) => a + BigInt(w.lamports), 0n).toString(), wallets: s.wallets }; },
  "GET /door/:d": ({ d }) => {
    const n = Number(d); if (!(n >= -5 && n <= LAST_DOOR)) return [404, { error: "no such door" }];
    const doc = door(n), t = now();
    const status = doc?.result ? "open" : doc?.commit ? "locked-in" : t >= doorTime(n) ? "due" : "locked";
    return { door: n, status, opensAt: doorTime(n), snapshotAt: snapshotTime(n), winnerCount: doc?.winners ?? null, eligible: doc?.rows?.length ?? null, pot: doc?.pot ?? null, commit: doc?.commit ? { signature: doc.commit.signature, blockTime: doc.commit.blockTime, hash: /hash=([0-9a-f]{64})/.exec(doc.commit.memo)?.[1] } : null, round: doc?.round ?? null, secondsToOpen: Math.max(0, doorTime(n) - t) };
  },
  "GET /winners/:d": ({ d }) => { const doc = door(Number(d)); if (!doc?.result) return [404, { error: "not settled" }]; return { door: Number(d), hash: /hash=([0-9a-f]{64})/.exec(doc.commit.memo)?.[1], round: doc.round, seed: doc.result.seed, signature: doc.result.signature, winners: doc.result.winners.map((w) => ({ k: w.k, account: w.account, lamports: w.lamports, signature: w.signature })), bonus: doc.result.bonus?.map((w) => ({ k: w.k, account: w.account, lamports: w.lamports, signature: w.signature })) ?? [], commit: doc.commit }; },
  "GET /eligible/:wallet": ({ wallet }) => eligibility(wallet),
  "GET /nonce/:wallet": ({ wallet }) => { const nonce = randomBytes(16).toString("hex"); nonces.set(wallet, { nonce, at: now() }); return { wallet, nonce, message: `ADVENT <action> ${wallet} ${nonce}` }; },
  "POST /door/:d/open": ({ d }, body) => {
    const v = verifySigned(body, `open-${d}`); if (v.error) return [401, v];
    const doc = door(Number(d)); if (!doc?.result) return [409, { error: "the door hasn't opened yet", opensAt: doorTime(Number(d)) }];
    const win = doc.result.winners.find((w) => w.account === v.wallet);
    const listed = doc.rows.some((r) => r.account === v.wallet);
    return { door: Number(d), wallet: v.wallet, inDrum: listed, won: !!win, lamports: win?.lamports ?? "0", signature: win?.signature ?? null };
  },
  "GET /bonus/:d": ({ d }) => { const e = readJson(ENTRANTS_FILE, {})[d] ?? []; const doc = door(Number(d)); return { door: Number(d), entrants: e.length, winners: doc?.result?.bonus?.length ?? 0 }; },
  "POST /village/session": () => [501, { error: "the village isn't open yet" }],
  "POST /village/pickup": () => [501, { error: "the village isn't open yet" }],
  "POST /village/bank": () => [501, { error: "the village isn't open yet" }],
  "POST /bonus/:d/open": () => [501, { error: "the bonus box isn't open yet" }],
};

function match(method, path) {
  for (const [key, fn] of Object.entries(routes)) {
    const [m, pattern] = key.split(" ");
    if (m !== method) continue;
    const re = new RegExp("^" + pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$");
    const hit = re.exec(path);
    if (hit) return { fn, params: hit.groups ?? {} };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", ORIGIN); res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("content-type", "application/json");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const r = match(req.method, url.pathname);
  if (!r) { res.writeHead(404); return res.end(JSON.stringify({ error: "not found" })); }
  let body = null;
  if (req.method === "POST") { let raw = ""; for await (const c of req) { raw += c; if (raw.length > 10_000) break; } try { body = JSON.parse(raw || "{}"); } catch { body = {}; } }
  try {
    const out = await r.fn(r.params, body);
    const [code, payload] = Array.isArray(out) ? out : [200, out];
    res.writeHead(code); res.end(JSON.stringify(payload, (k, v) => (typeof v === "bigint" ? v.toString() : v)));
  } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
});
export function start(port = PORT) { return new Promise((r) => server.listen(port, () => { console.log(`advent api on :${server.address().port}, draws from ${DRAWS_DIR}`); r(server); })); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start();
export { eligibility, verifySigned, routes, server };
