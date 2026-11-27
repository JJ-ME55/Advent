// The site's API: reads what the keeper publishes (DRAWS_DIR/snapshot.json, door-<d>.json, deltas.json) and
// answers wallet-signed requests: opening a door (any settled door; the answer is private to the wallet), claiming a
// prize (paid once from the door or bonus wallet, see claims.mjs), and the village game (village.mjs). No database:
// the keeper's published files, its private RESULTS_DIR, and three state files (claims, village, bonus entrants).
// Needs DOOR_KEYPAIR and BONUS_KEYPAIR to pay claims; without them claims answer 503.
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
import { createVillage, FIRST_VILLAGE_DOOR, COINS as VILLAGE_COINS, JOB_COINS } from "./village.mjs";
import { createClaims } from "./claims.mjs";
import { connections, loadKeypair, sendSol } from "./solana.mjs";

const PORT = Number(process.env.PORT ?? 8787);
const DRAWS_DIR = process.env.DRAWS_DIR ?? "draws";
const ENTRANTS_FILE = process.env.BONUS_ENTRANTS_FILE ?? "state/bonus-entrants.json";
const RESULTS_DIR = process.env.RESULTS_DIR ?? "state/results";
const CLAIMS_FILE = process.env.CLAIMS_FILE ?? "state/claims.json";
// CORS: SITE_ORIGIN is a comma-separated allowlist (the site and the village game); the matching Origin is echoed back
const ORIGINS = (process.env.SITE_ORIGIN ?? "*").split(",").map((o) => o.trim().replace(/\/$/, "")).filter(Boolean);
const corsOrigin = (req) => { if (ORIGINS.includes("*")) return "*"; const o = req.headers.origin; return o && ORIGINS.includes(o) ? o : ORIGINS[0]; };
const log = (...a) => console.log(new Date().toISOString(), ...a);
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
  if (!s) return { wallet, holder: false, inDrum: false, balance: "0", tickets: "0", reason: "not holding the coin" };
  const t = BigInt(at);
  const w = weightFor(s.balance, s.holdStart, t);
  const { totalWeight } = buildList(st, at);
  const held = Number(t - s.holdStart);
  let reason = null;
  if (s.balance < MIN_BALANCE) reason = `holds ${s.balance} of the ${MIN_BALANCE} minimum`;
  else if (held < Number(ELIGIBLE_AFTER)) reason = `held ${held} s of the ${ELIGIBLE_AFTER} s minimum`;
  return { wallet, holder: true, inDrum: w > 0n, balance: s.balance.toString(), holdStart: Number(s.holdStart), heldSeconds: held, tickets: w.toString(), totalTickets: totalWeight.toString(), odds: w > 0n && totalWeight > 0n ? Number((w * 1_000_000n) / totalWeight) / 1_000_000 : 0, reason };
}

const village = createVillage({ stateFile: process.env.VILLAGE_STATE_FILE ?? "state/village.json", entrantsFile: ENTRANTS_FILE, layoutFile: process.env.VILLAGE_LAYOUT_FILE, secret: process.env.VILLAGE_SECRET, isEligible: (w) => eligibility(w) });
village.firstDoor = FIRST_VILLAGE_DOOR;

// prizes are paid on claim, from the door wallet (doors) or the bonus wallet (Bonus Boxes), when the keys are here
let payer = null;
if (process.env.DOOR_KEYPAIR && process.env.BONUS_KEYPAIR) {
  const conns = connections(), keys = { door: loadKeypair(process.env.DOOR_KEYPAIR), bonus: loadKeypair(process.env.BONUS_KEYPAIR) };
  payer = (kind, to, lamports, memo) => sendSol(conns, keys[kind], to, lamports, memo);
}
const claims = createClaims({ file: CLAIMS_FILE, resultsDir: RESULTS_DIR, pay: payer, now, log });
const settling = (n) => [409, { ok: false, error: now() >= doorTime(n) ? "this door is still settling, try again in a moment" : "this door hasn't opened yet", status: now() >= doorTime(n) ? "due" : "locked", opensAt: doorTime(n) }];

