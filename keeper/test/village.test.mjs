import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// a three-door calendar under our control: door 0 at T, door 1 a day later, door 2 a day after that
const T = 1_900_000_000;
process.env.DOOR_TIMES = JSON.stringify({ 0: T, 1: T + 86400, 2: T + 2 * 86400 });
process.env.FIRST_DOOR = "1"; process.env.LAST_DOOR = "2";
const { createVillage, dayMap, dayJobs, loadLayout, villageDoor, COINS, JOB_COINS, JOB_REWARDS, MAX_SPEED, MIN_RUN_SECONDS, PICKUP_RADIUS, REVEAL_RADIUS, CHASE_MIN_SECONDS, BRAWL_MIN_SECONDS } = await import("../src/village.mjs");
const { snapshotTime } = await import("../src/doors.mjs");

const layout = loadLayout();
const d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const fresh = (t0, eligible = () => ({ inDrum: true }), lay) => {
  const dir = mkdtempSync(join(tmpdir(), "advent-village-"));
  const clock = { t: t0 };
  const v = createVillage({ stateFile: join(dir, "village.json"), entrantsFile: join(dir, "entrants.json"), layout: lay, secret: "test-secret", isEligible: eligible, now: () => clock.t });
  return { v, clock, dir };
};
/** A player: walks at `speed` m/s (the clock advances with the distance) and keeps its position. */
function player(v, token, clock, from, speed = 8) {
  const me = { at: { ...from } };
  me.walk = (p) => { clock.t += Math.max(0.5, d2(me.at, p) / speed); me.at = { x: p.x, y: 0, z: p.z }; const r = v.move(token, me.at); assert.ok(!Array.isArray(r), `move: ${JSON.stringify(r)}`); return r; };
  me.wait = (s) => { clock.t += s; return v.move(token, me.at); };
  return me;
}
/** Picks up every hidden coin (optionally all but the last n). */
function collect(v, token, clock, me, skip = 0) {
  const coins = v.mapFor(1).slice(0, COINS - skip);
  for (const c of coins) { me.walk(c); const r = v.pickup(token, c.id, me.at); assert.ok(!Array.isArray(r), `pickup ${c.id}: ${JSON.stringify(r)}`); }
}
/** Does job `job` honestly. */
function doJob(v, token, clock, me, job) {
  me.walk(job.giver);
  const st = v.jobStart(token, job.id, me.at); assert.equal(st.ok, true, `start ${job.id}: ${JSON.stringify(st)}`);
  if (job.type === "taxi") { me.walk(job.targets[0]); me.walk(job.targets[1]); }
  if (job.type === "delivery") { me.walk(v.layout.bank); for (const door of job.targets) me.walk(door); }
  if (job.type === "chase") { me.wait(CHASE_MIN_SECONDS + 5); const ring = v.layout.ringRoad; me.walk({ x: ring.x + ring.r, z: ring.z }); }
  if (job.type === "brawl") { me.wait(BRAWL_MIN_SECONDS + 5); me.walk({ x: job.giver.x + 3, z: job.giver.z }); }
  const fin = v.jobFinish(token, job.id, me.at); assert.equal(fin.ok, true, `finish ${job.id}: ${JSON.stringify(fin)}`);
  return fin;
}
const jobOf = (v, type) => v.jobsFor(1).find((j) => j.type === type);
/** A layout where the day's jobs are exactly the three given types (tries door numbers until the seed picks them; the test then runs on that door). */
const typesOn = (d) => dayJobs(layout, d).map((j) => j.type);

test("the day's map is secret-dependent, differs per door and uses real spots", () => {
  const a = dayMap(layout, "s1", 1), b = dayMap(layout, "s1", 2), c = dayMap(layout, "s2", 1);
  assert.equal(a.length, COINS); assert.equal(COINS, 10);
  assert.equal(new Set(a.map((x) => x.spot)).size, COINS, "10 distinct spots");
  assert.notDeepEqual(a.map((x) => x.spot), b.map((x) => x.spot), "door 2 hides them elsewhere");
  assert.notDeepEqual(a.map((x) => x.spot), c.map((x) => x.spot), "another secret, another map");
  assert.deepEqual(a, dayMap(layout, "s1", 1), "deterministic");
});

