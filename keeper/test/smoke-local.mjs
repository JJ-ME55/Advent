// Smoke test against a local solana-test-validator (RPC_URL, default http://127.0.0.1:8899): airdrops to a fresh
// treasury, sends a commit memo, pays two "winners" with payout memos, then reads the memos back the way the
// verifier does. Not a unit test: run it by hand.
//   node test/smoke-local.mjs
import { Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { connections, withRpc, sendMemo, sendSol, memosOf, parseCommit, commitMemo, payoutMemo, balanceOf } from "../src/solana.mjs";

process.env.RPC_URL ??= "http://127.0.0.1:8899";
const conns = connections();
const treasury = Keypair.generate(), a = Keypair.generate(), b = Keypair.generate();
const log = (...x) => console.log(...x);

await withRpc(conns, async (c) => { const s = await c.requestAirdrop(treasury.publicKey, 2 * LAMPORTS_PER_SOL); await c.confirmTransaction(s, "confirmed"); });
log("treasury", treasury.publicKey.toBase58(), "balance", await balanceOf(conns, treasury.publicKey));

const hash = "ab".repeat(32);
const text = commitMemo({ door: 1, hash, round: 21700000n, total: 123456789n, winners: 2 });
const c = await sendMemo(conns, treasury, text);
log("commit memo", c.signature, "slot", c.slot, "blockTime", c.blockTime);

const p1 = await sendSol(conns, treasury, a.publicKey, 100_000_000n, payoutMemo({ door: 1, k: 1, n: 2, hash }));
const p2 = await sendSol(conns, treasury, b.publicKey, 50_000_000n, payoutMemo({ door: 1, k: 2, n: 2, hash }));
log("payouts", p1.signature, p2.signature);
log("a", await balanceOf(conns, a.publicKey), "b", await balanceOf(conns, b.publicKey));

const memos = await memosOf(conns, treasury.publicKey);
log("memos found", memos.length);
const commits = memos.filter((m) => parseCommit(m.memo));
if (commits.length !== 1) throw new Error(`expected one commit memo, got ${commits.length}: ${JSON.stringify(memos.map((m) => m.memo))}`);
const parsed = parseCommit(commits[0].memo);
if (parsed.hash !== hash || parsed.round !== 21700000n || parsed.winners !== 2) throw new Error("commit memo didn't round-trip");
const payouts = memos.filter((m) => /^ADVENT door door=1 winner=/.test(m.memo));
if (payouts.length !== 2) throw new Error(`expected two payout memos, got ${payouts.length}`);
if (commits[0].blockTime == null) throw new Error("no blockTime on the commit memo");
log("OK: commit memo and payouts round-trip through getSignaturesForAddress");
process.exit(0);
