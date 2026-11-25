import { test } from "node:test";
import assert from "node:assert/strict";
import { snapshot, commit, settle } from "../src/draw.mjs";
import { doorTime, snapshotTime, doorRound, doorRoundTime, nextDoor, isSnapshotDue, isSettleDue } from "../src/doors.mjs";
import { roundTime, roundAt, seedOf } from "../src/drand.mjs";
import { parseCommit, commitMemo } from "../src/solana.mjs";
import { UNIT, pickWinners, prizes } from "../src/drum.mjs";

const SIG = "0f".repeat(64); // a stand-in signature: only its hash matters to the draw
const cfg = { mint: "MINT", exclude: ["CURVE", "TEAM"], doorWallet: "DOOR", reserveLamports: 50_000_000n, floorLamports: 100_000_000n };

function fakeChain(deltas, { now, balance = 10n * 10n ** 9n } = {}) {
  const sent = [];
  return {
    sent,
    now: () => now,
    deltas: async () => deltas,
    balance: async () => balance,
    sendMemo: async (text) => { sent.push({ memo: text }); return { signature: `memo${sent.length}`, slot: 1, blockTime: now }; },
    sendSol: async (to, lamports, memo) => { sent.push({ to, lamports, memo }); return { signature: `pay${sent.length}`, slot: 2, blockTime: now + 1 }; },
  };
}

test("doors: times, rounds and due windows", () => {
  const d1 = doorTime(1);
  assert.equal(new Date(d1 * 1000).toISOString(), "2026-12-01T18:00:00.000Z");
  assert.equal(snapshotTime(1), d1 - 600);
  assert.equal(doorRoundTime(1) >= d1 && doorRoundTime(1) < d1 + 3, true, "the round lands at the door within drand's period");
  assert.equal(doorRound(1), roundAt(d1));
  assert.equal(Number(roundTime(roundAt(d1))) >= d1, true);
  assert.equal(doorTime(0), doorTime(1) - 86400, "door 0 is 30 November (a warm-up door)");
  assert.equal(nextDoor(d1 - 1), 1);
  assert.equal(nextDoor(d1), 2);
  assert.equal(nextDoor(doorTime(25)), null);
  assert.equal(isSnapshotDue(1, d1 - 600), true);
  assert.equal(isSnapshotDue(1, d1 - 601), false);
  assert.equal(isSnapshotDue(1, d1 - 30), false, "inside the commit margin: too late");
  assert.equal(isSettleDue(1, doorRoundTime(1) + 2), true);
  assert.equal(isSettleDue(1, doorRoundTime(1)), false);
});

test("a door end to end: snapshot, commit, settle (pays nothing), and the result recomputes", async () => {
  const t0 = snapshotTime(3);
  const deltas = [
    { owner: "CURVE", delta: 1_000_000_000n * UNIT, time: t0 - 90_000, slot: 1, signature: "mint", index: 0 },
    { owner: "CURVE", delta: -300_000n * UNIT, time: t0 - 80_000, slot: 2, signature: "b1", index: 0 }, { owner: "alice", delta: 300_000n * UNIT, time: t0 - 80_000, slot: 2, signature: "b1", index: 1 },
    { owner: "CURVE", delta: -100_000n * UNIT, time: t0 - 3600, slot: 3, signature: "b2", index: 0 }, { owner: "bob", delta: 100_000n * UNIT, time: t0 - 3600, slot: 3, signature: "b2", index: 1 },
    { owner: "CURVE", delta: -100_000n * UNIT, time: t0 - 60, slot: 4, signature: "b3", index: 0 }, { owner: "late", delta: 100_000n * UNIT, time: t0 - 60, slot: 4, signature: "b3", index: 1 },
    { owner: "CURVE", delta: -500_000n * UNIT, time: t0 - 50_000, slot: 5, signature: "b4", index: 0 }, { owner: "TEAM", delta: 500_000n * UNIT, time: t0 - 50_000, slot: 5, signature: "b4", index: 1 },
    { owner: "CURVE", delta: -1_000n * UNIT, time: t0 - 50_000, slot: 6, signature: "b5", index: 0 }, { owner: "dust", delta: 1_000n * UNIT, time: t0 - 50_000, slot: 6, signature: "b5", index: 1 },
  ];
  const chain = fakeChain(deltas, { now: t0 + 5 });
  const snap = await snapshot(chain, cfg, 3);
  assert.deepEqual(snap.rows.map((r) => r.account), ["alice", "bob"], "late (under 30 min), dust, the curve and the team are out");
  assert.equal(snap.pot, 10n * 10n ** 9n - cfg.reserveLamports);
  assert.equal(snap.winners, 1, "2 eligible holders: one winner");
  assert.equal(snap.round, doorRound(3));

  const c = await commit(chain, snap);
  const parsed = parseCommit(c.memo);
  assert.deepEqual(parsed, { door: 3, hash: snap.hash, round: snap.round, total: snap.totalWeight, winners: 1 });
  assert.equal(c.memo, commitMemo({ door: 3, hash: snap.hash, round: snap.round, total: snap.totalWeight, winners: 1 }));

  // too late to commit once inside the margin
  const lateChain = fakeChain(deltas, { now: doorRoundTime(3) - 10 });
  await assert.rejects(commit(lateChain, snap), /too late/);

  // the round isn't out yet
  const pending = await settle(chain, cfg, snap, { fetchSignature: async () => null });
  assert.equal(pending.status, "unpublished");

  const res = await settle(chain, cfg, snap, { fetchSignature: async () => SIG, bonusEntrants: ["bob", "alice", "bob"], bonusPotLamports: 1_000_000_000n });
  assert.equal(res.status, "settled");
  assert.equal(res.seed, seedOf(SIG));
  assert.equal(res.winners.length, 1);
  assert.equal(res.winners[0].lamports, snap.pot, "one winner takes the whole door");
  const expected = pickWinners(snap.rows, seedOf(SIG), 3, 1)[0];
  assert.equal(res.winners[0].account, expected.account, "anyone recomputes the winner from the list and the seed");
  assert.deepEqual(prizes(snap.pot, 1), [snap.pot]);
  assert.equal(res.winners[0].memo, `ADVENT door door=3 winner=1/1 hash=${snap.hash}`, "the memo the claim will carry");
  assert.equal(res.bonus.length, 2, "two distinct entrants, two bonus winners");
  assert.equal(res.bonus.reduce((a, b) => a + b.lamports, 0n), 1_000_000_000n, "the whole bonus pot is allotted");
  assert.ok(res.bonus.every((b) => /^ADVENT bonus door=3 winner=\d\/2/.test(b.memo)));
  // it's an advent calendar: settle fixes the winners and sends nothing; they're paid when they open and claim
  assert.deepEqual(chain.sent.filter((s) => s.to), [], "settle sends nothing");
  assert.equal(chain.sent.length, 1, "the only transaction so far is the commit memo");
});

test("snapshot refuses a history that leaves a wallet negative", async () => {
  const t0 = snapshotTime(2);
  const chain = fakeChain([{ owner: "x", delta: -5n * UNIT, time: t0 - 10, slot: 1, signature: "s", index: 0 }], { now: t0 });
  await assert.rejects(snapshot(chain, cfg, 2), /incomplete/);
});
