// Offline regression for src/draw.js (the Pons verifier). No network: a mock chain that honours block ranges,
// refuses ranges over 5M blocks like the public RPC, carries the token's Transfer logs and the draw contract's
// Committed / Settled / RolledOver logs, and pins a draw whose list is built with src/snapshot.js (the keeper's
// algorithm). Usage: node scripts/verify-test.mjs  (exits 1 on any failed expectation)
import { keccak256, encodeAbiParameters, encodeEventTopics, encodeFunctionData } from "viem";
import { verifyDraw, boughtFromPool, chunkedLogs, listAtTime, blockTimes, roundTimeOf, DEFAULTS } from "../src/draw.js";
import { replay, buildList, merkle, pick, randomWordOf, weightFor } from "../src/snapshot.js";
import { drawAbi, tokenAbi } from "../src/generated/abis.js";

const WAD = 10n ** 18n;
const A = (n) => "0x" + n.toString(16).padStart(40, "0");
const DRAW = A(0xaa), TOKEN = A(0xbb), BEACON = A(0xcc), PM = A(0xdd), CURVE = A(0xc0), SPLITTER = A(0x55), ROUTER = A(0xee);
const W1 = A(1), W2 = A(2), W3 = A(3), W4 = A(4);
const ZERO = A(0);
const SIG = "0x" + "11".repeat(48);
globalThis.fetch = async () => ({ ok: true, json: async () => ({ signature: SIG.slice(2) }) });
const randomness = keccak256(SIG);
const HEAD = 40_000_000n, START_BLOCK = 10_000_000n, COMMIT_BLOCK = 30_000_100n, SETTLE_BLOCK = 30_000_400n;
const COMMIT_TX = "0x" + "55".repeat(32), SETTLE_TX = "0x" + "77".repeat(32);
// a real timeline on drand's pinned evmnet constants: the snapshot, the commit a few seconds later, the committed
// round about 700 s after the snapshot, the settle 100 s after the round is out [R10 finding 3]
const SNAP = 1_760_000_000n;
const ROUND = (SNAP + 700n - DEFAULTS.drandGenesis) / DEFAULTS.drandPeriod + 1n;
const ROUND_T = roundTimeOf(ROUND), COMMIT_T = SNAP + 12n, SETTLE_T = ROUND_T + 100n;
let failures = 0;
const expect = (cond, what) => { console.log(`  ${cond ? "ok  " : "FAIL"} ${what}`); if (!cond) failures++; };

function inRange(l, from, to) { return l.blockNumber >= BigInt(from) && l.blockNumber <= BigInt(to); }
function guard(from, to) { if (BigInt(to) - BigInt(from) > 5_000_000n) throw new Error("query exceeds max block range 5000000"); }

// Block timestamps: the token's transfers sit in blocks spread over 20M blocks, each `at` seconds before the snapshot.
const xferLog = ({ from, to, value, block, idx = 0, tx }) => ({ address: TOKEN, eventName: "Transfer", args: { from, to, value }, blockNumber: block, logIndex: idx, transactionHash: tx ?? ("0x" + block.toString(16).padStart(64, "0")) });

/**
 * A mock chain with `transfers` [{from, to, value, block}] and block times from `timeOf(block)`. The draw is built the
 * way the keeper builds it (snapshot.js), then optionally tampered with (`tamper(d)`), and the logs follow the draw.
 */
