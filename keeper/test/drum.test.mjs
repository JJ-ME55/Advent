import { test } from "node:test";
import assert from "node:assert/strict";
import { weightFor, replay, buildList, canonical, pickWinners, winnerCount, prizes, bonusShares, wordFor, UNIT, MIN_BALANCE } from "../src/drum.mjs";

const H = 3600n, T = 1_800_000_000n;
const seed = "ab".repeat(32);

test("weightFor matches Tombola's rule", () => {
  assert.equal(weightFor(MIN_BALANCE - 1n, 0n, T), 0n, "below the minimum");
  assert.equal(weightFor(MIN_BALANCE, T - 29n * 60n, T), 0n, "held under 30 minutes");
  assert.equal(weightFor(MIN_BALANCE, T - 30n * 60n, T), MIN_BALANCE * (10n ** 18n + (30n * 60n * 2n * 10n ** 18n) / (72n * H)) / 10n ** 18n);
  assert.equal(weightFor(MIN_BALANCE, T - 72n * H, T), 3n * MIN_BALANCE, "3x after 72 hours");
  assert.equal(weightFor(MIN_BALANCE, T - 100n * H, T), 3n * MIN_BALANCE, "capped at 3x");
  assert.equal(weightFor(MIN_BALANCE, T + 1n, T), 0n, "a hold start after the snapshot");
});

const d = (owner, delta, time, slot, i = 0) => ({ owner, delta: BigInt(delta) * UNIT, time, slot, signature: `s${slot}`, index: i });

test("replay: a send resets the clock, a receive into an empty wallet starts it", () => {
  const deltas = [
    d("A", 200_000, 1000, 1), d("B", 150_000, 1000, 1, 1),
    d("A", -50_000, 2000, 2), d("B", 50_000, 2000, 2, 1), // A sends 50k to B
    d("C", 100_000, 3000, 3), d("C", -100_000, 4000, 4), d("C", 100_000, 5000, 5), // C empties and refills
  ];
  const st = replay(deltas, 6000);
  assert.deepEqual(st.get("A"), { balance: 150_000n * UNIT, holdStart: 2000n }, "A's clock reset by the send");
  assert.deepEqual(st.get("B"), { balance: 200_000n * UNIT, holdStart: 1000n }, "B's clock kept by the receive");
  assert.deepEqual(st.get("C"), { balance: 100_000n * UNIT, holdStart: 5000n }, "C's clock restarted after emptying");
  const later = replay(deltas, 2500);
  assert.equal(later.get("C"), undefined, "nothing after the snapshot time counts");
});

test("replay drops excluded wallets after applying their transfers", () => {
  const st = replay([d("CURVE", 1_000_000_000, 1, 1), d("CURVE", -100_000, 2, 2), d("A", 100_000, 2, 2, 1)], 10, { exclude: new Set(["CURVE"]) });
  assert.equal(st.has("CURVE"), false);
  assert.equal(st.get("A").balance, 100_000n * UNIT);
});

test("buildList is canonical and the hash is reproducible", () => {
  const st = new Map([
    ["zz", { balance: 100_000n * UNIT, holdStart: T - 2n * H }],
    ["aa", { balance: 300_000n * UNIT, holdStart: T - 72n * H }],
    ["mm", { balance: 10n * UNIT, holdStart: 0n }], // dust
  ]);
  const { rows, totalWeight } = buildList(st, T);
  assert.deepEqual(rows.map((r) => r.account), ["aa", "zz"]);
  assert.equal(rows[0].cumulativeBefore, 0n);
  assert.equal(rows[1].cumulativeBefore, rows[0].weight);
  assert.equal(totalWeight, rows[0].weight + rows[1].weight);
  const a = canonical({ door: 3, mint: "M", snapshotTime: T, exclude: ["y", "x"] }, rows, totalWeight);
  const b = canonical({ door: 3, mint: "M", snapshotTime: T, exclude: ["x", "y"] }, rows, totalWeight);
  assert.equal(a.hash, b.hash, "exclude order doesn't matter");
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(a.text).rows[0].weight, rows[0].weight.toString());
});

