import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaims } from "../src/claims.mjs";
import { doorTime } from "../src/doors.mjs";

function setup({ pay, deadlineSeconds = null, now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "advent-claims-"));
  const results = join(dir, "results"); mkdirSync(results);
  writeFileSync(join(results, "door-3.json"), JSON.stringify({ door: 3, hash: "h", round: "9", seed: "s", signature: "sig",
    winners: [{ k: 1, account: "alice", lamports: "700", memo: "ADVENT door door=3 winner=1/2 hash=h" }, { k: 2, account: "bob", lamports: "300", memo: "ADVENT door door=3 winner=2/2 hash=h" }],
    bonus: [{ k: 1, account: "carol", lamports: "50", memo: "ADVENT bonus door=3 winner=1/1 hash=h" }] }));
  const sent = [];
  const claims = createClaims({ file: join(dir, "claims.json"), resultsDir: results, deadlineSeconds, now: now ?? (() => doorTime(3) + 60),
    pay: pay === undefined ? async (kind, to, lamports, memo) => { sent.push({ kind, to, lamports, memo }); return { signature: `tx${sent.length}` }; } : pay });
  return { claims, sent, dir, results };
}

test("opening: nothing until the door settles, then the wallet's own answer only, remembered", () => {
  const { claims } = setup();
  assert.equal(claims.open("door", 4, "alice"), null, "door 4 isn't settled");
  assert.deepEqual(claims.open("door", 3, "alice"), { won: true, k: 1, lamports: "700", claimed: false, claimSignature: null, claimedAt: null });
  assert.equal(claims.open("door", 3, "zed").won, false);
  assert.equal(claims.open("bonus", 3, "carol").won, true);
  assert.equal(claims.open("bonus", 3, "alice").won, false, "a door winner isn't a box winner");
  assert.equal(claims.publicView("door", 3).openedCount, 1, "alice opened; bob hasn't");
});

test("a claim pays once with the door's memo; a second claim gets 409 with the earlier tx", async () => {
  const { claims, sent } = setup();
  const [c1, b1] = await claims.claim("door", 3, "alice");
  assert.equal(c1, 200); assert.deepEqual(b1, { ok: true, claimed: true, lamports: "700", signature: "tx1" });
  assert.deepEqual(sent, [{ kind: "door", to: "alice", lamports: 700n, memo: "ADVENT door door=3 winner=1/2 hash=h" }]);
  const [c2, b2] = await claims.claim("door", 3, "alice");
  assert.equal(c2, 409); assert.deepEqual(b2, { claimed: true, signature: "tx1", lamports: "700" });
  assert.equal(sent.length, 1, "paid once");
  assert.equal(claims.open("door", 3, "alice").claimSignature, "tx1", "opening again shows the claim");
  const [c3] = await claims.claim("bonus", 3, "carol");
  assert.equal(c3, 200); assert.equal(sent[1].kind, "bonus");
});

test("two quick clicks never pay twice", async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const sent = [];
  const { claims } = setup({ pay: async (kind, to) => { sent.push(to); await gate; return { signature: "slow" }; } });
  const first = claims.claim("door", 3, "bob");
  const [c2, b2] = await claims.claim("door", 3, "bob");
  assert.equal(c2, 409); assert.equal(b2.pending, true);
  release();
  const [c1, b1] = await first;
  assert.equal(c1, 200); assert.equal(b1.signature, "slow");
  assert.equal(sent.length, 1);
  assert.equal((await claims.claim("door", 3, "bob"))[0], 409);
});

test("a non-winner, an unsettled door and a failed send", async () => {
  const { claims, sent } = setup({ pay: async () => { throw new Error("rpc down"); } });
  assert.equal((await claims.claim("door", 3, "zed"))[0], 403);
  assert.equal((await claims.claim("bonus", 3, "alice"))[0], 403);
  assert.equal((await claims.claim("door", 4, "alice"))[0], 409);
  const [c, b] = await claims.claim("door", 3, "alice");
  assert.equal(c, 502); assert.match(b.error, /rpc down/);
  assert.equal(claims.state.door[3].alice.pending, null, "the mark is cleared so they can try again");
  void sent;
  const { claims: none } = setup({ pay: null });
  assert.equal((await none.claim("door", 3, "alice"))[0], 503);
});

test("the claim deadline is off by default and enforced when set", async () => {
  const late = () => doorTime(3) + 10 * 86400;
  const { claims: forever } = setup({ now: late });
  assert.equal((await forever.claim("door", 3, "alice"))[0], 200);
  const { claims: strict } = setup({ now: late, deadlineSeconds: 7 * 86400 });
  const [c, b] = await strict.claim("door", 3, "alice");
  assert.equal(c, 410); assert.equal(b.closedAt, doorTime(3) + 7 * 86400);
});

test("the public view and the published scrub never name a winner who hasn't opened", async () => {
  const { claims, dir, results } = setup();
  const res = claims.result(3);
  let pv = claims.publicView("door", 3);
  assert.deepEqual(pv, { winnerCount: 2, totalLamports: "1000", openedCount: 0, claimedCount: 0, claimedLamports: "0", unclaimedLamports: "1000", winners: [] });
  assert.deepEqual(claims.scrub("door", 3, res.winners), [{ k: 1, lamports: "700" }, { k: 2, lamports: "300" }], "prizes public, names not");
  claims.open("door", 3, "bob");
  await claims.claim("door", 3, "alice");
  pv = claims.publicView("door", 3);
  assert.equal(pv.claimedLamports, "700"); assert.equal(pv.unclaimedLamports, "300");
  assert.deepEqual(pv.winners.map((w) => [w.account, w.claimed]), [["alice", true], ["bob", false]]);
  assert.deepEqual(claims.scrub("door", 3, res.winners)[0], { k: 1, lamports: "700", account: "alice", claimed: true, claimSignature: "tx1" });
  // another process (the keeper) reading the same file sees the same
  const reader = createClaims({ file: join(dir, "claims.json"), resultsDir: results });
  assert.deepEqual(reader.scrub("door", 3, res.winners), claims.scrub("door", 3, res.winners));
  assert.ok(readFileSync(join(dir, "claims.json"), "utf8").includes("tx1"));
});