function chain({ transfers, timeOf, exclude = [], tamper, rollover = false, settleCalldata = "settle", roundOverride }) {
  const logs = [...transfers].sort((x, y) => (x.block === y.block ? x.idx - y.idx : x.block < y.block ? -1 : 1)).map(xferLog);
  const build = async () => {
    const used = [];
    for (const l of logs) if ((await timeOf(l.blockNumber)) <= SNAP) used.push(l);
    const st = await replay(used, timeOf, { exclude: new Set(exclude.map((a) => a.toLowerCase())) });
    return buildList(st, SNAP);
  };
  const ready = (async () => {
    const { rows, totalWeight } = await build();
    const { root, proofs } = merkle(rows);
    const word = randomWordOf(randomness, 0n);
    const chosen = pick(rows, totalWeight, word);
    const amount = 10n ** 16n;
    const d = {
      track: 0, snapshotTime: SNAP, drandRound: roundOverride ?? ROUND, amount, root, totalWeight, randomWord: word,
      winner: rollover || !chosen ? ZERO : chosen.row.account, settled: true, cancelled: false,
    };
    tamper?.(d);
    const settleArgs = chosen && !rollover ? [0n, SIG, chosen.row.account, chosen.row.cumulativeBefore, chosen.row.weight, proofs[chosen.index]] : null;
    const txs = {
      [SETTLE_TX]: {
        to: DRAW,
        input: settleCalldata === "none" ? "0x" : rollover || !chosen
          ? encodeFunctionData({ abi: drawAbi, functionName: "rollover", args: [0n, settleCalldata === "empty" ? "0x" : SIG] })
          : encodeFunctionData({ abi: drawAbi, functionName: "settle", args: settleCalldata === "empty" ? [settleArgs[0], "0x", ...settleArgs.slice(2)] : settleArgs }),
      },
    };
    const drawLogs = {
      Committed: [{ eventName: "Committed", args: { id: 0n, track: 0, snapshotTime: d.snapshotTime, drandRound: d.drandRound, amount, root: d.root, totalWeight: d.totalWeight }, blockNumber: COMMIT_BLOCK, logIndex: 1, transactionHash: COMMIT_TX }],
      Settled: rollover || !chosen ? [] : [{ eventName: "Settled", args: { id: 0n, winner: d.winner, amount, root: d.root, totalWeight: d.totalWeight, randomWord: d.randomWord }, blockNumber: SETTLE_BLOCK, logIndex: 2, transactionHash: SETTLE_TX }],
      RolledOver: rollover || !chosen ? [{ eventName: "RolledOver", args: { id: 0n, root }, blockNumber: SETTLE_BLOCK, logIndex: 2, transactionHash: SETTLE_TX }] : [],
      Cancelled: [],
    };
    return { d, rows, totalWeight, root, chosen, txs, drawLogs, amount };
  })();
  const pub = {
    async getBlockNumber() { return HEAD; },
    async readContract({ address, functionName, args }) {
      const { d } = await ready;
      const f = functionName;
      if (address === DRAW) return { drawCount: 1n, getDraw: d, beacon: BEACON, splitter: SPLITTER, COMMIT_DELAY: 600n }[f];
      if (address === BEACON) return { isValid: true, randomness }[f];
      throw new Error("unmocked " + f + " on " + address);
    },
    async getContractEvents({ address, eventName, args, fromBlock, toBlock }) {
      guard(fromBlock, toBlock);
      const { drawLogs } = await ready;
      if (address === DRAW) return (drawLogs[eventName] ?? []).filter((l) => inRange(l, fromBlock, toBlock));
      if (address === TOKEN && eventName === "Transfer") return logs.filter((l) => inRange(l, fromBlock, toBlock) && (!args?.to || l.args.to === args.to) && (!args?.from || l.args.from === args.from));
      return [];
    },
    async getLogs({ address, fromBlock, toBlock }) { guard(fromBlock, toBlock); return address === TOKEN ? logs.filter((l) => inRange(l, fromBlock, toBlock)) : []; },
    async getBlock({ blockNumber }) {
      if (blockNumber === COMMIT_BLOCK) return { timestamp: COMMIT_T };
      if (blockNumber === SETTLE_BLOCK) return { timestamp: SETTLE_T };
      return { timestamp: await timeOf(blockNumber) };
    },
    async getTransaction({ hash }) { const { txs } = await ready; return txs[hash] ?? null; },
    // a transfer's receipt: every Transfer log of its transaction, as raw topics/data (one transfer per mock tx)
    async getTransactionReceipt({ hash }) {
      const mine = logs.filter((l) => l.transactionHash.toLowerCase() === hash.toLowerCase());
      if (!mine.length) throw new Error("none");
      return { status: "success", blockNumber: mine[0].blockNumber, logs: mine.map((l) => ({ address: TOKEN, logIndex: l.logIndex, topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from: l.args.from, to: l.args.to } }), data: encodeAbiParameters([{ type: "uint256" }], [l.args.value]) })) };
    },
    calls: 0,
  };
  return { pub, ready };
}
const run = async (title, c, row, extra = {}) => {
  const { d, amount } = await c.ready;
  const r = await verifyDraw({ pub: c.pub, draw: DRAW, token: TOKEN, id: 0, row: row === "honest" ? { winner: d.winner === ZERO ? null : d.winner, amountWei: amount.toString(), track: "regular", tx: SETTLE_TX, at: Number(SETTLE_T), kind: d.winner === ZERO ? "rolled" : "paid" } : row, startBlock: START_BLOCK, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], pools: [PM, CURVE], now: () => Number(SETTLE_T) + 1000, ...extra });
  console.log(`\n== ${title}: ok=${r.ok} incomplete=${r.incomplete}`);
  for (const k of r.checks) console.log(`     ${k.status.toUpperCase().padEnd(4)} ${k.text}`);
  return r;
};