test("the day's jobs come from the door number: three of four types, 3+3+4, with points from the layout", () => {
  const j1 = dayJobs(layout, 1);
  assert.equal(j1.length, 3);
  assert.deepEqual(j1.map((j) => j.reward), JOB_REWARDS);
  assert.equal(new Set(j1.map((j) => j.type)).size, 3, "three different jobs");
  assert.deepEqual(j1, dayJobs(layout, 1), "the same for everyone");
  const seen = new Set(); for (let d = 1; d <= 25; d++) for (const j of dayJobs(layout, d)) seen.add(j.type);
  assert.equal(seen.size, 4, "over the month every type shows up");
  for (const j of j1) {
    assert.equal(j.id, `1-${j.type}`); assert.ok(Number.isFinite(j.giver.x) && Number.isFinite(j.giver.z));
    if (j.type === "taxi") { assert.equal(j.targets.length, 2); assert.equal(j.timerSeconds, Math.round(d2(j.targets[0], j.targets[1]) / 9 + 35)); assert.ok(j.targets[0].name); }
    if (j.type === "delivery") { assert.equal(j.targets.length, 3); assert.equal(j.timerSeconds, 170); }
    if (j.type === "chase") { assert.equal(j.timerSeconds, 240); assert.equal(j.targets[0].r, layout.ringRoad.r); }
    if (j.type === "brawl") assert.equal(j.timerSeconds, null);
  }
});

test("villageDoor: runs count for the next door whose entries are open", () => {
  assert.equal(villageDoor(T + 10), 1);
  assert.equal(villageDoor(snapshotTime(1) - 1), 1);
  assert.equal(villageDoor(snapshotTime(1)), 2, "at the snapshot the day's box closes and the next opens");
  assert.equal(villageDoor(T + 3 * 86400), null);
});

test("a session needs a holder on the Nice List, is one per wallet per door, isn't open before the previous door, and carries the jobs", () => {
  const { v, clock } = fresh(T - 100);
  assert.equal(v.session("W")[0], 503, "door 1's village opens when door 0 does");
  clock.t = T + 10;
  const { v: v2 } = fresh(T + 10, () => ({ inDrum: false, reason: "no balance" }));
  assert.equal(v2.session("W")[0], 403);
  const s = v.session("W");
  assert.equal(s.door, 1); assert.equal(s.found, 0); assert.equal(s.collected, 0); assert.equal(s.total, COINS); assert.equal(s.jobCoins, 0); assert.equal(s.jobTotal, JOB_COINS); assert.equal(s.resumed, false);
  assert.equal(s.jobs.length, 3); assert.ok(s.jobs.every((j) => j.done === false));
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
  assert.equal(ok.picked, c.id); assert.equal(ok.found, 1);
  assert.ok(!ok.nearby.some((n) => n.id === c.id), "a taken coin is gone");
  clock.t += 1;
  assert.equal(v.pickup(token, c.id, { x: c.x, y: 0, z: c.z })[0], 409, "not twice");
  assert.equal(v.pickup("nope", c.id, { x: 0, y: 0, z: 0 })[0], 401);
});

