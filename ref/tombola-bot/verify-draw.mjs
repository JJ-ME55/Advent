// verify-draw <id>: recomputes a Tombola (Pons) draw from public data and checks it against the chain.
//   1. the list (root, total weight) and the drand round were committed before the round was published: round time
//      >= snapshot + COMMIT_DELAY and >= commit block + COMMIT_DELAY, the snapshot at most MAX_SNAPSHOT_AGE before the commit
//   2. drand's signature for the round is valid (the beacon says so) and hashes to the stored randomness
//   3. the draw list, rebuilt from the token's Transfer logs at the snapshot block, has the root the contract pinned
//   4. the winner is the wallet at randomWord mod totalWeight over that list, and was paid the prize
// Environment: RPC_URL, DRAW, TOKEN, START_BLOCK, optional EXCLUDE (comma list), optional LOG_CHUNK.
// Exit 0 verified, 1 a mismatch, 3 couldn't check.
import { parseAbi, getAddress, keccak256 } from "viem";
import { clients, env, drandSignature, getLogsChunked, sortLogs, blockAtTime } from "../lib.mjs";
import { TRANSFER, replay, buildList, merkle, pick, randomWordOf } from "./snapshot.mjs";

const id = BigInt(process.argv[2] ?? "x");
if (process.argv[2] === undefined || Number.isNaN(Number(process.argv[2]))) { console.error("usage: node verify-draw.mjs <id>"); process.exit(2); }
const DRAW = getAddress(env("DRAW")), TOKEN = getAddress(env("TOKEN")), START_BLOCK = BigInt(env("START_BLOCK"));
const EXCLUDE = new Set((process.env.EXCLUDE ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const drawAbi = parseAbi([
  "function getDraw(uint256 id) view returns ((uint8 track, uint64 snapshotTime, uint64 drandRound, uint128 amount, bytes32 root, uint256 totalWeight, uint256 randomWord, address winner, bool settled, bool cancelled))",
  "function beacon() view returns (address)", "function COMMIT_DELAY() view returns (uint256)",
  "event Settled(uint256 indexed id, address indexed winner, uint256 amount, bytes32 root, uint256 totalWeight, uint256 randomWord)",
  "event Committed(uint256 indexed id, uint8 track, uint64 snapshotTime, uint64 drandRound, uint256 amount, bytes32 root, uint256 totalWeight)",
  "function MAX_SNAPSHOT_AGE() view returns (uint256)",
]);
const beaconAbi = parseAbi(["function roundTime(uint64) view returns (uint256)", "function isValid(uint64, bytes) view returns (bool)", "function randomness(uint64) view returns (bytes32)"]);

let bad = false, unsure = false;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}  ${m}`); if (!c) bad = true; };
const skip = (m) => { console.log(`SKIP  ${m}`); unsure = true; };

const { pub } = await clients();
const d = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "getDraw", args: [id] });
const beacon = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "beacon" });
const delay = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "COMMIT_DELAY" });
const maxAge = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "MAX_SNAPSHOT_AGE" });
console.log(`Draw ${id}: track ${d.track === 0 ? "regular" : "mega"}, snapshot ${d.snapshotTime}, drand round ${d.drandRound}, ${d.amount} wei`);
if (!d.settled) { console.log(d.cancelled ? "This draw was cancelled." : "This draw isn't settled yet."); process.exit(3); }

// 1. committed before the round
const roundTime = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "roundTime", args: [d.drandRound] });
ok(roundTime >= BigInt(d.snapshotTime) + delay, `drand round ${d.drandRound} is published ${roundTime - BigInt(d.snapshotTime)} s after the snapshot (at least ${delay} s)`);
const committed = await getLogsChunked((a, b) => pub.getContractEvents({ address: DRAW, abi: drawAbi, eventName: "Committed", args: { id }, fromBlock: a, toBlock: b }), START_BLOCK, await pub.getBlockNumber());
if (committed.length === 1) {
  const cb = await pub.getBlock({ blockNumber: committed[0].blockNumber });
  ok(cb.timestamp + delay <= roundTime, `the commit (block ${committed[0].blockNumber}, ${cb.timestamp}) is at least ${delay} s before the round's time ${roundTime}`);
  ok(cb.timestamp - BigInt(d.snapshotTime) <= maxAge, `the snapshot is ${cb.timestamp - BigInt(d.snapshotTime)} s before the commit (at most ${maxAge} s)`);
  ok(committed[0].args.root === d.root && committed[0].args.totalWeight === d.totalWeight, "the Committed log pinned the same root and total weight the draw holds");
} else skip(`expected one Committed log, found ${committed.length}`);

