// The North Pole village, server side (the judge). Fish draws it; this decides what counts.
//
// Each door d has a day's map: 20 coins hidden at 20 of the village's hiding spots, chosen from a secret so the
// positions change every day and can't be read from the client. A holder on the Nice List (the eligibility list) starts one session per door,
// walks about (the client pings positions, the server reveals coins within REVEAL_RADIUS), picks coins up (checked
// for distance, speed and pace) and banks them at the bank. Banking 20 enters the wallet for the door's Bonus Box;
// the keeper draws 10 winners from the entrants with the door's drand round at settle time. Entries close at the
// door's snapshot time, like the Nice List. After that the day's map is public (GET /village/map/:d) so anyone can see
// where the coins were.
//
// State is one JSON file (sessions per door) plus the entrants file the keeper reads: { "<door>": [wallets] }.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { doorTime, snapshotTime, LAST_DOOR } from "./doors.mjs";

export const COINS = Number(process.env.VILLAGE_COINS ?? 20);
export const REVEAL_RADIUS = Number(process.env.VILLAGE_REVEAL_RADIUS ?? 25); // metres: coins the client is told about
export const PICKUP_RADIUS = Number(process.env.VILLAGE_PICKUP_RADIUS ?? 3); // metres from the coin to take it
export const BANK_RADIUS = Number(process.env.VILLAGE_BANK_RADIUS ?? 6);
export const MAX_SPEED = Number(process.env.VILLAGE_MAX_SPEED ?? 12); // m/s; a sprinting elf is ~8
export const PICKUP_GAP_MS = Number(process.env.VILLAGE_PICKUP_GAP_MS ?? 700); // two coins can't be taken in the same breath
export const MIN_RUN_SECONDS = Number(process.env.VILLAGE_MIN_RUN_SECONDS ?? 90); // nobody finds 20 coins in under this
export const FIRST_VILLAGE_DOOR = Number(process.env.VILLAGE_FIRST_DOOR ?? process.env.FIRST_DOOR ?? 1);

const sha = (...parts) => createHash("sha256").update(parts.join("|")).digest();
const dist = (a, b) => Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0), (a.z ?? 0) - (b.z ?? 0));
const pos = (p) => (p && Number.isFinite(p.x) && Number.isFinite(p.z) ? { x: Number(p.x), y: Number(p.y ?? 0), z: Number(p.z) } : null);

/** The village layout Fish exports: { spawn, bank, spots: [{ id, x, y, z }] }. Without a file: a 200 m square with 64 spots on a jittered grid. */
export function loadLayout(file) {
  if (file && existsSync(file)) {
    const l = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(l.spots) || l.spots.length < COINS) throw new Error(`layout needs at least ${COINS} spots`);
    return { spawn: pos(l.spawn) ?? { x: 0, y: 0, z: 0 }, bank: pos(l.bank) ?? { x: 0, y: 0, z: 0 }, spots: l.spots.map((s, i) => ({ id: String(s.id ?? i), ...pos(s) })) };
  }
  const spots = [];
  for (let i = 0; i < 64; i++) {
    const j = sha("default-layout", i);
    spots.push({ id: `s${i}`, x: -100 + (i % 8) * 28 + (j[0] / 255) * 12, y: 0, z: -100 + Math.floor(i / 8) * 28 + (j[1] / 255) * 12 });
  }
  return { spawn: { x: 0, y: 0, z: 0 }, bank: { x: 0, y: 0, z: 0 }, spots };
}

/** The day's coins: COINS spots picked from the layout by sha256(secret, door). Deterministic; secret per deployment. */
export function dayMap(layout, secret, door) {
  const ranked = layout.spots.map((s) => ({ s, r: sha(secret, door, s.id).toString("hex") })).sort((a, b) => (a.r < b.r ? -1 : 1));
  return ranked.slice(0, COINS).map(({ s }, k) => ({ id: `c${k + 1}`, spot: s.id, x: s.x, y: s.y, z: s.z }));
}