test("a move at 21 m/s is accepted, one at 30 m/s is rejected; pickups keep the 3 m check", () => {
  assert.equal(MAX_SPEED, 22);
  const { v, clock } = fresh(T + 10);
  const { token } = v.session("W");
  clock.t += 10; assert.ok(!Array.isArray(v.move(token, { x: 0, y: 0, z: 0 })));
  clock.t += 10; assert.ok(!Array.isArray(v.move(token, { x: 210, y: 0, z: 0 })), "210 m in 10 s: a sled");
  clock.t += 10; const r = v.move(token, { x: 510, y: 0, z: 0 });
  assert.equal(r[0], 422); assert.match(r[1].error, /too fast/);
  assert.equal(v.move(token, { x: 210, y: 0, z: 0 }).door, 1, "the player is still where the last good move left them");
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

test("a full day: 10 hidden coins and 3 jobs, then bank at the Post Office, then entered", () => {
  const { v, clock, dir } = fresh(T + 10);
  const { token, bank } = v.session("W");
  const me = player(v, token, clock, layout.spawn);
  collect(v, token, clock, me);
  assert.equal(v.move(token, me.at).found, COINS);
  let coins = 0;
  for (const job of v.jobsFor(1)) { const r = doJob(v, token, clock, me, job); coins += job.reward; assert.equal(r.jobCoins, Math.min(coins, JOB_COINS)); assert.ok(r.jobsDone.includes(job.id)); }
  assert.equal(v.move(token, me.at).jobCoins, JOB_COINS);
  assert.ok(v.move(token, me.at).jobs.every((j) => j.done));
  me.walk({ x: bank.x + 100, z: bank.z });
  assert.equal(v.bank(token, me.at)[0], 422, "not at the Post Office");
  me.walk(bank);
  if (clock.t - T - 10 < MIN_RUN_SECONDS) clock.t = T + 10 + MIN_RUN_SECONDS;
  const r = v.bank(token, me.at);
  assert.equal(r.entered, true); assert.equal(r.entrants, 1); assert.equal(r.banked, true);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "entrants.json"), "utf8")), { 1: ["W"] });
  assert.deepEqual(v.entrantsOf(1), ["W"]);
  assert.equal(v.bank(token, me.at).entrants, 1, "idempotent");
  assert.equal(v.status(1).phase, "open");
  assert.equal(v.map(1)[0], 403, "the map stays secret while entries are open");
  assert.equal(v.map(1)[1].jobs.length, 3, "but the jobs are public");
  clock.t = snapshotTime(1);
  assert.equal(v.move(token, bank)[0], 409, "entries closed");
  assert.equal(v.status(1).phase, "closed");
  assert.equal(v.map(1).coins.length, COINS, "then it's public");
  assert.equal(v.session("W")[0], 503, "between the snapshot and the door nobody plays");
  clock.t = T + 86400 + 1;
  assert.equal(v.session("W").door, 2, "and the next day's run starts when the door opens");
  // a reload sees the same sessions, secret, jobs and entrants
  const v2 = createVillage({ stateFile: join(dir, "village.json"), entrantsFile: join(dir, "entrants.json"), isEligible: () => ({ inDrum: true }), now: () => clock.t });
  assert.deepEqual(v2.entrantsOf(1), ["W"]);
  assert.deepEqual(v2.mapFor(1), v.mapFor(1), "the secret survives a restart");
  assert.equal(v2.session("W").door, 2);
});

test("bank refused with 9 hidden coins, or with the jobs short (6 of 10 job coins)", () => {
  // nine coins, all jobs
  let { v, clock } = fresh(T + 10);
  let { token, bank } = v.session("W");
  let me = player(v, token, clock, layout.spawn);
  collect(v, token, clock, me, 1);
  for (const job of v.jobsFor(1)) doJob(v, token, clock, me, job);
  me.walk(bank); clock.t = T + 10 + MIN_RUN_SECONDS + 1;
  let r = v.bank(token, me.at);
  assert.equal(r[0], 409); assert.equal(r[1].reason, "not-enough"); assert.equal(r[1].found, 9); assert.equal(r[1].jobCoins, 10);
  // all coins, two jobs (the 3 and the 3: 6 job coins; 9 isn't reachable with rewards of 3, 3 and 4)
  ({ v, clock } = fresh(T + 10)); ({ token, bank } = v.session("W"));
  me = player(v, token, clock, layout.spawn);
  collect(v, token, clock, me);
  const [j1, j2] = v.jobsFor(1); doJob(v, token, clock, me, j1); doJob(v, token, clock, me, j2);
  me.walk(bank); clock.t = T + 10 + MIN_RUN_SECONDS + 1;
  r = v.bank(token, me.at);
  assert.equal(r[0], 409); assert.equal(r[1].reason, "not-enough"); assert.equal(r[1].found, 10); assert.equal(r[1].jobCoins, 6);
});

