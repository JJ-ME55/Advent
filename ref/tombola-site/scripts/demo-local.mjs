// Local end-to-end demo for the site, the Pons version: like bot/pons/demo-local.mjs (which uses port 8545 and the
// main deployments/pons-local.json), but against the site's own Anvil on 8574 and mock/pons-local.json, publishing
// the keeper's draw files under mock/draws. Needs about 10 minutes (the committed drand round must be published).
//   anvil-site-pons.exe --port 8574 --timestamp $(( $(date +%s) - 7200 )) --code-size-limit 100000 --gas-limit 300000000
//   cd contracts && forge script script/pons/LocalPonsDemo.s.sol --tc LocalPonsDemo --rpc-url http://127.0.0.1:8574 \
//     --private-key <anvil #0> --broadcast --code-size-limit 100000 && cp deployments/pons-local.json ../site/mock/
//   node scripts/demo-local.mjs
// Uses Anvil's well-known test keys only. anvil #0 (the deployer) holds the unsold supply and stands in for Pons'
// curve: the keeper excludes it (EXCLUDE), as config.local.js names it as `curve`.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createPublicClient, createTestClient, http, parseAbi } from "viem";

const root = fileURLToPath(new URL("..", import.meta.url));
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8574";
const dep = JSON.parse(readFileSync(join(root, "mock", "pons-local.json"), "utf8"));
const pub = createPublicClient({ transport: http(RPC) });
const testc = createTestClient({ mode: "anvil", transport: http(RPC) });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const KEEPER_KEY = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"; // anvil #9
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"; // anvil #0

const env = {
  ...process.env, RPC_URL: RPC, DRAW: dep.draw, SPLITTER: dep.splitter, TOKEN: dep.token, START_BLOCK: String(dep.launchBlock),
  LAUNCH_TIME: String(dep.launchTime), KEEPER_KEY, ONCE: "1", LOCAL_DEMO: "1", EXCLUDE: DEPLOYER,
  DRAWS_DIR: join(root, "mock", "draws"), STATE_FILE: join(root, "mock", ".keeper-state.json"),
};
const keeper = () => { const r = spawnSync(process.execPath, [join(root, "..", "bot", "pons", "keeper.mjs")], { env, stdio: "inherit" }); if (r.status !== 0) throw new Error(`keeper exited ${r.status}`); };
const toNow = async () => { await testc.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }); await testc.mine({ blocks: 1 }); };

log(`chain time ${(await pub.getBlock()).timestamp}, real time ${Math.floor(Date.now() / 1000)}; holders have held ${Math.floor(Date.now() / 1000) - Number(dep.launchTime)} s`);
await toNow(); // the chain started 2 h back, so the first slots are due
log("keeper run 1: harvest + commit");
keeper();

const drawAbi = parseAbi(["function getDraw(uint256) view returns ((uint8 track, uint64 snapshotTime, uint64 drandRound, uint128 amount, bytes32 root, uint256 totalWeight, uint256 randomWord, address winner, bool settled, bool cancelled))", "function drawCount() view returns (uint256)"]);
const n = await pub.readContract({ address: dep.draw, abi: drawAbi, functionName: "drawCount" });
if (n === 0n) throw new Error("no draw was committed");
const id = n - 1n;
const d = await pub.readContract({ address: dep.draw, abi: drawAbi, functionName: "getDraw", args: [id] });
const rt = 1727521075 + (Number(d.drandRound) - 1) * 3;
log(`draw ${id} committed: ${d.amount} wei, snapshot ${d.snapshotTime}, drand round ${d.drandRound} at ${rt}`);
const wait = rt + 8 - Math.floor(Date.now() / 1000);
if (wait > 0) { log(`waiting ${wait} s for drand to publish round ${d.drandRound}`); await new Promise((r) => setTimeout(r, wait * 1000)); }
await toNow();
log("keeper run 2: settle");
keeper();
const after = await pub.readContract({ address: dep.draw, abi: drawAbi, functionName: "getDraw", args: [id] });
log(`draw ${id} settled: winner ${after.winner}, root ${after.root}, total weight ${after.totalWeight}`);
log("site selftest:");
process.exit(spawnSync(process.execPath, [join(root, "scripts", "selftest.mjs")], { stdio: "inherit" }).status);
