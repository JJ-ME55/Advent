// verify-door <d>: recomputes door d from public data and checks it against the chain.
//   1. the published list rebuilds from the coin's balance history at the snapshot time, with the published
//      exclusions, and hashes to the published hash;
//   2. a commit memo from the treasury carries that hash and the door's drand round, and landed at least
//      COMMIT_MARGIN before the round's time;
//   3. drand's relays agree on the round's signature; the seed is its sha256;
//   4. the winners and prizes recompute from the list, the seed and the pot, and each winner received a payout
//      transaction with the door's memo and the right amount.
// Environment: MINT, TREASURY (pubkey), DOOR_WALLET (pubkey), HELIUS_API_KEY, RPC_URL; DRAWS_URL or DRAWS_DIR for
// door-<d>.json. Exit 0 verified, 1 a mismatch, 3 couldn't check.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { replay, buildList, canonical, pickWinners, prizes } from "./drum.mjs";
import { drandSignatures, seedOf, roundTime } from "./drand.mjs";
import { connections, memosOf, parseCommit, heliusDeltas, rpcDeltas, withRpc, PublicKey } from "./solana.mjs";
import { COMMIT_MARGIN } from "./doors.mjs";

const d = Number(process.argv[2]);
if (!Number.isInteger(d)) { console.error("usage: node src/verify-door.mjs <door>"); process.exit(2); }
const env = (k) => { const v = process.env[k]; if (!v) { console.error(`${k} is required`); process.exit(2); } return v; };
const MINT = env("MINT"), TREASURY = env("TREASURY"), DOOR_WALLET = env("DOOR_WALLET");

let bad = false, unsure = false;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) bad = true; };
const skip = (m) => { console.log(`SKIP  ${m}`); unsure = true; };

// the published door
let doc;
if (process.env.DRAWS_URL) doc = await (await fetch(`${process.env.DRAWS_URL.replace(/\/$/, "")}/door-${d}.json`)).json();
else doc = JSON.parse(readFileSync(join(process.env.DRAWS_DIR ?? "draws", `door-${d}.json`), "utf8"));
console.log(`Door ${d}: snapshot ${doc.snapshotTime}, ${doc.rows.length} eligible, total ${doc.totalWeight}, pot ${doc.pot} lamports, ${doc.winners} winners, drand round ${doc.round}`);
if (!doc.result) { console.log("This door isn't settled yet."); process.exit(3); }

// 1. the list
const conns = connections();
const rows = doc.rows.map((r) => ({ ...r, balance: BigInt(r.balance), weight: BigInt(r.weight), cumulativeBefore: BigInt(r.cumulativeBefore) }));
const published = canonical({ door: d, mint: doc.mint, snapshotTime: doc.snapshotTime, snapshotSlot: doc.snapshotSlot, exclude: doc.exclude }, rows, BigInt(doc.totalWeight));
const commitHash = /hash=([0-9a-f]{64})/.exec(doc.commit.memo)?.[1];
ok(published.hash === commitHash, `the published list hashes to the committed hash (${commitHash})`);
let rebuilt = null;
try {
  const deltas = process.env.HELIUS_API_KEY ? await heliusDeltas(MINT) : await rpcDeltas(conns, MINT);
  const st = replay(deltas, doc.snapshotTime, { exclude: new Set(doc.exclude) });
  rebuilt = buildList(st, doc.snapshotTime);
  const again = canonical({ door: d, mint: doc.mint, snapshotTime: doc.snapshotTime, snapshotSlot: doc.snapshotSlot, exclude: doc.exclude }, rebuilt.rows, rebuilt.totalWeight);
  console.log(`INFO  ${deltas.length} balance changes replayed; ${rebuilt.rows.length} eligible wallets, total ${rebuilt.totalWeight}`);
  ok(again.hash === commitHash, `the list rebuilt from the chain's balance history hashes to the committed hash`);
} catch (e) { skip(`couldn't rebuild the list from the chain: ${e.message}`); }

// 2. the commit
const memos = await memosOf(conns, TREASURY, { limit: 1000, filter: (m) => parseCommit(m)?.door === d });
const rt = Number(roundTime(BigInt(doc.round)));
if (memos.length === 0) skip("no commit memo from the treasury for this door was found in its last 1000 transactions");
else {
  const c = parseCommit(memos[memos.length - 1].memo); // the earliest
  const m = memos[memos.length - 1];
  ok(c.hash === published.hash && c.round === BigInt(doc.round) && c.winners === doc.winners && c.total === BigInt(doc.totalWeight), `the commit memo (${m.signature.slice(0, 12)}…) pins this hash, round, total and winner count`);
  ok(m.blockTime != null && m.blockTime <= rt - COMMIT_MARGIN, `the commit landed at ${m.blockTime}, at least ${COMMIT_MARGIN} s before the round's time ${rt}`);
}

// 3. drand
const sigs = await drandSignatures(BigInt(doc.round));
const answers = [...sigs.values()].filter((v) => typeof v === "string" && /^[0-9a-f]{128}$/.test(v));
if (answers.length === 0) skip("no drand relay answered for the round");
else {
  ok(new Set(answers).size === 1, `${answers.length} drand relays agree on round ${doc.round}'s signature`);
  ok(answers[0] === doc.result.signature, "the keeper used that signature");
  ok(seedOf(answers[0]) === doc.result.seed, "the seed is sha256 of the signature");
}
const seed = doc.result.seed;

// 4. winners and payouts
const winners = pickWinners(rows, seed, d, doc.winners);
const amounts = prizes(BigInt(doc.pot), winners.length);
ok(winners.length === doc.result.winners.length && winners.every((w, i) => w.account === doc.result.winners[i].account), `the ${winners.length} winners recompute from the list and the seed`);
ok(amounts.every((a, i) => a.toString() === String(doc.result.winners[i].lamports)), `the prizes recompute (${amounts.map(String).join(", ")} lamports)`);
const paid = await withRpc(conns, async (c) => {
  const sigs = await c.getSignaturesForAddress(new PublicKey(DOOR_WALLET), { limit: 1000 }, "confirmed");
  return sigs.filter((s) => s.memo && s.memo.includes(`ADVENT door door=${d} winner=`) && s.err == null);
});
for (let i = 0; i < winners.length; i++) {
  const w = doc.result.winners[i];
  const tx = paid.find((p) => p.signature === w.signature);
  if (!tx) { ok(false, `winner ${i + 1} ${w.account}: payout ${w.signature.slice(0, 12)}… not found among the door wallet's transactions`); continue; }
  const detail = await withRpc(conns, (c) => c.getParsedTransaction(w.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }));
  const transfer = detail?.transaction.message.instructions.find((ix) => ix.parsed?.type === "transfer" && ix.parsed.info.destination === w.account);
  ok(transfer && BigInt(transfer.parsed.info.lamports) === amounts[i], `winner ${i + 1} ${w.account} was paid ${amounts[i]} lamports (tx ${w.signature.slice(0, 12)}…, memo winner=${i + 1}/${winners.length})`);
}

console.log(bad ? "\nVerification FAILED" : unsure ? "\nCouldn't fully check this door (see SKIP lines)." : "\nVerified: this door was drawn fairly from public data.");
process.exit(bad ? 1 : unsure ? 3 : 0);