/** The door whose Bonus Box a run started at t counts for: the next door whose entries are still open. */
export function villageDoor(t, { first = FIRST_VILLAGE_DOOR, last = LAST_DOOR } = {}) {
  for (let d = first; d <= last; d++) if (snapshotTime(d) > t) return d;
  return null;
}

export function createVillage({ stateFile, entrantsFile, layoutFile, layout: given, secret, isEligible, now = () => Date.now() / 1000 } = {}) {
  const layout = given ?? loadLayout(layoutFile);
  let state = { secret: null, sessions: {} };
  try { state = { ...state, ...JSON.parse(readFileSync(stateFile, "utf8")) }; } catch { /* first run */ }
  state.secret = secret ?? state.secret ?? randomBytes(32).toString("hex");
  let entrants = {};
  try { entrants = JSON.parse(readFileSync(entrantsFile, "utf8")); } catch { /* none yet */ }
  const atomic = (file, data) => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(data)); renameSync(`${file}.tmp`, file); };
  const save = () => atomic(stateFile, state);
  const maps = new Map();
  const mapFor = (d) => { if (!maps.has(d)) maps.set(d, dayMap(layout, state.secret, d)); return maps.get(d); };
  const byToken = new Map();
  for (const [d, ss] of Object.entries(state.sessions)) for (const [wallet, s] of Object.entries(ss)) byToken.set(s.token, { door: Number(d), wallet, s });

  const nearby = (d, s, p) => mapFor(d).filter((c) => !s.collected.includes(c.id) && dist(c, p) <= REVEAL_RADIUS).map(({ id, x, y, z }) => ({ id, x, y, z }));
  const view = (d, s, p) => ({ door: d, collected: s.collected.length, total: COINS, banked: s.banked, nearby: nearby(d, s, p), closesAt: snapshotTime(d), drawAt: doorTime(d) });
  const lookup = (token) => { const h = token && byToken.get(token); if (!h) return [401, { error: "no such session" }]; if (now() >= snapshotTime(h.door)) return [409, { error: `entries for door ${h.door} closed`, door: h.door, next: villageDoor(now()) }]; return h; };
  /** Moves the player; rejects teleports. Returns the error or null. */
  const move = (s, p, t) => {
    const dt = t - s.last.t, dd = dist(s.last, p);
    if (dt > 0.05 && dd / dt > MAX_SPEED) return `too fast: ${dd.toFixed(1)} m in ${dt.toFixed(2)} s`;
    if (dt <= 0.05 && dd > MAX_SPEED) return `too fast: ${dd.toFixed(1)} m at once`;
    s.last = { ...p, t }; return null;
  };

  return {
    layout, mapFor,
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
        s = { token: randomBytes(24).toString("hex"), startedAt: t, collected: [], banked: false, last: { ...layout.spawn, t }, lastPickupAt: 0, strikes: 0 };
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
    /** Bank the coins at the bank: enters the wallet for the door's Bonus Box. */
    bank(token, p) {
      const h = lookup(token); if (Array.isArray(h)) return h;
      p = pos(p); if (!p) return [400, { error: "pos {x,y,z} required" }];
      const { s, door: d, wallet } = h, t = now();
      const bad = move(s, p, t); if (bad) { s.strikes++; return [422, { error: bad, ...view(d, s, s.last) }]; }
      if (dist(layout.bank, p) > BANK_RADIUS) return [422, { error: `not at the bank: ${dist(layout.bank, p).toFixed(1)} m away`, ...view(d, s, p) }];
      if (s.collected.length < COINS) return [409, { error: `${COINS - s.collected.length} coins still out there`, ...view(d, s, p) }];
      if (t - s.startedAt < MIN_RUN_SECONDS) { s.strikes++; return [422, { error: "that was too quick to be a walk", ...view(d, s, p) }]; }
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
    /** Yesterday's answers: the full coin list once entries have closed. */
    map(d) {
      if (now() < snapshotTime(d)) return [403, { error: "today's map is a secret until entries close", closesAt: snapshotTime(d) }];
      return { door: d, coins: mapFor(d) };
    },
  };
}
