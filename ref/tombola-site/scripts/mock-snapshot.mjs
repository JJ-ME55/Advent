// Writes mock/snapshot.json in the bot's snapshot shape for the Pons launch, read from a chain (the local Anvil demo
// on 8574 by default). For local testing only; in production the bot publishes snapshot.json.
// Usage: node scripts/mock-snapshot.mjs [rpcUrl] [configFile]   (default: config.local.js's addresses)
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createPublicClient, http } from "viem";
import { writeAbis } from "./abis.mjs";
import { readConfig } from "./build.mjs";

writeAbis();
const { drawAbi } = await import("../src/generated/abis.js");
const { chunkedLogs, transferLogs, blockTimes, listAtTime, boughtFromPool, poolFlagOf } = await import("../src/draw.js");
const root = fileURLToPath(new URL("..", import.meta.url));
const cfg = readConfig(join(root, process.argv[3] ?? "config.local.js"));
const rpc = process.argv[2] ?? cfg.rpcUrl;
const pub = createPublicClient({ transport: http(rpc) });
const v = (functionName, args = []) => pub.readContract({ address: cfg.draw, abi: drawAbi, functionName, args });

const block = await pub.getBlock();
const ts = block.timestamp;
const exclude = [...(cfg.exclude ?? []), cfg.draw, cfg.splitter, cfg.curve, cfg.poolManager].filter(Boolean);
const [potRegular, potMega] = await Promise.all([v("potRegular"), v("potMega")]);
const logs = await transferLogs({ pub, token: cfg.token, fromBlock: BigInt(cfg.startBlock || 0), toBlock: block.number });
const times = blockTimes(pub);
await times.prefetch(logs.map((l) => l.blockNumber));
const list = await listAtTime({ logs, timeOf: times.timeOf, snapshotTime: ts, exclude });
let holders = 0;
for (const s of list.state.values()) if (s.balance > 0n) holders++;

const ended = await chunkedLogs(pub, async (a, b) => (await Promise.all(["Settled", "RolledOver"].map((eventName) => pub.getContractEvents({ address: cfg.draw, abi: drawAbi, eventName, fromBlock: a, toBlock: b })))).flat(), { fromBlock: BigInt(cfg.startBlock || 0), toBlock: block.number });
const winners = [];
for (const l of ended.slice(-20).reverse()) {
  const d = await v("getDraw", [l.args.id]);
  const blk = await pub.getBlock({ blockNumber: l.blockNumber });
  const rolled = l.eventName === "RolledOver";
  const row = { id: Number(l.args.id), kind: rolled ? "rolled" : "paid", track: Number(d.track) === 1 ? "mega" : "regular", winner: rolled ? null : l.args.winner, amountWei: (rolled ? d.amount : l.args.amount).toString(), tx: l.transactionHash, at: Number(blk.timestamp) };
  if (!rolled) {
    const at = await listAtTime({ logs, timeOf: times.timeOf, snapshotTime: d.snapshotTime, exclude });
    const ws = at.state.get(l.args.winner.toLowerCase());
    if (ws) row.heldSeconds = Number(BigInt(d.snapshotTime) - ws.holdStart);
    const b = await boughtFromPool({ pub, token: cfg.token, pools: [cfg.curve, cfg.poolManager].filter(Boolean), skip: exclude, wallet: l.args.winner, beforeTs: Number(d.snapshotTime), balance: ws?.balance ?? null, fromBlock: BigInt(cfg.startBlock || 0), toBlock: l.blockNumber });
    Object.assign(row, { firstBuyAt: b.boughtWei > 0n ? b.at : null, firstBuyTx: b.boughtWei > 0n ? b.tx : null, poolFlag: poolFlagOf(b), boughtWei: b.boughtWei.toString() });
  }
  winners.push(row);
}

const launch = Number(cfg.launchTime) || Number(await times.timeOf(logs[0].blockNumber));
const HOUR = 3600, DAY = 86400;
const due = (track, i) => (track === 1 ? launch + i * 7 * DAY : i <= 6 ? launch + i * HOUR : launch + 10 * HOUR + (i - 7) * 4 * HOUR);
const next = (track) => { let i = 1; while (due(track, i) <= Number(ts)) i++; return due(track, i); };
const now = Math.floor(Date.now() / 1000);
const snapshot = {
  updatedAt: now, chainId: await pub.getChainId(), draw: cfg.draw, token: cfg.token,
  pot: { regularWei: potRegular.toString(), megaWei: potMega.toString() },
  next: { regularAt: next(0), megaAt: next(1) },
  eligibleCount: list.rows.length, holders, winners,
  swarmCheck: {
    lastAt: now - 3600, nextAllowedAt: now - 60, status: "attested",
    answer: { checked: winners.map((w) => w.id), allMatch: true, note: "MOCK answer for local testing" },
    attestationUrl: "https://api.imd.fun/oracle/requests/mock/attestation",
    question: "Recompute the last Tombola draws from public data. Do the winners match?",
  },
};
const dir = join(root, "mock");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "snapshot.json"), JSON.stringify(snapshot, null, 2) + "\n");
console.log(`mock/snapshot.json: ${winners.length} winners, ${list.rows.length} eligible, ${holders} holders`);
