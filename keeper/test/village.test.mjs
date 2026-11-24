import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// a three-door calendar under our control: door 0 at T, door 1 a day later, door 2 a day after that
const T = 1_900_000_000;
process.env.DOOR_TIMES = JSON.stringify({ 0: T, 1: T + 86400, 2: T + 2 * 86400 });
process.env.FIRST_DOOR = "1"; process.env.LAST_DOOR = "2";
process.env.VILLAGE_MIN_RUN_SECONDS = "90";
const { createVillage, dayMap, loadLayout, villageDoor, COINS, PICKUP_RADIUS, REVEAL_RADIUS } = await import("../src/village.mjs");
const { snapshotTime } = await import("../src/doors.mjs");

const layout = loadLayout();
const fresh = (t0, eligible = () => ({ inDrum: true })) => {
  const dir = mkdtempSync(join(tmpdir(), "advent-village-"));
  const clock = { t: t0 };
  const v = createVillage({ stateFile: join(dir, "village.json"), entrantsFile: join(dir, "entrants.json"), secret: "test-secret", isEligible: eligible, now: () => clock.t });
  return { v, clock, dir };
};
/** Walk the session to every coin at a legal pace and pick it up. */
function collectAll(v, token, clock, from) {
  const coins = v.mapFor(1);
  let at = from;
  for (const c of coins) {
    clock.t += Math.max(1, Math.hypot(c.x - at.x, c.z - at.z) / 5); // 5 m/s
    const r = v.pickup(token, c.id, { x: c.x, y: 0, z: c.z });
    assert.ok(!Array.isArray(r), `pickup ${c.id}: ${JSON.stringify(r)}`);
    at = c;
  }
  return at;
}

test("the day's map is secret-dependent, differs per door and uses real spots", () => {
  const a = dayMap(layout, "s1", 1), b = dayMap(layout, "s1", 2), c = dayMap(layout, "s2", 1);
  assert.equal(a.length, COINS);
  assert.equal(new Set(a.map((x) => x.spot)).size, COINS, "20 distinct spots");
  assert.notDeepEqual(a.map((x) => x.spot), b.map((x) => x.spot), "door 2 hides them elsewhere");
  assert.notDeepEqual(a.map((x) => x.spot), c.map((x) => x.spot), "another secret, another map");
  assert.deepEqual(a, dayMap(layout, "s1", 1), "deterministic");
});

test("villageDoor: runs count for the next door whose entries are open", () => {
  assert.equal(villageDoor(T + 10), 1);
  assert.equal(villageDoor(snapshotTime(1) - 1), 1);
  assert.equal(villageDoor(snapshotTime(1)), 2, "at the snapshot the day's box closes and the next opens");
  assert.equal(villageDoor(T + 3 * 86400), null);
});

test("a session needs a holder in the drum, is one per wallet per door, and isn't open before the previous door", () => {
  const { v, clock } = fresh(T - 100);
  assert.equal(v.session("W")[0], 503, "door 1's village opens when door 0 does");
  clock.t = T + 10;
  const { v: v2 } = fresh(T + 10, () => ({ inDrum: false, reason: "no balance" }));
  assert.equal(v2.session("W")[0], 403);
  const s = v.session("W");
  assert.equal(s.door, 1); assert.equal(s.collected, 0); assert.equal(s.total, COINS); assert.equal(s.resumed, false);
  assert.equal(v.session("W").token, s.token, "the same run again");
  assert.equal(v.session("W").resumed, true);
  assert.notEqual(v.session("V").token, s.token);
});

test("coins are revealed near the player only, picked up only close by, and never twice", () => {
  const { v, clock } = fresh(T + 10);
  const { token } = v.session("W");
  const c = v.mapFor(1)[0];
  clock.t += 60;
  const far = v.move(token, { x: c.x + REVEAL_RADIUS + 50, y: 0, z: c.z });
  assert.ok(!far.nearby.some((n) => n.id === c.id), "not revealed from far away");
  clock.t += 30;
  const near = v.move(token, { x: c.x + 5, y: 0, z: c.z });
  assert.ok(near.nearby.some((n) => n.id === c.id), "revealed close by");
  assert.equal(v.pickup(token, c.id, { x: c.x + PICKUP_RADIUS + 1, y: 0, z: c.z })[0], 422, "too far");
  clock.t += 1;
  assert.equal(v.pickup(token, "c99", { x: c.x, y: 0, z: c.z })[0], 404);
  const ok = v.pickup(token, c.id, { x: c.x, y: 0, z: c.z });
  assert.equal(ok.picked, c.id); assert.equal(ok.collected, 1);
  assert.ok(!ok.nearby.some((n) => n.id === c.id), "a taken coin is gone");
  clock.t += 1;
  assert.equal(v.pickup(token, c.id, { x: c.x, y: 0, z: c.z })[0], 409, "not twice");
  assert.equal(v.pickup("nope", c.id, { x: 0, y: 0, z: 0 })[0], 401);
});

