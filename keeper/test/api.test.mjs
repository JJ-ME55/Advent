import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { UNIT } from "../src/drum.mjs";
import { snapshotTime } from "../src/doors.mjs";

const dir = mkdtempSync(join(tmpdir(), "advent-api-"));
const results = join(dir, "results"); mkdirSync(results);
process.env.DRAWS_DIR = dir; process.env.PORT = "0"; process.env.BONUS_ENTRANTS_FILE = join(dir, "none.json");
process.env.RESULTS_DIR = results; process.env.CLAIMS_FILE = join(dir, "claims.json"); process.env.VILLAGE_STATE_FILE = join(dir, "village.json");
const sign = (msg) => bs58.encode(nacl.sign.detached(Buffer.from(msg), kp.secretKey));
const signed = (action) => { const { nonce } = api.routes["GET /nonce/:wallet"]({ wallet }); return { wallet, nonce, signature: sign(`ADVENT ${action} ${wallet} ${nonce}`) }; };
const kp = nacl.sign.keyPair();
const wallet = bs58.encode(kp.publicKey);
const t0 = snapshotTime(1);
let api;

before(async () => {
  writeFileSync(join(dir, "deltas.json"), JSON.stringify([
    { owner: "CURVE", delta: (1_000_000_000n * UNIT).toString(), time: t0 - 90_000, slot: 1, signature: "m", index: 0 },
    { owner: "CURVE", delta: (-300_000n * UNIT).toString(), time: t0 - 80_000, slot: 2, signature: "b1", index: 0 },
    { owner: wallet, delta: (300_000n * UNIT).toString(), time: t0 - 80_000, slot: 2, signature: "b1", index: 1 },
    { owner: "CURVE", delta: (-5_000n * UNIT).toString(), time: t0 - 80_000, slot: 3, signature: "b2", index: 0 },
    { owner: "dust", delta: (5_000n * UNIT).toString(), time: t0 - 80_000, slot: 3, signature: "b2", index: 1 },
  ]));
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ at: t0, pots: { door: "123" }, claimed: "5", nextDoor: 2, nextDoorAt: 0, exclude: ["CURVE"], wallets: {}, doors: { 1: { settled: true, door: { totalLamports: "100", claimedLamports: "70" }, bonus: { totalLamports: "0", claimedLamports: "0" } } } }));
  // door 1 (an old door: today is door 2) settled with two winners: our wallet and "other"; the published file names nobody
  const commit = { signature: "c", blockTime: t0, memo: "ADVENT commit door=1 hash=" + "ab".repeat(32) + " round=5 total=2 winners=2" };
  writeFileSync(join(dir, "door-1.json"), JSON.stringify({ door: 1, snapshotTime: t0, rows: [{ account: wallet, weight: "1" }, { account: "other", weight: "1" }], totalWeight: "2", pot: "100", winners: 2, round: "5", commit, result: { seed: "x", signature: "y", winners: [{ k: 1, lamports: "70" }, { k: 2, lamports: "30" }], bonus: [] } }));
  writeFileSync(join(results, "door-1.json"), JSON.stringify({ door: 1, hash: "ab".repeat(32), round: "5", seed: "x", signature: "y", winners: [{ k: 1, account: wallet, lamports: "70", memo: "ADVENT door door=1 winner=1/2 hash=" + "ab".repeat(32) }, { k: 2, account: "other", lamports: "30", memo: "ADVENT door door=1 winner=2/2 hash=" + "ab".repeat(32) }], bonus: [{ k: 1, account: wallet, lamports: "9", memo: "ADVENT bonus door=1 winner=1/1 hash=" + "ab".repeat(32) }] }));
  api = await import("../src/api.mjs");
});

test("eligibility replays the published deltas with the published exclusions", () => {
  const e = api.eligibility(wallet, t0);
  assert.equal(e.inDrum, true);
  assert.equal(e.balance, (300_000n * UNIT).toString());
  assert.equal(e.odds, 1, "the only eligible wallet has all the tickets");
  assert.equal(api.eligibility("dust", t0).inDrum, false);
  assert.match(api.eligibility("dust", t0).reason, /minimum/);
  assert.equal(api.eligibility("CURVE", t0).holder, false, "excluded wallets aren't holders");
});

test("routes: pot, door, winners", () => {
  assert.equal(api.routes["GET /pot"]().totalPaid, "70");
  const d = api.routes["GET /door/:d"]({ d: "1" });
  assert.equal(d.status, "open");
  assert.equal(d.commit.hash, "ab".repeat(32));
  assert.equal(api.routes["GET /door/:d"]({ d: "24" }).status, "locked");
  assert.deepEqual(api.routes["GET /door/:d"]({ d: "99" })[0], 404);
  assert.equal(api.routes["GET /pot"]().totalWon, "100");
});

