// Local end-to-end demo for the X bot on a Pons-style chain: Anvil on port 8546 (other agents use 8545 and 8547),
// the LocalPonsDemo contracts (beacon, plain token, escrow stand-in, TombolaDraw, TombolaSplitter), four holders, then
// the real keeper (bot/pons/keeper.mjs, anvil #9) committing to a REAL drand round and settling it, and verify-draw.
// Start Anvil with its clock two hours behind, deploy, then run this; the keeper waits about 10 minutes for drand.
//
//   anvil --port 8546 --timestamp $(( $(date +%s) - 7200 )) --code-size-limit 100000 --gas-limit 300000000
//   (cd ../contracts && forge script script/pons/LocalPonsDemo.s.sol --tc LocalPonsDemo --rpc-url http://127.0.0.1:8546 \
//      --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --broadcast)
//   node scripts/demo-local.mjs
//
// The deployment file is contracts/deployments/pons-local.json (written by the forge script). Uses Anvil's
// well-known test keys only. The Worker (wrangler dev) reads the same chain with DRAW/TOKEN/SPLITTER/CURVE/START_BLOCK
// from that file; CURVE is anvil #0, which holds the unsold supply here as the Pons curve does on the real chain.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createPublicClient, createTestClient, http, parseAbi } from "viem";

const RPC = process.env.DEMO_RPC ?? "http://127.0.0.1:8546";
const dep = JSON.parse(readFileSync(new URL("../../contracts/deployments/pons-local.json", import.meta.url), "utf8"));
const pub = createPublicClient({ transport: http(RPC) });
const testc = createTestClient({ mode: "anvil", transport: http(RPC) });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const KEEPER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"; // anvil #9
const CURVE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil #0: the deployer holds the unsold supply
const keeperDir = new URL("../../bot/pons/", import.meta.url);
const env = {
  ...process.env, RPC_URL: RPC, DRAW: dep.draw, SPLITTER: dep.splitter, TOKEN: dep.token, START_BLOCK: String(dep.launchBlock), LAUNCH_TIME: String(dep.launchTime),
  KEEPER_KEY, CURVE, ONCE: "1", DRAWS_DIR: new URL("../draws-local/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), STATE_FILE: new URL("../.pons-demo-state.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
};
const keeper = () => { const r = spawnSync(process.execPath, ["keeper.mjs"], { env, stdio: "inherit", cwd: keeperDir }); if (r.status !== 0) throw new Error(`keeper exited ${r.status}`); };

const real = BigInt(Math.floor(Date.now() / 1000));
log(`chain time ${(await pub.getBlock()).timestamp}, real time ${real}; holders have held ${real - BigInt(dep.launchTime)} s`);
await testc.setNextBlockTimestamp({ timestamp: real });
await testc.mine({ blocks: 1 });
log("keeper run 1: harvest + commit");
keeper();
const drawAbi = parseAbi(["function getDraw(uint256) view returns ((uint8 track, uint64 snapshotTime, uint64 drandRound, uint128 amount, bytes32 root, uint256 totalWeight, uint256 randomWord, address winner, bool settled, bool cancelled))", "function drawCount() view returns (uint256)"]);
const beaconAbi = parseAbi(["function roundTime(uint64) view returns (uint256)"]);
const n = await pub.readContract({ address: dep.draw, abi: drawAbi, functionName: "drawCount" });
if (n === 0n) throw new Error("no draw was committed");
const d = await pub.readContract({ address: dep.draw, abi: drawAbi, functionName: "getDraw", args: [n - 1n] });
const rt = await pub.readContract({ address: dep.beacon, abi: beaconAbi, functionName: "roundTime", args: [d.drandRound] });
const wait = Number(rt) + 8 - Math.floor(Date.now() / 1000);
if (wait > 0) { log(`waiting ${wait} s for drand to publish round ${d.drandRound}`); await new Promise((r) => setTimeout(r, wait * 1000)); }
await testc.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
await testc.mine({ blocks: 2 }); // the Worker's CONFIRMATIONS floor is 2
log("keeper run 2: settle");
keeper();
const after = await pub.readContract({ address: dep.draw, abi: drawAbi, functionName: "getDraw", args: [n - 1n] });
log(`draw ${n - 1n} settled: winner ${after.winner}, root ${after.root}, total weight ${after.totalWeight}`);
const v = spawnSync(process.execPath, ["verify-draw.mjs", String(n - 1n)], { env, stdio: "inherit", cwd: keeperDir });
process.exit(v.status);