test("teleports and machine-gun pickups are refused", () => {
  const { v, clock } = fresh(T + 10);
  const { token } = v.session("W");
  const [a, b] = v.mapFor(1);
  clock.t += 100;
  assert.equal(v.pickup(token, a.id, { x: a.x, y: 0, z: a.z })[0] ?? 200, 200);
  // b is tens of metres away; 0.2 s later is a teleport
  clock.t += 0.2;
  const r = v.pickup(token, b.id, { x: b.x, y: 0, z: b.z });
  assert.equal(r[0], 422); assert.match(r[1].error, /too fast/);
  // in a toy village two coins a stride apart: the second can't be taken 0.3 s after the first
  const tiny = { spawn: { x: 0, y: 0, z: 0 }, bank: { x: 0, y: 0, z: 0 }, spots: Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, x: (i % 6) * 1.5, y: 0, z: Math.floor(i / 6) * 1.5 })) };
  const s = { clock: { t: T + 10 } };
  s.v = createVillage({ stateFile: join(mkdtempSync(join(tmpdir(), "advent-village-")), "v.json"), entrantsFile: join(tmpdir(), "unused-entrants.json"), layout: tiny, secret: "s", isEligible: () => ({ inDrum: true }), now: () => s.clock.t });
  const t2 = s.v.session("X").token; const [p] = s.v.mapFor(1);
  const q = s.v.mapFor(1).slice(1).sort((m, n) => Math.hypot(m.x - p.x, m.z - p.z) - Math.hypot(n.x - p.x, n.z - p.z))[0]; // the nearest other coin
  s.clock.t += 5; assert.ok(!Array.isArray(s.v.pickup(t2, p.id, p)));
  s.clock.t += 0.3; assert.equal(s.v.pickup(t2, q.id, q)[0], 429);
  s.clock.t += 1; assert.ok(!Array.isArray(s.v.pickup(t2, q.id, q)), "a second later, fine");
  clock.t += Math.hypot(b.x - a.x, b.z - a.z) / 5;
  assert.ok(!Array.isArray(v.pickup(token, b.id, { x: b.x, y: 0, z: b.z })), "legal pace, taken");
});

test("banking 20 at the bank enters the wallet; the file is what the keeper reads; entries close at the snapshot", () => {
  const { v, clock, dir } = fresh(T + 10);
  const { token, bank } = v.session("W");
  clock.t += 1;
  assert.equal(v.bank(token, bank)[0], 409, "nothing to bank yet");
  const at = collectAll(v, token, clock, layout.spawn);
  clock.t += 30;
  assert.equal(v.bank(token, { x: at.x + 100, y: 0, z: at.z })[0], 422, "not at the bank");
  clock.t += Math.hypot(bank.x - at.x, bank.z - at.z) / 5 + 1;
  const r = v.bank(token, bank);
  assert.equal(r.entered, true); assert.equal(r.entrants, 1); assert.equal(r.banked, true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "entrants.json"), "utf8")), { 1: ["W"] });
  assert.deepEqual(v.entrantsOf(1), ["W"]);
  assert.equal(v.bank(token, bank).entrants, 1, "idempotent");
  assert.equal(v.status(1).phase, "open");
  assert.equal(v.map(1)[0], 403, "the map stays secret while entries are open");
  clock.t = snapshotTime(1);
  assert.equal(v.move(token, bank)[0], 409, "entries closed");
  assert.equal(v.status(1).phase, "closed");
  assert.equal(v.map(1).coins.length, COINS, "then it's public");
  assert.equal(v.session("W")[0], 503, "between the snapshot and the door nobody plays");
  clock.t = T + 86400 + 1;
  assert.equal(v.session("W").door, 2, "and the next day's run starts when the door opens");
  // a reload sees the same sessions, secret and entrants
  const v2 = createVillage({ stateFile: join(dir, "village.json"), entrantsFile: join(dir, "entrants.json"), isEligible: () => ({ inDrum: true }), now: () => clock.t });
  assert.deepEqual(v2.entrantsOf(1), ["W"]);
  assert.deepEqual(v2.mapFor(1), v.mapFor(1), "the secret survives a restart");
});

test("a run that finishes implausibly fast is not entered", () => {
  // a toy village where every spot is within a stride of the bank, so the walk itself takes seconds
  const tiny = { spawn: { x: 0, y: 0, z: 0 }, bank: { x: 0, y: 0, z: 0 }, spots: Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, x: (i % 6) * 1.5, y: 0, z: Math.floor(i / 6) * 1.5 })) };
  const dir = mkdtempSync(join(tmpdir(), "advent-village-"));
  const clock = { t: T + 10 };
  const v = createVillage({ stateFile: join(dir, "v.json"), entrantsFile: join(dir, "e.json"), layout: tiny, secret: "s", isEligible: () => ({ inDrum: true }), now: () => clock.t });
  const { token } = v.session("W");
  for (const c of v.mapFor(1)) { clock.t += 1; assert.ok(!Array.isArray(v.pickup(token, c.id, c)), "a stride apart is a legal pickup"); }
  clock.t += 1;
  const r = v.bank(token, tiny.bank);
  assert.equal(r[0], 422); assert.match(r[1].error, /too quick/);
  clock.t += 90;
  assert.equal(v.bank(token, tiny.bank).entered, true, "a minute and a half later it counts");
});
