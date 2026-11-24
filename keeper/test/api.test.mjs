import { test, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { UNIT } from "../src/drum.mjs";
import { snapshotTime } from "../src/doors.mjs";

const dir = mkdtempSync(join(tmpdir(), "advent-api-"));
process.env.DRAWS_DIR = dir; process.env.PORT = "0"; process.env.BONUS_ENTRANTS_FILE = join(dir, "none.json");
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
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ at: t0, pots: { door: "123" }, claimed: "5", nextDoor: 2, nextDoorAt: 0, exclude: ["CURVE"], wallets: {}, doors: { 1: { winners: [{ lamports: "70" }] } } }));
  writeFileSync(join(dir, "door-1.json"), JSON.stringify({ door: 1, snapshotTime: t0, rows: [{ account: wallet, weight: "1" }], totalWeight: "1", pot: "100", winners: 1, round: "5", commit: { signature: "c", blockTime: t0, memo: "ADVENT commit door=1 hash=" + "ab".repeat(32) + " round=5 total=1 winners=1" }, result: { seed: "x", signature: "y", winners: [{ k: 1, account: wallet, lamports: "100", signature: "p1" }] } }));
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
  assert.equal(api.routes["GET /winners/:d"]({ d: "1" }).winners[0].account, wallet);
});

test("opening a door needs a fresh signed nonce", () => {
  const open = api.routes["POST /door/:d/open"];
  assert.equal(open({ d: "1" }, {})[0], 401);
  const { nonce } = api.routes["GET /nonce/:wallet"]({ wallet });
  const sig = nacl.sign.detached(Buffer.from(`ADVENT open-1 ${wallet} ${nonce}`), kp.secretKey);
  const bad = open({ d: "1" }, { wallet, nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from("wrong"), kp.secretKey)) });
  assert.equal(bad[0], 401);
  const { nonce: n2 } = api.routes["GET /nonce/:wallet"]({ wallet });
  const sig2 = nacl.sign.detached(Buffer.from(`ADVENT open-1 ${wallet} ${n2}`), kp.secretKey);
  const r = open({ d: "1" }, { wallet, nonce: n2, signature: bs58.encode(sig2) });
  assert.equal(r.won, true);
  assert.equal(r.lamports, "100");
  assert.equal(open({ d: "1" }, { wallet, nonce: n2, signature: bs58.encode(sig2) })[0], 401, "a nonce is single-use");
  void sig;
});
