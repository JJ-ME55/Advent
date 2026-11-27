// The North Pole village, server side (the judge). Fish draws it; this decides what counts.
//
// A player needs 20 coins a day: 10 HIDDEN coins found around the map and 10 JOB coins from 3 daily jobs (3 + 3 + 4).
// Banking all 20 at the Post Office (the layout's bank point) enters the wallet for that door's Bonus Box; the keeper
// draws 10 winners from the entrants with the door's drand round at settle time, and they open the box on the site.
//
// - Hidden coins: each door d has a day's map, COINS of the layout's hiding spots chosen from a secret so the positions
//   change every day and can't be read from the client. The server reveals only coins within REVEAL_RADIUS and checks
//   every pickup (3 m, speed, pace).
// - Jobs: four types exist (taxi, delivery, chase, brawl); each day 3 are picked from the door number alone (public,
//   the same for everyone), with the taxi's two points and the delivery's three doors picked the same way from the
//   layout. The server owns the definitions (/village/session returns them) and judges each finish from the run's
//   position history, which every move/pickup/bank/job call extends.
// - One run per wallet per door. Door d's village runs from door d−1 opening until door d's snapshot; entries close at
//   the snapshot, like the Nice List. After that the day's map is public (GET /village/map/:d).
//
// State is one JSON file (sessions per door) plus the entrants file the keeper reads: { "<door>": [wallets] }. The
// position history lives in memory only (a restart mid-job just means starting that job again).
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { doorTime, snapshotTime, LAST_DOOR } from "./doors.mjs";

export const COINS = Number(process.env.VILLAGE_COINS ?? 10); // hidden coins a day
export const JOB_COINS = 10; // from the day's three jobs
export const JOB_REWARDS = [3, 3, 4];
export const JOB_TYPES = ["taxi", "delivery", "chase", "brawl"];
export const JOB_NAMES = { taxi: "Sleigh Ride", delivery: "Special Delivery", chase: "Runaway Reindeer", brawl: "Elf Trouble" };
export const REVEAL_RADIUS = Number(process.env.VILLAGE_REVEAL_RADIUS ?? 25); // metres: coins the client is told about
export const PICKUP_RADIUS = Number(process.env.VILLAGE_PICKUP_RADIUS ?? 3); // metres from the coin to take it
export const BANK_RADIUS = Number(process.env.VILLAGE_BANK_RADIUS ?? 6);
export const JOB_RADIUS = Number(process.env.VILLAGE_JOB_RADIUS ?? 6); // metres: at the giver, a taxi point, a delivery door
export const MAX_SPEED = Number(process.env.VILLAGE_MAX_SPEED ?? 22); // m/s; sleds 16, Santa's sleigh 18, on foot 7.4; no boosts
export const RESPAWN_RADIUS = Number(process.env.VILLAGE_RESPAWN_RADIUS ?? 8); // m; a busted/KO'd player reappears at one of the layout's respawn points, any speed
export const PICKUP_GAP_MS = Number(process.env.VILLAGE_PICKUP_GAP_MS ?? 700); // two coins can't be taken in the same breath
export const MIN_RUN_SECONDS = Number(process.env.VILLAGE_MIN_RUN_SECONDS ?? 300); // nobody does 10 coins and 3 jobs in under this
export const DELIVERY_SECONDS = 170, CHASE_SECONDS = 240, CHASE_MIN_SECONDS = 20, BRAWL_MIN_SECONDS = 25, BRAWL_RANGE = 40;
export const HISTORY = 900; // positions kept per run (15 min at one ping a second)
export const FIRST_VILLAGE_DOOR = Number(process.env.VILLAGE_FIRST_DOOR ?? process.env.FIRST_DOOR ?? 1);