test("a taxi finished faster than physically possible is rejected, and can be started again", () => {
  // a door whose jobs include the taxi
  const d = [1, 2].find((n) => typesOn(n).includes("taxi")) ?? 1;
  const t0 = d === 1 ? T + 10 : T + 86400 + 10;
  const { v, clock } = fresh(t0);
  const { token } = v.session("W");
  const job = v.jobsFor(d).find((j) => j.type === "taxi");
  assert.ok(job, `door ${d} has a taxi (${typesOn(1)}, ${typesOn(2)})`);
  const me = player(v, token, clock, layout.spawn);
  me.walk(job.giver);
  assert.equal(v.jobStart(token, job.id, me.at).ok, true);
  const [A, B] = job.targets;
  me.walk(A);
  // the drop-off arrives sooner than the distance allows at MAX_SPEED
  clock.t += d2(A, B) / MAX_SPEED / 2;
  const r = v.jobFinish(token, job.id, { x: B.x, y: 0, z: B.z });
  assert.equal(r[0], 422); assert.equal(r[1].ok, false); assert.equal(r[1].reason, "too-fast");
  assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "not-started", "a failed job is cleared");
  // the honest way, from where the player really is
  me.walk(job.giver);
  assert.equal(v.jobStart(token, job.id, me.at).ok, true, "started again");
  me.walk(A); me.walk(B);
  const ok = v.jobFinish(token, job.id, me.at);
  assert.equal(ok.ok, true); assert.equal(ok.jobCoins, job.reward);
  // and from the giver, not from wherever
  assert.equal(v.jobStart(token, v.jobsFor(d).find((j) => j.type !== "taxi").id, me.at)[1].reason, "not-at-giver");
});

test("a job counts only once, and the other jobs are judged too", () => {
  const { v, clock } = fresh(T + 10);
  const { token } = v.session("W");
  const me = player(v, token, clock, layout.spawn);
  const [job] = v.jobsFor(1);
  const first = doJob(v, token, clock, me, job);
  assert.equal(first.jobCoins, job.reward);
  me.walk(job.giver);
  const again = v.jobStart(token, job.id, me.at);
  assert.equal(again[0], 409); assert.equal(again[1].reason, "already-done");
  const fin = v.jobFinish(token, job.id, me.at);
  assert.equal(fin[0], 409); assert.equal(fin[1].reason, "already-done"); assert.equal(fin[1].jobCoins, job.reward, "no second helping");
  assert.equal(v.jobFinish(token, "1-nothing", me.at)[0], 404);
  // the other two, done wrong then right
  for (const j of v.jobsFor(1).slice(1)) {
    me.walk(j.giver); assert.equal(v.jobStart(token, j.id, me.at).ok, true);
    clock.t += 1;
    const quick = v.jobFinish(token, j.id, me.at);
    assert.equal(quick[0], 422, `${j.type} straight away: ${JSON.stringify(quick)}`);
    assert.ok(["no-pickup", "no-dropoff", "no-sack", "doors-missed", "too-quick", "not-on-ring"].includes(quick[1].reason), quick[1].reason);
    doJob(v, token, clock, me, j);
  }
  assert.equal(v.move(token, me.at).jobCoins, JOB_COINS);
});