// 2. drand
const stored = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "randomness", args: [d.drandRound] });
let sig = null;
try { sig = await drandSignature(d.drandRound); } catch { /* relays down */ }
if (sig) {
  const valid = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "isValid", args: [d.drandRound, sig] });
  ok(valid, "drand's published signature verifies against drand's public key");
  ok(keccak256(sig) === stored, "the beacon's stored randomness is keccak256 of that signature");
} else skip("drand's relays didn't answer; the randomness is checked only through this RPC");
ok(randomWordOf(stored, id) === d.randomWord, "the random word is keccak256(randomness, id)");

// 3. the list
const head = await pub.getBlock();
const firstAfter = await blockAtTime((b) => pub.getBlock({ blockNumber: b }).then((x) => x.timestamp), BigInt(d.snapshotTime), START_BLOCK, head.number);
const snapBlock = firstAfter > head.number ? head.number : (await pub.getBlock({ blockNumber: firstAfter })).timestamp === BigInt(d.snapshotTime) ? firstAfter : firstAfter - 1n;
const logs = sortLogs(await getLogsChunked((a, b) => pub.getLogs({ address: TOKEN, event: TRANSFER, fromBlock: a, toBlock: b }), START_BLOCK, snapBlock));
const times = new Map();
const timeOf = async (b) => { if (!times.has(b)) times.set(b, (await pub.getBlock({ blockNumber: b })).timestamp); return times.get(b); };
const st = await replay(logs, timeOf, { exclude: EXCLUDE });
const { rows, totalWeight } = buildList(st, BigInt(d.snapshotTime));
const { root } = merkle(rows);
console.log(`INFO  ${logs.length} transfers up to block ${snapBlock}; ${rows.length} eligible wallets, total weight ${totalWeight}`);
ok(root === d.root, `the list rebuilt from Transfer logs has the root the contract pinned (${root})`);
ok(totalWeight === d.totalWeight, `its total weight matches the contract's (${d.totalWeight})`);

// 4. the winner
const chosen = pick(rows, totalWeight, d.randomWord);
if (chosen) {
  ok(chosen.row.account.toLowerCase() === d.winner.toLowerCase(), `the winner is ${chosen.row.account} (index ${chosen.index}, target ${chosen.target})`);
  const settled = await getLogsChunked((a, b) => pub.getContractEvents({ address: DRAW, abi: drawAbi, eventName: "Settled", args: { id }, fromBlock: a, toBlock: b }), START_BLOCK, head.number);
  if (settled.length === 1) ok(settled[0].args.amount === BigInt(d.amount) && settled[0].args.winner.toLowerCase() === d.winner.toLowerCase(), `Settled log: ${settled[0].args.winner} paid ${settled[0].args.amount} wei (tx ${settled[0].transactionHash})`);
  else skip(`expected one Settled log, found ${settled.length}`);
} else ok(d.winner.toLowerCase() === "0x0000000000000000000000000000000000000000", "nobody was eligible, so the pot rolled over");

console.log(bad ? "\nVerification FAILED" : unsure ? "\nCouldn't fully check this draw (see SKIP lines)." : "\nVerified: this draw was drawn fairly from public data.");
process.exit(bad ? 1 : unsure ? 3 : 0);
