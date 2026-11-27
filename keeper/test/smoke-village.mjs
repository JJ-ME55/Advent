// Plays a whole village day against the real API over HTTP with a throwaway wallet: sign in, walk, pick up the 10
// hidden coins, do the three jobs (10 job coins), bank at the Post Office, and check the entrants file the keeper
// reads. The chase and the brawl need 20 and 25 real seconds, so the smoke runs them side by side. Uses a fake calendar (door 1 in an hour) and a published
// snapshot that makes the wallet eligible. No network beyond localhost.
//   node test/smoke-village.mjs
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";

const dir = mkdtempSync(join(tmpdir(), "advent-village-smoke-"));
const T = Math.floor(Date.now() / 1000);
process.env.DOOR_TIMES = JSON.stringify({ 0: T - 60, 1: T + 3600 });
process.env.FIRST_DOOR = "1"; process.env.LAST_DOOR = "1";
process.env.DRAWS_DIR = dir; process.env.PORT = "0";
process.env.BONUS_ENTRANTS_FILE = join(dir, "bonus-entrants.json"); process.env.VILLAGE_STATE_FILE = join(dir, "village.json");
process.env.VILLAGE_MIN_RUN_SECONDS = "20"; process.env.VILLAGE_PICKUP_GAP_MS = "50"; process.env.VILLAGE_MAX_SPEED = "400"; // a fast walker so the smoke takes seconds, not minutes
const { UNIT } = await import("../src/drum.mjs");
const kp = nacl.sign.keyPair(), wallet = bs58.encode(kp.publicKey);
writeFileSync(join(dir, "deltas.json"), JSON.stringify([
  { owner: "CURVE", delta: (1_000_000_000n * UNIT).toString(), time: T - 90_000, slot: 1, signature: "m", index: 0 },
  { owner: "CURVE", delta: (-300_000n * UNIT).toString(), time: T - 80_000, slot: 2, signature: "b1", index: 0 },
  { owner: wallet, delta: (300_000n * UNIT).toString(), time: T - 80_000, slot: 2, signature: "b1", index: 1 },
]));
writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ at: T, pots: { door: "0", bonus: "5000000000" }, exclude: ["CURVE"], wallets: {}, doors: {} }));
const api = await import("../src/api.mjs");
const server = await api.start(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = async (method, path, body) => { const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json()]; };
const must = (cond, what) => { if (!cond) { console.error("FAIL", what); process.exit(1); } console.log("ok ", what); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [, { nonce }] = await call("GET", `/nonce/${wallet}`);
const signature = bs58.encode(nacl.sign.detached(Buffer.from(`ADVENT village ${wallet} ${nonce}`), kp.secretKey));
let [code, s] = await call("POST", "/village/session", { wallet, nonce, signature });
must(code === 200 && s.token && s.door === 1 && s.total === 10 && s.jobTotal === 10 && s.jobs.length === 3, `session started for door ${s.door}: ${s.found}/${s.total} coins, ${s.jobCoins}/${s.jobTotal} job coins, jobs ${s.jobs.map((j) => j.type).join("+")}`);
const [c2, s2] = await call("POST", "/village/session", { wallet, nonce, signature });
must(c2 === 401, "a reused nonce is refused");
// the client only ever sees coins near the player: sweep the village in a lawn-mower pattern to find them all
const seen = new Map(); let at = s.spawn, picked = 0;
const stepTo = async (p) => { const d = Math.hypot(p.x - at.x, p.z - at.z); await sleep(Math.max(15, (d / 350) * 1000)); at = p; const [c, v] = await call("POST", "/village/move", { token: s.token, pos: p }); if (c !== 200) throw new Error(`move ${c} ${v.error}`); for (const n of v.nearby) seen.set(n.id, n); return v; };
for (let z = -110; z <= 110 && picked < 10; z += 20) {
  for (let x = -110; x <= 110 && picked < 10; x += 20) {
    await stepTo({ x, y: 0, z });
    for (const [id, c] of seen) {
      await stepTo({ x: c.x, y: 0, z: c.z });
      const [pc, pv] = await call("POST", "/village/pickup", { token: s.token, coin: id, pos: at });
      if (pc !== 200) throw new Error(`pickup ${pc} ${pv.error}`);
      picked = pv.found; seen.delete(id);
    }
  }
}
must(picked === 10, `all 10 hidden coins picked up walking the village (never told where they were up front)`);
// the jobs: honest runs, judged from the move history; the timed ones (chase 20 s, brawl 25 s) run at the same time
const [, lay] = await call("GET", "/village/layout");
must(lay.givers && lay.taxiPoints.length >= 2 && lay.deliveryDoors.length >= 3 && lay.ringRoad, "GET /village/layout has the job points");
const job = (type) => s.jobs.find((j) => j.type === type);
const startJob = async (j) => { await stepTo({ x: j.giver.x, y: 0, z: j.giver.z }); const [c, r] = await call("POST", "/village/job/start", { token: s.token, job: j.id, pos: at }); if (c !== 200) throw new Error(`start ${j.id}: ${c} ${JSON.stringify(r)}`); };
const finishJob = async (j) => { const [c, r] = await call("POST", "/village/job/finish", { token: s.token, job: j.id, pos: at }); must(c === 200 && r.ok, `${j.type} (${j.name}) done for ${j.reward}: ${r.jobCoins} job coins, reason ${r.reason ?? "-"}`); return r; };
// the chase has no area rule, so it runs in the background while the taxi and the delivery get done
if (job("chase")) await startJob(job("chase"));
if (job("taxi")) { const j = job("taxi"); await startJob(j); await stepTo({ x: j.targets[0].x, y: 0, z: j.targets[0].z }); await stepTo({ x: j.targets[1].x, y: 0, z: j.targets[1].z }); await finishJob(j); }
if (job("delivery")) { const j = job("delivery"); await startJob(j); await stepTo(s.bank); for (const d of j.targets) await stepTo({ x: d.x, y: 0, z: d.z }); await finishJob(j); }
// the brawl last: stay by its giver (on the ring road in the dev layout) for 25 s, then hand in the brawl and the chase there
if (job("brawl")) { await startJob(job("brawl")); console.log("    waiting 26 s for the brawl clock"); await sleep(26_000); await finishJob(job("brawl")); }
if (job("chase")) { const g = lay.givers.brawl; if (!job("brawl")) await sleep(21_000); await stepTo({ x: g.x, y: 0, z: g.z }); await finishJob(job("chase")); }
const [, mv] = await call("POST", "/village/move", { token: s.token, pos: at });
must(mv.jobCoins === 10 && mv.found === 10 && mv.jobs.every((j) => j.done), `20/20: ${mv.found} hidden + ${mv.jobCoins} job coins`);
const [ac, av] = await call("POST", "/village/job/finish", { token: s.token, job: s.jobs[0].id, pos: at });
must(ac === 409 && av.reason === "already-done", "a job counts once");
const [tc, tv] = await call("POST", "/village/move", { token: s.token, pos: { x: at.x + 5000, y: 0, z: at.z } });
must(tc === 422 && /too fast/.test(tv.error), `a teleport is refused: ${tv.error}`);
await stepTo(s.bank);
const [bc, bv] = await call("POST", "/village/bank", { token: s.token, pos: s.bank });
must(bc === 200 && bv.entered && bv.entrants === 1, `banked at the Post Office: entered for door 1 (${bv.entrants} entrant)`);
const file = JSON.parse(readFileSync(process.env.BONUS_ENTRANTS_FILE, "utf8"));
must(JSON.stringify(file) === JSON.stringify({ 1: [wallet] }), "the keeper's entrants file has the wallet");
const [, st] = await call("GET", "/bonus/1");
must(st.phase === "open" && st.entrants === 1 && st.winnerCount === 0, `GET /bonus/1 → ${JSON.stringify(st)}`);
const [mc] = await call("GET", "/village/map/1");
must(mc === 403, "today's map stays secret");
const [, { nonce: n2 }] = await call("GET", `/nonce/${wallet}`);
const [oc, ov] = await call("POST", "/bonus/1/open", { wallet, nonce: n2, signature: bs58.encode(nacl.sign.detached(Buffer.from(`ADVENT bonus-1 ${wallet} ${n2}`), kp.secretKey)) });
must(oc === 409 && ov.entered === true, `the box can't be opened before the door: ${ov.error}`);
server.close(); console.log("village smoke: all good"); process.exit(0);