test("delivery needs the sack first and all three doors in time; brawl fails if the player wanders off", () => {
  const dDel = [1, 2].find((n) => typesOn(n).includes("delivery")), dBr = [1, 2].find((n) => typesOn(n).includes("brawl"));
  if (dDel) {
    const { v, clock } = fresh(dDel === 1 ? T + 10 : T + 86400 + 10);
    const { token } = v.session("W"); const me = player(v, token, clock, layout.spawn);
    const job = v.jobsFor(dDel).find((j) => j.type === "delivery");
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    for (const door of job.targets) me.walk(door); // doors before the sack don't count
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "no-sack");
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    me.walk(v.layout.bank); me.walk(job.targets[0]); me.walk(job.targets[1]);
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "doors-missed");
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    me.walk(v.layout.bank); me.walk(job.targets[0]); me.wait(200); me.walk(job.targets[1]); me.walk(job.targets[2]);
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "timeout");
    doJob(v, token, clock, me, job);
  }
  if (dBr) {
    const { v, clock } = fresh(dBr === 1 ? T + 10 : T + 86400 + 10);
    const { token } = v.session("W"); const me = player(v, token, clock, layout.spawn);
    const job = v.jobsFor(dBr).find((j) => j.type === "brawl");
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    me.walk({ x: job.giver.x + 60, z: job.giver.z }); me.wait(30); me.walk(job.giver);
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "left-area");
    doJob(v, token, clock, me, job);
  }
  const dCh = [1, 2].find((n) => typesOn(n).includes("chase"));
  if (dCh) {
    const { v, clock } = fresh(dCh === 1 ? T + 10 : T + 86400 + 10);
    const { token } = v.session("W"); const me = player(v, token, clock, layout.spawn);
    const job = v.jobsFor(dCh).find((j) => j.type === "chase"), ring = v.layout.ringRoad;
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    me.wait(5); me.walk({ x: ring.x + ring.r, z: ring.z });
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "too-quick");
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    me.wait(30); me.walk({ x: ring.x, z: ring.z });
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "not-on-ring", "caught it in the village square?");
    me.walk(job.giver); v.jobStart(token, job.id, me.at);
    me.wait(250); me.walk({ x: ring.x + ring.r, z: ring.z });
    assert.equal(v.jobFinish(token, job.id, me.at)[1].reason, "timeout");
    doJob(v, token, clock, me, job);
  }
  assert.ok(dDel && dBr && dCh, "doors 1 and 2 between them cover delivery, brawl and chase");
});

test("a run that finishes implausibly fast is not entered", () => {
  // a toy village where every spot and job point is within a stride of the Post Office, so the whole day takes seconds
  const tiny = { spawn: { x: 0, y: 0, z: 0 }, bank: { x: 0, y: 0, z: 0 }, spots: Array.from({ length: 24 }, (_, i) => ({ id: `t${i}`, x: (i % 6) * 1.5, y: 0, z: Math.floor(i / 6) * 1.5 })),
    givers: { taxi: { x: 2, z: 2 }, delivery: { x: 2, z: 2 }, chase: { x: 2, z: 2 }, brawl: { x: 2, z: 2 } }, taxiPoints: [{ name: "A", x: 0, z: 4 }, { name: "B", x: 4, z: 0 }, { name: "C", x: 4, z: 4 }], deliveryDoors: [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: 1, z: 1 }], ringRoad: { r: 3, width: 8, x: 0, z: 0 } };
  const { v, clock } = fresh(T + 10, undefined, tiny);
  const { token } = v.session("W");
  const me = player(v, token, clock, tiny.spawn, 2);
  for (const c of v.mapFor(1)) { me.walk(c); assert.ok(!Array.isArray(v.pickup(token, c.id, me.at)), "a stride apart is a legal pickup"); }
  for (const job of v.jobsFor(1)) doJob(v, token, clock, me, job);
  me.walk(tiny.bank);
  assert.ok(clock.t - (T + 10) < MIN_RUN_SECONDS, `the day took ${(clock.t - T - 10).toFixed(0)} s`);
  const r = v.bank(token, me.at);
  assert.equal(r[0], 422); assert.equal(r[1].reason, "too-quick");
  clock.t = T + 10 + MIN_RUN_SECONDS;
  assert.equal(v.bank(token, me.at).entered, true, "five minutes in, it counts");
});