const sha = (...parts) => createHash("sha256").update(parts.join("|")).digest();
const dist = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));
const dxz = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.z ?? 0) - (b.z ?? 0)); // job points are ground points
const pos = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: Number(p.x), y: Number(p.y ?? 0), z: Number(p.z) } : null);
const xz = (p) => ({ x: Number(p?.x ?? 0), z: Number(p?.z ?? 0) });
/** Items in a deterministic order given a seed: rank by sha256(seed parts, item key). The same trick picks the coins. */
const rank = (items, key, ...seed) => items.map((it, i) => ({ it, r: sha(...seed, key(it, i)).toString("hex") })).sort((a, b) => (a.r < b.r ? -1 : 1)).map((x) => x.it);

/** The layout Fish exports: { spawn, bank, spots: [{ id, x, y, z }], givers: { taxi, delivery, chase, brawl }, taxiPoints: [{ name, x, z }],
 *  deliveryDoors: [{ x, z }], ringRoad: { r, width, x?, z? }, respawns: [{ x, y?, z }] }. Without a file: a 200 m development square.
 *  Missing job points get defaults; missing respawns means the spawn is the only one. */
export function loadLayout(file) {
  const def = defaultLayout();
  if (!(file && existsSync(file))) return def;
  const l = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(l.spots) || l.spots.length < COINS) throw new Error(`layout needs at least ${COINS} spots`);
  const out = { spawn: pos(l.spawn) ?? def.spawn, bank: pos(l.bank) ?? def.bank, spots: l.spots.map((s, i) => ({ id: String(s.id ?? i), ...pos(s) })), givers: {}, taxiPoints: [], deliveryDoors: [], ringRoad: null };
  const missing = [];
  for (const t of JOB_TYPES) { if (l.givers?.[t]) out.givers[t] = xz(l.givers[t]); else { out.givers[t] = def.givers[t]; missing.push(`givers.${t}`); } }
  if (Array.isArray(l.taxiPoints) && l.taxiPoints.length >= 2) out.taxiPoints = l.taxiPoints.map((p, i) => ({ name: String(p.name ?? `P${i + 1}`), ...xz(p) })); else { out.taxiPoints = def.taxiPoints; missing.push("taxiPoints (2+)"); }
  if (Array.isArray(l.deliveryDoors) && l.deliveryDoors.length >= 3) out.deliveryDoors = l.deliveryDoors.map(xz); else { out.deliveryDoors = def.deliveryDoors; missing.push("deliveryDoors (3+)"); }
  if (l.ringRoad && Number.isFinite(l.ringRoad.r)) out.ringRoad = { r: Number(l.ringRoad.r), width: Number(l.ringRoad.width ?? 8), ...xz(l.ringRoad) }; else { out.ringRoad = def.ringRoad; missing.push("ringRoad"); }
  // respawns: a list, or an object keyed by reason ({ busted, knockedOut }); each point may carry y
  const rs = Array.isArray(l.respawns) ? l.respawns : l.respawns && typeof l.respawns === "object" ? Object.entries(l.respawns).map(([name, p]) => ({ name, ...p })) : [];
  out.respawns = rs.length ? rs.map((p) => ({ ...(pos(p) ?? { ...xz(p), y: 0 }), ...(p.name ? { name: String(p.name) } : {}) })) : [out.spawn];
  if (missing.length) console.warn(`village layout ${file}: using development defaults for ${missing.join(", ")}`);
  return out;
}

function defaultLayout() {
  const spots = [];
  for (let i = 0; i < 64; i++) {
    const j = sha("default-layout", i);
    spots.push({ id: `s${i}`, x: -100 + (i % 8) * 28 + (j[0] / 255) * 12, y: 0, z: -100 + Math.floor(i / 8) * 28 + (j[1] / 255) * 12 });
  }
  const taxiPoints = ["Station", "Toy Works", "Reindeer Barn", "Ice Rink", "Market", "Lighthouse"].map((name, i) => { const a = (i / 6) * 2 * Math.PI; return { name, x: Math.round(Math.cos(a) * 70), z: Math.round(Math.sin(a) * 70) }; });
  const deliveryDoors = Array.from({ length: 12 }, (_, i) => ({ x: -55 + (i % 4) * 36, z: -40 + Math.floor(i / 4) * 40 }));
  return {
    spawn: { x: 0, y: 0, z: 0 }, bank: { x: 0, y: 0, z: 0 }, spots,
    givers: { taxi: { x: -60, z: -60 }, delivery: { x: 10, z: 0 }, chase: { x: 60, z: -60 }, brawl: { x: 80, z: 0 } }, // brawl's giver sits on the ring road
    taxiPoints, deliveryDoors, ringRoad: { r: 80, width: 8, x: 0, z: 0 },
    respawns: [{ x: 0, y: 0, z: 0 }, { x: -90, y: 0, z: 90 }], // the spawn and a hospital in the far corner
  };
}