const routes = {
  "GET /pot": () => { const s = snapshot(); return { at: s.at, pots: s.pots, claimed: s.claimed, nextDoor: s.nextDoor, nextDoorAt: s.nextDoorAt, totalPaid: Object.values(s.doors ?? {}).reduce((a, d) => a + BigInt(d.door?.claimedLamports ?? 0) + BigInt(d.bonus?.claimedLamports ?? 0), 0n).toString(), totalWon: Object.values(s.doors ?? {}).reduce((a, d) => a + BigInt(d.door?.totalLamports ?? 0) + BigInt(d.bonus?.totalLamports ?? 0), 0n).toString(), wallets: s.wallets }; },
  "GET /door/:d": ({ d }) => {
    const n = Number(d); if (!(n >= -5 && n <= LAST_DOOR)) return [404, { error: "no such door" }];
    const doc = door(n), t = now();
    const status = doc?.result ? "open" : doc?.commit ? "locked-in" : t >= doorTime(n) ? "due" : "locked";
    return { door: n, status, opensAt: doorTime(n), snapshotAt: snapshotTime(n), winnerCount: doc?.winners ?? null, eligible: doc?.rows?.length ?? null, pot: doc?.pot ?? null, commit: doc?.commit ? { signature: doc.commit.signature, blockTime: doc.commit.blockTime, hash: /hash=([0-9a-f]{64})/.exec(doc.commit.memo)?.[1] } : null, round: doc?.round ?? null, secondsToOpen: Math.max(0, doorTime(n) - t) };
  },
  "GET /winners/:d": ({ d }) => {
    // no spoilers: counts and totals for everyone, names only for winners who have opened or claimed. Verify has what
    // it needs (list, hash, round, seed, drand signature) and can recompute the rest.
    const n = Number(d), doc = door(n), res = claims.result(n);
    if (!res?.winners || !doc?.commit) return [404, { error: "not settled" }];
    return { door: n, hash: /hash=([0-9a-f]{64})/.exec(doc.commit.memo)?.[1], round: doc.round, seed: res.seed, signature: res.signature, commit: doc.commit, pot: doc.pot, eligible: doc.rows?.length ?? null, ...claims.publicView("door", n, res), bonus: claims.publicView("bonus", n, res) };
  },
  "GET /eligible/:wallet": ({ wallet }) => eligibility(wallet),
  "GET /nonce/:wallet": ({ wallet }) => { const nonce = randomBytes(16).toString("hex"); nonces.set(wallet, { nonce, at: now() }); return { wallet, nonce, expiresIn: 300, formats: { open: `ADVENT open-<d> ${wallet} ${nonce}`, claim: `ADVENT claim-<d> ${wallet} ${nonce}`, bonusOpen: `ADVENT bonus-<d> ${wallet} ${nonce}`, bonusClaim: `ADVENT bonus-claim-<d> ${wallet} ${nonce}`, village: `ADVENT village ${wallet} ${nonce}` } }; },
  // opening: any settled door, any day; the answer is for this wallet only
  "POST /door/:d/open": ({ d }, body) => {
    const v = verifySigned(body, `open-${d}`); if (v.error) return [401, { ok: false, ...v }];
    const n = Number(d), r = claims.open("door", n, v.wallet); if (!r) return settling(n);
    const inDrum = door(n)?.rows?.some((x) => x.account === v.wallet) ?? false;
    return { ok: true, door: n, wallet: v.wallet, inDrum, ...r };
  },
  "POST /door/:d/claim": async ({ d }, body) => { const v = verifySigned(body, `claim-${d}`); if (v.error) return [401, { ok: false, ...v }]; return claims.claim("door", Number(d), v.wallet); },
  "POST /bonus/:d/open": ({ d }, body) => {
    const v = verifySigned(body, `bonus-${d}`); if (v.error) return [401, { ok: false, ...v }];
    const n = Number(d), entered = village.entrantsOf(n).includes(v.wallet), r = claims.open("bonus", n, v.wallet);
    if (!r) return [409, { ok: false, error: "the box opens with the door", drawAt: doorTime(n), entered }];
    return { ok: true, door: n, wallet: v.wallet, entered, inDrum: entered, ...r, entrants: village.entrantsOf(n).length };
  },
  "POST /bonus/:d/claim": async ({ d }, body) => { const v = verifySigned(body, `bonus-claim-${d}`); if (v.error) return [401, { ok: false, ...v }]; return claims.claim("bonus", Number(d), v.wallet); },
  // the village: a wallet signature starts the run (action `village`), then a session token carries it
  "POST /village/session": (_, body) => { const v = verifySigned(body, "village"); if (v.error) return [401, v]; return village.session(v.wallet); },
  "POST /village/move": (_, body) => village.move(body?.token, body?.pos),
  "POST /village/pickup": (_, body) => village.pickup(body?.token, body?.coin, body?.pos),
  "POST /village/bank": (_, body) => village.bank(body?.token, body?.pos),
  "POST /village/job/start": (_, body) => village.jobStart(body?.token, body?.job, body?.pos),
  "POST /village/job/finish": (_, body) => village.jobFinish(body?.token, body?.job, body?.pos),
  "GET /village/layout": () => { const { spawn, bank, givers, taxiPoints, deliveryDoors, ringRoad, respawns } = village.layout; return { spawn, bank, coins: VILLAGE_COINS, jobCoins: JOB_COINS, firstDoor: village.firstDoor, givers, taxiPoints, deliveryDoors, ringRoad, respawns }; },
  "GET /village/map/:d": ({ d }) => village.map(Number(d)),
  "GET /bonus/:d": ({ d }) => { const n = Number(d), res = claims.result(n), st = village.status(n); return { ...st, ...(res ? claims.publicView("bonus", n, res) : { winnerCount: 0, claimedCount: 0, winners: [] }) }; },
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
  res.setHeader("access-control-allow-origin", corsOrigin(req)); res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS"); res.setHeader("access-control-allow-headers", "content-type"); res.setHeader("vary", "origin"); res.setHeader("content-type", "application/json");
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
export { eligibility, verifySigned, routes, server, village, claims };