// Block times: block n at START_BLOCK + k*1M is SNAP - (20 - k) hours, so early holders have 3x and late ones less.
const blk = (k) => START_BLOCK + BigInt(k) * 1_000_000n;
const timeOf = async (b) => {
  const n = BigInt(b);
  if (n < START_BLOCK) return SNAP - 100n * 3600n;
  if (n > blk(20)) return SNAP + 3600n; // after the snapshot
  return SNAP - (20n - (n - START_BLOCK) / 1_000_000n) * 3600n;
};
// A launch: the mint to the curve, four buyers from the curve, one gift, one wallet below the minimum, one that sold.
const launch = [
  { from: ZERO, to: CURVE, value: 10n ** 27n, block: blk(0), idx: 0 },
  { from: CURVE, to: W1, value: 50_000n * WAD, block: blk(1), idx: 0 }, // 19 h before the snapshot
  { from: CURVE, to: W2, value: 20_000n * WAD, block: blk(2), idx: 0 },
  { from: CURVE, to: W3, value: 100_000n * WAD, block: blk(3), idx: 0 },
  { from: W3, to: W4, value: 30_000n * WAD, block: blk(4), idx: 0 }, // W3 sent: its clock resets; W4 is gifted (no pool buy)
  { from: CURVE, to: A(5), value: 5_000n * WAD, block: blk(5), idx: 0 }, // below the minimum
  { from: CURVE, to: A(6), value: 40_000n * WAD, block: blk(21), idx: 0 }, // after the snapshot: not in the list
];

// 1. a fair draw, honest row -> verified; the list has the curve, the PoolManager etc. left out
const c1 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO] });
{
  const { rows, totalWeight, d } = await c1.ready;
  expect(rows.length === 4 && rows.every((r) => [W1, W2, W3, W4].includes(r.account)), `the mock list has W1..W4 (${rows.length} rows), not the curve, the 5k wallet or the late buyer`);
  const w3 = rows.find((r) => r.account === W3);
  expect(w3.weight === weightFor(70_000n * WAD, SNAP - 16n * 3600n, SNAP), "W3's clock restarted when it sent tokens (16 h held, 70k left)");
  expect(totalWeight === rows.reduce((s, r) => s + r.weight, 0n) && d.winner !== ZERO, "total weight is the sum and a winner was picked");
}
const r1 = await run("1. fair draw, honest row", c1, "honest");
expect(r1.ok === true && r1.incomplete === false, "fair draw verifies (transfers fetched in chunks across 30M blocks)");
expect(r1.checks.some((k) => k.status === "pass" && /root the contract pinned/.test(k.text)), "the rebuilt list's root is the pinned root");
expect(r1.checks.some((k) => k.status === "pass" && /committed|commit \(block/i.test(k.text) && /before the round/.test(k.text)), "the commit is checked to be before the round's time");
expect(r1.checks.some((k) => k.status === "pass" && /drand's relays, which this RPC doesn't control/.test(k.text)), "drand's relays are cross-checked against the settle calldata");
expect(r1.chain?.winner === (await c1.ready).d.winner && r1.chain.tx === SETTLE_TX && r1.chain.heldSeconds > 0, "chain values (winner, tx, hold clock) returned for the card");
expect(r1.checks.some((k) => /Heuristic/.test(k.text)), "the pool-buy heuristic ran with the curve as a buy source");

// 2. a fabricated row: wrong winner, amount, track, tx
const r2 = await run("2. real draw, page shows a 50 ETH mega win for W4 with a fake tx", c1, { winner: W4, amountWei: (50n * WAD).toString(), track: "mega", tx: "0x" + "99".repeat(32), kind: "paid" });
expect(r2.ok === false, "fabricated row fails");
expect(r2.checks.filter((k) => k.status === "fail").length === ((await c1.ready).d.winner === W4 ? 3 : 4), "exactly the winner, amount, track and tx checks fail");

// 3. a lying RPC: the stored draw's root isn't the list's (the keeper published a padded list) and the winner is a
//    wallet that isn't in the chain's list
const c3 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], tamper: (d) => { d.root = keccak256("0x1234"); d.winner = A(0x99); d.totalWeight += 1n; } });
const r3 = await run("3. lying RPC / dishonest list: pinned root and winner don't come from the Transfer logs", c3, "honest");
expect(r3.ok === false, "a pinned root that the Transfer logs don't reproduce FAILS");
expect(r3.checks.some((k) => k.status === "fail" && /root/.test(k.text)) && r3.checks.some((k) => k.status === "fail" && /total weight/i.test(k.text)) && r3.checks.some((k) => k.status === "fail" && /winner/i.test(k.text)), "root, total weight and winner all fail");