/** The day's hidden coins: COINS spots picked from the layout by sha256(secret, door). Deterministic; secret per deployment. */
export function dayMap(layout, secret, door) {
  return rank(layout.spots, (s) => s.id, secret, door).slice(0, COINS).map((s, k) => ({ id: `c${k + 1}`, spot: s.id, x: s.x, y: s.y, z: s.z }));
}

/** The day's three jobs, from the door number alone (no secret: everyone gets the same jobs and can see them coming). */
export function dayJobs(layout, door) {
  const types = rank(JOB_TYPES, (t) => t, "jobs", door).slice(0, 3);
  const [A, B] = rank(layout.taxiPoints, (p, i) => p.name ?? i, "taxi", door);
  const doors = rank(layout.deliveryDoors, (_, i) => i, "delivery", door).slice(0, 3);
  return types.map((type, i) => {
    const job = { id: `${door}-${type}`, type, name: JOB_NAMES[type], reward: JOB_REWARDS[i], giver: layout.givers[type] };
    if (type === "taxi") return { ...job, timerSeconds: Math.round(dxz(A, B) / 9 + 35), targets: [A, B] };
    if (type === "delivery") return { ...job, timerSeconds: DELIVERY_SECONDS, targets: doors };
    if (type === "chase") return { ...job, timerSeconds: CHASE_SECONDS, targets: [{ ...layout.ringRoad }] };
    return { ...job, timerSeconds: null, targets: [] }; // brawl: no timer, stay in the area
  });
}

/** Judges a finished job from the positions recorded since it started (the start and finish positions included). Returns a reason or null. */
export function judgeJob(job, startedAt, since, t, layout) {
  const el = t - startedAt, at = (p, r = JOB_RADIUS) => (h) => dxz(h, p) <= r;
  if (job.type === "taxi") {
    const [A, B] = job.targets;
    const pick = since.find(at(A)); if (!pick) return "no-pickup";
    const drop = since.find((h) => h.t > pick.t && at(B)(h)); if (!drop) return "no-dropoff";
    if (drop.t - startedAt > job.timerSeconds) return "timeout";
    if (drop.t - pick.t < dxz(A, B) / MAX_SPEED) return "too-fast";
    return null;
  }
  if (job.type === "delivery") {
    const sack = since.find(at(layout.bank)); if (!sack) return "no-sack";
    const visits = job.targets.map((door) => since.find((h) => h.t > sack.t && at(door)(h)));
    if (visits.some((v) => !v)) return "doors-missed";
    if (Math.max(...visits.map((v) => v.t)) - sack.t > job.timerSeconds) return "timeout";
    return null;
  }
  if (job.type === "chase") {
    if (el < CHASE_MIN_SECONDS) return "too-quick";
    if (el > job.timerSeconds) return "timeout";
    const ring = layout.ringRoad, end = since[since.length - 1];
    if (Math.abs(dxz(end, ring) - ring.r) > ring.width / 2 + JOB_RADIUS) return "not-on-ring";
    return null;
  }
  if (job.type === "brawl") {
    if (el < BRAWL_MIN_SECONDS) return "too-quick";
    if (since.some((h) => dxz(h, job.giver) > BRAWL_RANGE)) return "left-area";
    return null;
  }
  return "unknown-job";
}