test("GET /winners/:d names nobody who hasn't opened, but gives Verify everything", () => {
  const w = api.routes["GET /winners/:d"]({ d: "1" });
  assert.equal(w.winnerCount, 2); assert.equal(w.totalLamports, "100"); assert.equal(w.claimedCount, 0);
  assert.deepEqual(w.winners, [], "no spoilers");
  assert.equal(w.hash, "ab".repeat(32)); assert.equal(w.round, "5"); assert.equal(w.seed, "x"); assert.equal(w.signature, "y"); assert.equal(w.commit.signature, "c");
  assert.deepEqual(api.routes["GET /winners/:d"]({ d: "2" })[0], 404);
});

test("opening a door needs a fresh signed nonce; an old door opens; the answer is private to the wallet", () => {
  const open = api.routes["POST /door/:d/open"];
  assert.equal(open({ d: "1" }, {})[0], 401);
  const { nonce } = api.routes["GET /nonce/:wallet"]({ wallet });
  assert.equal(open({ d: "1" }, { wallet, nonce, signature: sign("wrong") })[0], 401);
  const body = signed("open-1");
  const r = open({ d: "1" }, body);
  assert.deepEqual(r, { ok: true, door: 1, wallet, inDrum: true, won: true, k: 1, lamports: "70", claimed: false, claimSignature: null, claimedAt: null });
  assert.equal(open({ d: "1" }, body)[0], 401, "a nonce is single-use");
  assert.equal(open({ d: "2" }, signed("open-2"))[0], 409, "door 2 is still to come");
  assert.equal(api.routes["GET /winners/:d"]({ d: "1" }).winners.length, 1, "now that they've opened, they're listed");
  assert.equal(api.routes["GET /winners/:d"]({ d: "1" }).winners[0].account, wallet);
  assert.equal(api.routes["GET /winners/:d"]({ d: "1" }).winners[0].claimed, false);
});

test("claiming pays once from the right wallet; a second claim gets 409; a non-winner is rejected", async () => {
  const sent = [];
  api.claims.setPay(async (kind, to, lamports, memo) => { sent.push({ kind, to, lamports, memo }); return { signature: `tx${sent.length}` }; });
  const claim = api.routes["POST /door/:d/claim"];
  assert.equal((await claim({ d: "1" }, {}))[0], 401);
  const [c1, b1] = await claim({ d: "1" }, signed("claim-1"));
  assert.equal(c1, 200); assert.deepEqual(b1, { ok: true, claimed: true, lamports: "70", signature: "tx1" });
  assert.deepEqual(sent, [{ kind: "door", to: wallet, lamports: 70n, memo: "ADVENT door door=1 winner=1/2 hash=" + "ab".repeat(32) }]);
  const [c2, b2] = await claim({ d: "1" }, signed("claim-1"));
  assert.equal(c2, 409); assert.deepEqual(b2, { claimed: true, signature: "tx1", lamports: "70" });
  assert.equal(sent.length, 1);
  // a non-winner with a valid signature
  const other = nacl.sign.keyPair(), ow = bs58.encode(other.publicKey);
  const { nonce } = api.routes["GET /nonce/:wallet"]({ wallet: ow });
  const [c3, b3] = await claim({ d: "1" }, { wallet: ow, nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from(`ADVENT claim-1 ${ow} ${nonce}`), other.secretKey)) });
  assert.equal(c3, 403); assert.equal(b3.ok, false);
  assert.equal((await claim({ d: "2" }, signed("claim-2")))[0], 409, "not settled");
  // the claim is recorded where the keeper will publish it
  assert.ok(readFileSync(process.env.CLAIMS_FILE, "utf8").includes("tx1"));
  assert.equal(api.routes["POST /door/:d/open"]({ d: "1" }, signed("open-1")).claimSignature, "tx1");
  // the bonus box: open, then claim from the bonus wallet
  const bo = api.routes["POST /bonus/:d/open"]({ d: "1" }, signed("bonus-1"));
  assert.equal(bo.won, true); assert.equal(bo.lamports, "9");
  const [c4, b4] = await api.routes["POST /bonus/:d/claim"]({ d: "1" }, signed("bonus-claim-1"));
  assert.equal(c4, 200); assert.equal(b4.lamports, "9"); assert.equal(sent[1].kind, "bonus");
  assert.equal((await api.routes["POST /bonus/:d/claim"]({ d: "1" }, signed("bonus-claim-1")))[0], 409);
});