test("buildList refuses an incomplete history", () => {
  assert.throws(() => buildList(new Map([["a", { balance: -1n, holdStart: 0n }]]), T), /incomplete/);
});

test("pickWinners is deterministic, without replacement, and weight-proportional", () => {
  const rows = [
    { account: "a", weight: 100n }, { account: "b", weight: 250n }, { account: "c", weight: 50n }, { account: "d", weight: 600n },
  ];
  const w1 = pickWinners(rows, seed, 7, 3);
  const w2 = pickWinners(rows, seed, 7, 3);
  assert.deepEqual(w1.map((w) => w.account), w2.map((w) => w.account), "same seed, same winners");
  assert.equal(new Set(w1.map((w) => w.account)).size, 3, "no repeats");
  assert.equal(w1[1].totalWeight, 1000n - w1[0].weight, "the pool shrinks by the winner's weight");
  assert.notDeepEqual(pickWinners(rows, seed, 8, 3).map((w) => w.account), w1.map((w) => w.account), "another door, another draw (almost surely)");
  // proportionality over many seeds: d (60%) should win first most often
  let dWins = 0;
  for (let i = 0; i < 400; i++) { const s = i.toString(16).padStart(64, "0"); if (pickWinners(rows, s, 1, 1)[0].account === "d") dWins++; }
  assert.ok(dWins > 200 && dWins < 280, `d won first ${dWins}/400`);
  assert.equal(pickWinners(rows, seed, 1, 10).length, 4, "never more winners than wallets");
});

test("wordFor separates door, pick and tag", () => {
  assert.notEqual(wordFor(seed, 1, 1), wordFor(seed, 1, 2));
  assert.notEqual(wordFor(seed, 1, 1), wordFor(seed, 2, 1));
  assert.notEqual(wordFor(seed, 1, 1), wordFor(seed, 1, 1, "bonus"));
});

test("winnerCount follows the curve, the prize floor and the eligible count", () => {
  const sol = 1_000_000_000n;
  assert.equal(winnerCount(50, 10n * sol, sol / 10n), 1);
  assert.equal(winnerCount(100, 10n * sol, sol / 10n), 2);
  assert.equal(winnerCount(250, 10n * sol, sol / 10n), 5);
  assert.equal(winnerCount(6000, 10n * sol, sol / 10n), 50);
  assert.equal(winnerCount(6000, 1n * sol, sol / 10n), 10, "capped by the floor: 1 SOL / 0.1 SOL");
  assert.equal(winnerCount(3, 10n * sol, sol / 10n), 1, "under 100 holders: one winner");
  assert.equal(winnerCount(0, 10n * sol, sol / 10n), 0);
  assert.equal(winnerCount(100, 0n, sol / 10n), 0, "no pot, no draw");
  assert.equal(winnerCount(1, sol / 100n, sol / 10n), 1, "a tiny pot still pays one");
});

test("prizes: grand takes 40%, the rest equal, every lamport paid", () => {
  assert.deepEqual(prizes(1000n, 1), [1000n]);
  const p = prizes(1001n, 5);
  assert.equal(p.length, 5);
  assert.equal(p.reduce((a, b) => a + b, 0n), 1001n);
  assert.equal(p[1], p[4]);
  assert.ok(p[0] >= 400n);
  assert.deepEqual(prizes(0n, 3), []);
});

test("bonusShares: n shares, deterministic, sums to the pot", () => {
  const s = bonusShares(10_000n, 10, seed, 4);
  assert.equal(s.length, 10);
  assert.equal(s.reduce((a, b) => a + b, 0n), 10_000n);
  assert.deepEqual(s, bonusShares(10_000n, 10, seed, 4));
  assert.ok(new Set(s.map(String)).size > 1, "shares vary");
  assert.ok(s.every((x) => x >= 10_000n / 30n), "no share under a third of an even split");
});