/** The door whose Bonus Box a run started at t counts for: the next door whose entries are still open. */
export function villageDoor(t, { first = FIRST_VILLAGE_DOOR, last = LAST_DOOR } = {}) {
  for (let d = first; d <= last; d++) if (snapshotTime(d) > t) return d;
  return null;
}

export function createVillage({ stateFile, entrantsFile, layoutFile, layout: given, secret, isEligible, now = () => Date.now() / 1000 } = {}) {
  const layout = given ? { ...defaultLayout(), ...given } : loadLayout(layoutFile);
  let state = { secret: null, sessions: {} };
  try { state = { ...state, ...JSON.parse(readFileSync(stateFile, "utf8")) }; } catch { /* first run */ }
  state.secret = secret ?? state.secret ?? randomBytes(32).toString("hex");
  let entrants = {};
  try { entrants = JSON.parse(readFileSync(entrantsFile, "utf8")); } catch { /* none yet */ }
  const atomic = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(data)); renameSync(`${file}.tmp`, file); };
  const save = () => atomic(stateFile, state);
  const maps = new Map(), jobs = new Map(), histories = new Map();
  const mapFor = (d) => { if (!maps.has(d)) maps.set(d, dayMap(layout, state.secret, d)); return maps.get(d); };
  const jobsFor = (d) => { if (!jobs.has(d)) jobs.set(d, dayJobs(layout, d)); return jobs.get(d); };
  const history = (s) => { if (!histories.has(s.token)) histories.set(s.token, []); return histories.get(s.token); };
  const byToken = new Map();
  for (const [d, ss] of Object.entries(state.sessions)) for (const [wallet, s] of Object.entries(ss)) { s.jobs ??= {}; s.jobCoins ??= 0; byToken.set(s.token, { door: Number(d), wallet, s }); }

  const nearby = (d, s, p) => mapFor(d).filter((c) => !s.collected.includes(c.id) && dist(c, p) <= REVEAL_RADIUS).map(({ id, x, y, z }) => ({ id, x, y, z }));
  const jobsView = (d, s) => jobsFor(d).map((j) => ({ ...j, done: !!s.jobs[j.id]?.done, started: !!s.jobs[j.id]?.startedAt && !s.jobs[j.id]?.done }));
  const jobsDone = (d, s) => jobsFor(d).filter((j) => s.jobs[j.id]?.done).map((j) => j.id);
  const view = (d, s, p) => ({ door: d, found: s.collected.length, collected: s.collected.length, total: COINS, jobCoins: s.jobCoins, jobTotal: JOB_COINS, jobs: jobsView(d, s), banked: s.banked, nearby: nearby(d, s, p), closesAt: snapshotTime(d), drawAt: doorTime(d) });
  const lookup = (token) => { const h = token && byToken.get(token); if (!h) return [401, { error: "no such session" }]; if (now() >= snapshotTime(h.door)) return [409, { error: `entries for door ${h.door} closed`, door: h.door, next: villageDoor(now()) }]; return h; };
  const respawns = layout.respawns ?? [layout.spawn];
  const atRespawn = (p) => respawns.some((r) => dxz(r, p) <= RESPAWN_RADIUS);
  /** Moves the player and records the position; rejects teleports. A jump that lands on a respawn point (busted, KO'd) is
   *  allowed at any speed and marked in the history, so a job in progress sees it as leaving. Returns the error or null. */
  const move = (s, p, t) => {
    const dt = t - s.last.t, dd = dist(s.last, p);
    const fast = (dt > 0.05 && dd / dt > MAX_SPEED) || (dt <= 0.05 && dd > MAX_SPEED);
    const respawn = fast && atRespawn(p);
    if (fast && !respawn) return dt > 0.05 ? `too fast: ${dd.toFixed(1)} m in ${dt.toFixed(2)} s` : `too fast: ${dd.toFixed(1)} m at once`;
    s.last = { ...p, t };
    const h = history(s); h.push(respawn ? { t, x: p.x, z: p.z, respawn: true } : { t, x: p.x, z: p.z }); if (h.length > HISTORY) h.splice(0, h.length - HISTORY);
    return null;
  };

  return {
    layout, mapFor, jobsFor,
    /** Start (or resume) the wallet's run for the current door. */
    session(wallet) {
      const t = now(), d = villageDoor(t);
      if (d === null) return [410, { error: "the village is closed for the season" }];
      if (t < doorTime(d - 1)) return [503, { error: `door ${d}'s village opens when door ${d - 1} does`, opensAt: doorTime(d - 1), door: d }]; // one day's map at a time
      const e = isEligible ? isEligible(wallet) : { inDrum: true };
      if (!e.inDrum) return [403, { error: "only holders on Santa's Nice List can play", reason: e.reason ?? null, eligibility: e }];
      state.sessions[d] ??= {};
      let s = state.sessions[d][wallet], created = false;
      if (!s) {
        created = true;
        s = { token: randomBytes(24).toString("hex"), startedAt: t, collected: [], jobs: {}, jobCoins: 0, banked: false, last: { ...layout.spawn, t }, lastPickupAt: 0, strikes: 0 };
        state.sessions[d][wallet] = s; byToken.set(s.token, { door: d, wallet, s }); save();
      }
      return { token: s.token, wallet, spawn: layout.spawn, bank: layout.bank, resumed: !created, startedAt: s.startedAt, ...view(d, s, s.last) };
    },
    /** A position ping: what's near me. */
    move(token, p) {
      const h = lookup(token); if (Array.isArray(h)) return h;
      p = pos(p); if (!p) return [400, { error: "pos {x,y,z} required" }];
      const bad = move(h.s, p, now()); if (bad) { h.s.strikes++; return [422, { error: bad, ...view(h.door, h.s, h.s.last) }]; }
      return view(h.door, h.s, p);
    },
    /** Take coin `coin` from position p. */
    pickup(token, coin, p) {
      const h = lookup(token); if (Array.isArray(h)) return h;
      p = pos(p); if (!p) return [400, { error: "pos {x,y,z} required" }];
      const { s, door: d } = h, t = now();
      const c = mapFor(d).find((x) => x.id === coin);
      if (!c) return [404, { error: "no such coin today" }];
      if (s.collected.includes(coin)) return [409, { error: "already picked up", ...view(d, s, p) }];
      const bad = move(s, p, t); if (bad) { s.strikes++; return [422, { error: bad, ...view(d, s, s.last) }]; }
      if (dist(c, p) > PICKUP_RADIUS) { s.strikes++; return [422, { error: `too far from the coin: ${dist(c, p).toFixed(1)} m`, ...view(d, s, p) }]; }
      if ((t - s.lastPickupAt) * 1000 < PICKUP_GAP_MS) { s.strikes++; return [429, { error: "one coin at a time", ...view(d, s, p) }]; }
      s.collected.push(coin); s.lastPickupAt = t; save();
      return { picked: coin, ...view(d, s, p) };
    },
    /** Take a job from its giver: records the start. A failed job can be started again; a done one can't. */
    jobStart(token, jobId, p) {
      const h = lookup(token); if (Array.isArray(h)) return h;
      p = pos(p); if (!p) return [400, { ok: false, reason: "bad-pos", error: "pos {x,y,z} required" }];
      const { s, door: d } = h, t = now();
      const job = jobsFor(d).find((j) => j.id === jobId);
      if (!job) return [404, { ok: false, reason: "no-such-job", error: "not one of today's jobs" }];
      if (s.jobs[jobId]?.done) return [409, { ok: false, reason: "already-done", jobCoins: s.jobCoins, jobsDone: jobsDone(d, s) }];
      const bad = move(s, p, t); if (bad) { s.strikes++; return [422, { ok: false, reason: "too-fast", error: bad }]; }
      if (dxz(job.giver, p) > JOB_RADIUS) return [422, { ok: false, reason: "not-at-giver", error: `${dxz(job.giver, p).toFixed(1)} m from the giver` }];
      s.jobs[jobId] = { startedAt: t }; save();
      return { ok: true, job: jobId, startedAt: t, timerSeconds: job.timerSeconds, ...view(d, s, p) };
    },
    /** Hand a job in: judged from the positions recorded since it started. */
    jobFinish(token, jobId, p) {
      const h = lookup(token); if (Array.isArray(h)) return h;
      p = pos(p); if (!p) return [400, { ok: false, reason: "bad-pos", error: "pos {x,y,z} required" }];
      const { s, door: d } = h, t = now();
      const job = jobsFor(d).find((j) => j.id === jobId);
      if (!job) return [404, { ok: false, reason: "no-such-job", error: "not one of today's jobs" }];
      const js = s.jobs[jobId];
      if (js?.done) return [409, { ok: false, reason: "already-done", jobCoins: s.jobCoins, jobsDone: jobsDone(d, s) }];
      if (!js?.startedAt) return [422, { ok: false, reason: "not-started" }];
      const fail = (reason, error) => { s.strikes++; delete s.jobs[jobId]; save(); return [422, { ok: false, reason, error, job: jobId, jobCoins: s.jobCoins, jobsDone: jobsDone(d, s) }]; };
      const bad = move(s, p, t); if (bad) return fail("too-fast", bad);
      const since = history(s).filter((x) => x.t >= js.startedAt);
      const reason = judgeJob(job, js.startedAt, since, t, layout);
      if (reason) return fail(reason);
      js.done = true; js.finishedAt = t; s.jobCoins = Math.min(JOB_COINS, s.jobCoins + job.reward); save();
      return { ok: true, job: jobId, reward: job.reward, jobCoins: s.jobCoins, jobsDone: jobsDone(d, s), ...view(d, s, p) };
    },
    /** Bank the 20 at the Post Office: enters the wallet for the door's Bonus Box. */
    bank(token, p) {
      const h = lookup(token); if (Array.isArray(h)) return h;
      p = pos(p); if (!p) return [400, { error: "pos {x,y,z} required" }];
      const { s, door: d, wallet } = h, t = now();
      const bad = move(s, p, t); if (bad) { s.strikes++; return [422, { error: bad, ...view(d, s, s.last) }]; }
      if (dist(layout.bank, p) > BANK_RADIUS) return [422, { error: `not at the Post Office: ${dist(layout.bank, p).toFixed(1)} m away`, ...view(d, s, p) }];
      if (s.collected.length < COINS || s.jobCoins < JOB_COINS) return [409, { reason: "not-enough", error: `${COINS - s.collected.length} hidden coins and ${JOB_COINS - s.jobCoins} job coins still to earn`, ...view(d, s, p) }];
      if (t - s.startedAt < MIN_RUN_SECONDS) { s.strikes++; return [422, { reason: "too-quick", error: "that was too quick to be a day's work", ...view(d, s, p) }]; }
      if (!s.banked) {
        s.banked = true; s.bankedAt = t;
        entrants[d] = [...new Set([...(entrants[d] ?? []), wallet])];
        atomic(entrantsFile, entrants); save();
      }
      return { entered: true, ...view(d, s, p), entrants: entrants[d].length };
    },
    /** Who's in for door d, and whether the box is still open. */
    status(d) {
      const t = now(), list = entrants[d] ?? [];
      const phase = t < snapshotTime(d) ? "open" : t < doorTime(d) ? "closed" : "drawn";
      return { door: d, phase, entrants: list.length, playing: Object.keys(state.sessions[d] ?? {}).length, closesAt: snapshotTime(d), drawAt: doorTime(d) };
    },
    entrantsOf: (d) => entrants[d] ?? [],
    /** Yesterday's answers: the full coin list (and the jobs) once entries have closed. */
    map(d) {
      if (now() < snapshotTime(d)) return [403, { error: "today's map is a secret until entries close", closesAt: snapshotTime(d), jobs: jobsFor(d) }];
      return { door: d, coins: mapFor(d), jobs: jobsFor(d) };
    },
  };
}
