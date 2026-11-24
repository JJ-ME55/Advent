// Quick checks of src/draw.js against the local Pons demo chain (Anvil on 8574, config.local.js's addresses):
// the pool-buy heuristic with the curve stand-in as the buy source, Verify of the settled draw 0 with an honest row
// (every check passes), and a tampered winner row (fails). Usage: node scripts/selftest.mjs [rpcUrl] [configFile]
import { createPublicClient, http } from "viem";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { boughtFromPool, verifyDraw, verifySummary } from "../src/draw.js";
import { drawAbi } from "../src/generated/abis.js";
import { readConfig } from "./build.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const cfg = readConfig(join(root, process.argv[3] ?? "config.local.js"));
const pub = createPublicClient({ transport: http(process.argv[2] ?? cfg.rpcUrl) });
const exclude = [...(cfg.exclude ?? []), cfg.draw, cfg.splitter, cfg.curve, cfg.poolManager].filter(Boolean);
const pools = [cfg.curve, cfg.poolManager].filter(Boolean);
const buyer = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1: 20k from the deployer (the curve stand-in)
let failures = 0;
const expect = (c, what) => { console.log(`${c ? "ok  " : "FAIL"} ${what}`); if (!c) failures++; };

const b = await boughtFromPool({ pub, token: cfg.token, pools, skip: exclude, wallet: buyer, fromBlock: BigInt(cfg.startBlock || 0) });
console.log("buyer:", b.how || b.bought);
expect(b.bought === true, "anvil #1's tokens came from the curve stand-in");

const n = await pub.readContract({ address: cfg.draw, abi: drawAbi, functionName: "drawCount" });
if (n === 0n) { console.log("no draw yet: run the keeper (see README) and try again"); process.exit(failures ? 1 : 0); }
const d = await pub.readContract({ address: cfg.draw, abi: drawAbi, functionName: "getDraw", args: [0n] });
if (!d.settled) { console.log("draw 0 isn't settled yet"); process.exit(failures ? 1 : 0); }
const common = { pub, draw: cfg.draw, token: cfg.token, startBlock: cfg.startBlock || 0, exclude, pools };
const [settled] = await pub.getContractEvents({ address: cfg.draw, abi: drawAbi, eventName: "Settled", args: { id: 0n }, fromBlock: BigInt(cfg.startBlock || 0) });
const honest = await verifyDraw({ ...common, id: 0, row: { winner: d.winner, amountWei: d.amount.toString(), track: "regular", kind: "paid", tx: settled?.transactionHash } });
for (const c of honest.checks) console.log("   ", c.status.padEnd(4), c.text);
console.log("   ", verifySummary(honest, "anvil")[1]);
expect(honest.ok && !honest.checks.some((c) => c.status === "fail"), "the honest row verifies");
expect(honest.incomplete === false || honest.incompleteWhy.every((w) => /drand|relays/.test(w)), "only drand relay gaps (if any) are incomplete");
const tampered = await verifyDraw({ ...common, id: 0, row: { winner: buyer === d.winner ? "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" : buyer, amountWei: d.amount.toString(), track: "regular", kind: "paid", tx: settled?.transactionHash } });
expect(tampered.ok === false, "a tampered winner row fails");
console.log(failures ? `${failures} FAILED` : "selftest passed");
process.exit(failures ? 1 : 0);