// 4. a lying RPC that names a FUTURE drand round (the relays can't have it; the round is after the settle block)
const FUTURE = ROUND + 100_000n;
const c4 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], roundOverride: FUTURE });
const r4 = await run("4. lying RPC: the draw names a round published after the settle block", c4, "honest");
expect(r4.ok === false && r4.checks.some((k) => k.status === "fail" && /published after this draw was settled/.test(k.text)), "a round published after the settle block is a FAIL (made-up randomness)");

// 5. committed too late: the round is less than COMMIT_DELAY after the snapshot, and the commit block is after the round
const EARLY = (SNAP + 300n - DEFAULTS.drandGenesis) / DEFAULTS.drandPeriod + 1n;
const c5 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], roundOverride: EARLY });
c5.pub.getBlock = async ({ blockNumber }) => (blockNumber === COMMIT_BLOCK ? { timestamp: roundTimeOf(EARLY) + 5n } : blockNumber === SETTLE_BLOCK ? { timestamp: SETTLE_T } : { timestamp: await timeOf(blockNumber) });
const r5 = await run("5. the round was not committed before it was published", c5, "honest");
expect(r5.ok === false, "a round within the commit delay / committed after its time FAILS");
expect(r5.checks.some((k) => k.status === "fail" && /less than the contract's 10m commit delay/.test(k.text)), "the commit-delay check fails");
expect(r5.checks.some((k) => k.status === "fail" && /less than 10m before the round.s time/.test(k.text)), "the commit-before-round check fails");

// 6. rollover: nobody eligible (everyone bought after the snapshot), honest rollover row passes, a fake win fails
const late = launch.map((t) => ({ ...t, block: t.block + 21_000_000n }));
const c6 = chain({ transfers: [{ from: ZERO, to: CURVE, value: 10n ** 27n, block: blk(0), idx: 0 }, ...late], timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], rollover: true });
const r6 = await run("6. rollover, honest row", c6, "honest");
expect(r6.ok === true, "an honest rollover row passes (empty list, keccak('') root)");
const r6b = await run("6b. rollover shown as a win for W1", c6, { winner: W1, amountWei: (5n * WAD).toString(), track: "regular", tx: SETTLE_TX, kind: "paid" });
expect(r6b.ok === false, "a rollover shown as a win fails");

// 7. the settle calldata carried "0x" (round already proven): the beacon's prove tx and the relays still check it
const c7 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], settleCalldata: "empty" });
const r7 = await run("7. settle sent an empty signature: relays are the source", c7, "honest");
expect(r7.ok === true && r7.incomplete === false, "an empty settle signature falls through to drand's relays and still verifies");
expect(r7.checks.some((k) => k.status === "info" && /read from drand's relays/.test(k.text)), "the signature came from the relays");

// 8. drand unreachable: not a FAIL, the amber "checked only through this RPC" (the calldata signature passed isValid)
globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };
const c8 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO] });
const r8 = await run("8. drand relays down", c8, "honest", { drandOpts: { timeoutMs: 50 } });
expect(r8.ok === true && r8.incomplete === true && r8.relayUnconfirmed === true, "drand outage: no FAIL, but relay-unconfirmed (amber)");
// and with no calldata either: unknown, never a FAIL
const c8b = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO], settleCalldata: "none" });
const r8b = await run("8b. drand down and no calldata", c8b, "honest", { drandOpts: { timeoutMs: 50 } });
expect(r8b.ok === true && r8b.incomplete === true && /randomness couldn't be checked/.test(r8b.incompleteWhy.join()), "no signature anywhere: 'couldn't check', never FAIL");
globalThis.fetch = async () => ({ ok: true, json: async () => ({ signature: SIG.slice(2) }) });

// 9. a relay that serves a different signature the beacon rejects, while the calldata passed: INFO, still verified
globalThis.fetch = async (u) => ({ ok: true, json: async () => ({ signature: /api2/.test(u) ? "22".repeat(48) : SIG.slice(2) }) });
const c9 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO] });
c9.pub.readContract = (({ readContract }) => async (q) => (q.functionName === "isValid" ? q.args[1] === SIG : readContract(q)))(c9.pub);
const r9 = await run("9. one relay disagrees, three match", c9, "honest");
expect(r9.ok === true && r9.incomplete === false && r9.checks.some((k) => k.status === "info" && /Another drand relay disagreed/.test(k.text)), "one bad relay is INFO, the draw still verifies");
globalThis.fetch = async () => ({ ok: true, json: async () => ({ signature: SIG.slice(2) }) });

// 10. the RPC refuses the Transfer scan even at one block: "couldn't check", not FAIL
const c10 = chain({ transfers: launch, timeOf, exclude: [PM, CURVE, SPLITTER, DRAW, ZERO] });
c10.pub.getLogs = async () => { throw new Error("query returned more than 10000 results"); };
const r10 = await run("10. RPC refuses the Transfer logs", c10, "honest");
expect(r10.ok === true && r10.incomplete === true && /Transfer logs/.test(r10.incompleteWhy.join()), "an RPC refusal is neutral, never FAILED");

// 11. the pool-buy heuristic with the curve and the PoolManager as sources, gifts flagged
{
  const b1 = await boughtFromPool({ pub: c1.pub, token: TOKEN, pools: [PM, CURVE], wallet: W1, beforeTs: Number(SNAP), fromBlock: START_BLOCK, toBlock: HEAD });
  expect(b1.bought === true && b1.boughtWei === 50_000n * WAD, "a buy from the curve is a pool buy");
  const b4 = await boughtFromPool({ pub: c1.pub, token: TOKEN, pools: [PM, CURVE], wallet: W4, beforeTs: Number(SNAP), fromBlock: START_BLOCK, toBlock: HEAD });
  expect(b4.bought === false && /no pool buy found/.test(b4.how), "a gifted wallet gets 'no pool buy found'");
  // after graduation: PM -> router -> wallet in one receipt
  const xfer = (from, to, v) => ({ address: TOKEN, topics: encodeEventTopics({ abi: tokenAbi, eventName: "Transfer", args: { from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [v]) });
  const RTX = "0x" + "a1".repeat(32);
  const pubR = {
    async getBlockNumber() { return HEAD; },
    async getContractEvents({ args, fromBlock, toBlock }) { guard(fromBlock, toBlock); return [{ args: { from: ROUTER, to: W2, value: 99n }, blockNumber: 50n, logIndex: 2, transactionHash: RTX }].filter((l) => l.args.to === args.to && inRange(l, fromBlock, toBlock)); },
    async getBlock({ blockNumber }) { return { timestamp: blockNumber }; },
    async getTransactionReceipt() { return { status: "success", blockNumber: 50n, logs: [xfer(PM, ROUTER, 100n), xfer(ROUTER, W2, 99n)] }; },
  };
  const bR = await boughtFromPool({ pub: pubR, token: TOKEN, pools: [PM, CURVE], wallet: W2, beforeTs: 100 });
  expect(bR.bought === true && bR.boughtWei === 99n, "a router buy from the PoolManager after graduation counts");
}

// 12. chunking shrinks on error, merge-sorts, grows back; listAtTime stops at the snapshot
{
  let calls = 0;
  const logs = await chunkedLogs({ getBlockNumber: async () => HEAD }, async (a, b) => { calls++; guard(a, b); return c1.pub.getLogs({ address: TOKEN, fromBlock: a, toBlock: b }); }, { fromBlock: START_BLOCK, toBlock: HEAD });
  expect(logs.length === launch.length && calls > 6, `chunks shrank to fit (${calls} calls) and every transfer came back sorted`);
  const times = blockTimes(c1.pub);
  const at = await listAtTime({ logs, timeOf: times.timeOf, snapshotTime: SNAP, exclude: [CURVE] });
  expect(at.transfers === launch.length - 1 && at.rows.length === 4, "listAtTime replays only transfers at or before the snapshot time");
}

console.log(failures ? `\n${failures} expectation(s) FAILED` : "\nAll expectations passed");
process.exit(failures ? 1 : 0);
