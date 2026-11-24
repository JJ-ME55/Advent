// The Tombola keeper for the Pons launch. Every tick (TICK_SECONDS, default 60):
//   1. harvest: if the Pons escrow holds fees for the splitter, call splitter.harvest() (anyone may)
//   2. commit: for each track whose next slot is due and has no open draw, commit the whole pot to a drand round
//      COMMIT_DELAY after the snapshot time (the chain's clock at the previous block), if the pot is above MIN_DRAW;
//      committed LEAD before the slot so the round lands at the slot and the payout follows at once
//   3. settle: for each open draw whose round is published, rebuild the draw list from Transfer logs at the snapshot
//      block, publish the snapshot (rows, root, proofs) to DRAWS_DIR as draw-<id>.json (the public tombola-draws
//      repo), and settle on chain with drand's signature, the root and the winner's leaf; roll over if nobody was
//      eligible
//   4. alerts: a draw past its round by LATE_AFTER with no settle; the draw contract not solvent
// Environment: RPC_URL, DRAW (TombolaDraw), SPLITTER, TOKEN, ESCROW (Pons fee escrow), LAUNCH_TIME (the token's
// first block timestamp, the cadence anchor), START_BLOCK (the token's deploy block), KEEPER_KEY_FILE /
// KEEPER_ACCOUNT (see ../lib.mjs loadKey), DRAWS_DIR (default ../../draws), STATE_FILE, ALERT_WEBHOOK, ONCE=1.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseAbi, getAddress, keccak256 as keccak256Hex } from "viem";
import { clients, env, numEnv, drandRound, getLogsChunked, sortLogs, blockAtTime } from "../lib.mjs";
import { TRANSFER, replay, buildList, merkle, pick, randomWordOf, ZERO } from "./snapshot.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const drawAbi = parseAbi([
  "function potRegular() view returns (uint256)",
  "function potMega() view returns (uint256)",
  "function reserved() view returns (uint256)",
  "function solvent() view returns (bool)",
  "function drawCount() view returns (uint256)",
  "function activeDraw(uint8 track) view returns (uint256)",
  "function getDraw(uint256 id) view returns ((uint8 track, uint64 snapshotTime, uint64 drandRound, uint128 amount, bytes32 root, uint256 totalWeight, uint256 randomWord, address winner, bool settled, bool cancelled))",
  "function commit(uint8 track, uint64 snapshotTime, uint64 drandRound, uint256 amount, bytes32 root, uint256 totalWeight) returns (uint256)",
  "function settle(uint256 id, bytes drandSignature, address winner, uint256 cumulativeBefore, uint256 weight, bytes32[] proof)",
  "function rollover(uint256 id, bytes drandSignature)",
  "function beacon() view returns (address)",
  "function COMMIT_DELAY() view returns (uint256)",
]);
const splitterAbi = parseAbi(["function harvest()", "function escrow() view returns (address)"]);
const escrowAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const beaconAbi = parseAbi(["function roundAt(uint256) view returns (uint64)", "function roundTime(uint64) view returns (uint256)", "function randomness(uint64) view returns (bytes32)"]);

const DRAW = getAddress(env("DRAW")), SPLITTER = getAddress(env("SPLITTER")), TOKEN = getAddress(env("TOKEN"));
const LAUNCH_TIME = BigInt(env("LAUNCH_TIME")), START_BLOCK = BigInt(env("START_BLOCK"));
const TICK = numEnv("TICK_SECONDS", 60, { min: 10, max: 600 });
const MIN_DRAW = BigInt(env("MIN_DRAW_WEI", String(10n ** 15n))); // 0.001 ETH
const LATE_AFTER = numEnv("LATE_AFTER_SECONDS", 1800, { min: 60 });
const COMMIT_MARGIN = BigInt(numEnv("COMMIT_MARGIN_SECONDS", 120, { min: 15 })); // how long the commit tx may take to land
const LEAD = BigInt(numEnv("LEAD_SECONDS", 810, { min: 750 })); // commit this long before a slot: COMMIT_DELAY plus time for the tx and the tick
const DRAWS_DIR = process.env.DRAWS_DIR ?? join(here, "..", "..", "draws");
const STATE_FILE = process.env.STATE_FILE ?? join(here, `.pons-keeper-${DRAW.toLowerCase()}.json`);
const EXCLUDE = new Set((process.env.EXCLUDE ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
// the unsold supply sits in the Pons curve (and, after graduation, the v4 PoolManager): both would "win" most draws
// if they weren't excluded. The draw and splitter hold no tokens but are excluded for completeness. On a real chain
// the keeper refuses to start without the curve and the PoolManager in EXCLUDE; LOCAL_DEMO=1 skips that check.
for (const a of [DRAW, SPLITTER]) EXCLUDE.add(a.toLowerCase());
if (process.env.LOCAL_DEMO !== "1") {
  const need = { CURVE: process.env.CURVE, POOL_MANAGER: process.env.POOL_MANAGER ?? "0x8366a39CC670B4001A1121B8F6A443A643e40951" };
  for (const [k, v] of Object.entries(need)) {
    if (!v) throw new Error(`${k} is required: the unsold supply there must be excluded from draws`);
    EXCLUDE.add(getAddress(v).toLowerCase());
  }
}
const HOUR = 3600n, DAY = 86400n;
const log = (...a) => console.log(new Date().toISOString(), ...a);

// the same cadence as the vault: hourly for the first 6 hours, then every 4 hours; mega weekly
const dueTime = (track, i) => (track === 1 ? LAUNCH_TIME + BigInt(i) * 7n * DAY : i <= 6 ? LAUNCH_TIME + BigInt(i) * HOUR : LAUNCH_TIME + 10n * HOUR + BigInt(i - 7) * 4n * HOUR);
function latestDue(track, now) {
  let i = 0;
  while (dueTime(track, i + 1) <= now) i++;
  return i;
}

let state = { lastIndex: { 0: 0, 1: 0 }, alerts: {} };
try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* first run */ }
const saveState = () => { writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 1)); renameSync(`${STATE_FILE}.tmp`, STATE_FILE); };

async function alert(key, text, every = 3600) {
  const now = Math.floor(Date.now() / 1000);
  if (state.alerts[key] && now - state.alerts[key] < every) return;
  state.alerts[key] = now; saveState();
  log("ALERT", text);
  if (process.env.ALERT_WEBHOOK) {
    try { await fetch(process.env.ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `Tombola keeper: ${text}` }), signal: AbortSignal.timeout(10_000) }); } catch { /* best effort */ }
  }
}

const { pub, wallet } = await clients({ needWallet: true });
const beacon = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "beacon" });
const COMMIT_DELAY = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "COMMIT_DELAY" });
const escrow = await pub.readContract({ address: SPLITTER, abi: splitterAbi, functionName: "escrow" });
log(`keeper ${wallet.account.address} on draw ${DRAW}, splitter ${SPLITTER}, token ${TOKEN}, escrow ${escrow}`);
mkdirSync(DRAWS_DIR, { recursive: true });

async function send(label, request) {
  const hash = await wallet.writeContract(request);
  const rc = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  log(`${label} ${rc.status} gas ${rc.gasUsed} tx ${hash}`);
  if (rc.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  return rc;
}

async function harvest() {
  if (escrow === ZERO) return;
  const pending = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [SPLITTER] });
  const loose = await pub.getBalance({ address: SPLITTER });
  if (pending + loose < MIN_DRAW / 10n) return;
  const { request } = await pub.simulateContract({ address: SPLITTER, abi: splitterAbi, functionName: "harvest", account: wallet.account });
  await send(`harvest(${pending + loose} wei)`, request);
}

async function commitDue(track) {
  const open = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "activeDraw", args: [track] });
  if (open !== 0n) return;
  const head = await pub.getBlock();
  const now = head.timestamp;
  const last = state.lastIndex[track] ?? 0;
  // The snapshot is taken and the draw committed LEAD before the slot, pinned to the drand round that lands AT the
  // slot: the countdown on the site ends with the payout, not with a second wait. A slot the keeper missed (it was
  // down) is committed as soon as it is seen, to a round COMMIT_DELAY ahead.
  let slot, roundTarget;
  const due = latestDue(track, now);
  if (due > last) { slot = due; roundTarget = now + COMMIT_DELAY + COMMIT_MARGIN; }
  else if (now + LEAD >= dueTime(track, last + 1)) { slot = last + 1; roundTarget = dueTime(track, slot); }
  else return;
  if (roundTarget < now + COMMIT_DELAY + COMMIT_MARGIN) roundTarget = now + COMMIT_DELAY + COMMIT_MARGIN; // the window was missed: the old timing
  const pot = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: track === 0 ? "potRegular" : "potMega" });
  if (pot < MIN_DRAW) { log(`track ${track} slot ${slot} due but the pot is ${pot} wei: waiting`); return; }
  // the snapshot is the previous second: every block at or before it is final, and nobody can trade into it after
  // seeing the commit. The list is built now and pinned in the commit (root and total weight), so the contract can
  // hold the keeper to it once the round is out.
  const snapshotTime = head.timestamp - 1n;
  const { snapBlock, logs, rows, totalWeight } = await listAt(snapshotTime);
  const { root, proofs } = merkle(rows);
  const round = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "roundAt", args: [roundTarget] });
  const { request, result: id } = await pub.simulateContract({ address: DRAW, abi: drawAbi, functionName: "commit", args: [track, snapshotTime, round, pot, root, totalWeight], account: wallet.account });
  await send(`commit(track ${track}, slot ${slot}, snapshot ${snapshotTime} @ block ${snapBlock}, ${rows.length} eligible, total ${totalWeight}, root ${root}, round ${round} at ${roundTarget}, ${pot} wei) -> draw ${id}`, request);
  state.lastIndex[track] = slot; saveState();
  publish(id, { track, snapshotTime, drandRound: round, amount: pot }, { snapBlock, logs, rows, totalWeight, root, proofs }, null);
}

/** the published snapshot: the whole list with proofs at commit, the winner added at settle */
function publish(id, d, list, chosen) {
  const file = join(DRAWS_DIR, `draw-${id}.json`);
  writeFileSync(file, JSON.stringify({
    id: Number(id), track: Number(d.track), snapshotTime: Number(d.snapshotTime), snapshotBlock: Number(list.snapBlock), drandRound: Number(d.drandRound), amount: d.amount.toString(),
    transfersReplayed: list.logs, root: list.root, totalWeight: list.totalWeight.toString(),
    randomWord: chosen ? chosen.word.toString() : null,
    winner: chosen?.pick ? { account: chosen.pick.row.account, index: chosen.pick.index, target: chosen.pick.target.toString() } : null,
    exclude: [...EXCLUDE],
    rows: list.rows.map((r, i) => ({ account: r.account, balance: r.balance.toString(), holdStart: Number(r.holdStart), weight: r.weight.toString(), cumulativeBefore: r.cumulativeBefore.toString(), proof: list.proofs[i] })),
  }, null, 1));
  return file;
}

/** the draw list at the snapshot: every Transfer from START_BLOCK through the last block at or before snapshotTime */
async function listAt(snapshotTime) {
  const head = await pub.getBlock();
  // blockAtTime gives the first block at or after snapshotTime; the snapshot is the last block at or before it
  const snapBlock = await snapshotBlock(pub, snapshotTime, head.number);
  const logs = sortLogs(await getLogsChunked((a, b) => pub.getLogs({ address: TOKEN, event: TRANSFER, fromBlock: a, toBlock: b }), START_BLOCK, snapBlock));
  const times = new Map();
  const timeOf = async (b) => { if (!times.has(b)) times.set(b, (await pub.getBlock({ blockNumber: b })).timestamp); return times.get(b); };
  const st = await replay(logs, timeOf, { exclude: EXCLUDE });
  return { snapBlock, logs: logs.length, ...buildList(st, snapshotTime) };
}

export async function snapshotBlock(pub, snapshotTime, headNumber) {
  const first = await blockAtTime((b) => pub.getBlock({ blockNumber: b }).then((x) => x.timestamp), snapshotTime, START_BLOCK, headNumber);
  if (first > headNumber) return headNumber;
  const t = (await pub.getBlock({ blockNumber: first })).timestamp;
  return t === BigInt(snapshotTime) ? first : first - 1n;
}

async function settleReady(id) {
  const d = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "getDraw", args: [id] });
  if (d.settled || d.cancelled) return;
  const now = (await pub.getBlock()).timestamp;
  const roundTime = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "roundTime", args: [d.drandRound] });
  if (now < roundTime + 5n) return;
  const stored = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "randomness", args: [d.drandRound] });
  let sig = "0x";
  let randomness = stored;
  if (stored === `0x${"0".repeat(64)}`) {
    const r = await drandRound(d.drandRound);
    if (r.status !== "signed") {
      if (now > roundTime + BigInt(LATE_AFTER)) await alert(`late-${id}`, `draw ${id}: drand round ${d.drandRound} ${r.status} ${Number(now - roundTime)} s after its time`);
      return;
    }
    sig = r.sig;
    randomness = keccak256Hex(sig);
  }
  const { snapBlock, logs, rows, totalWeight } = await listAt(d.snapshotTime);
  const { root, proofs } = merkle(rows);
  if (root !== d.root || totalWeight !== d.totalWeight) {
    // the list we rebuild now differs from the one pinned at commit: never settle against a list we can't reproduce
    await alert(`mismatch-${id}`, `draw ${id}: the rebuilt list (root ${root}, total ${totalWeight}) differs from the pinned one (${d.root}, ${d.totalWeight}); not settling`, 600);
    return;
  }
  const word = randomWordOf(randomness, id);
  const chosen = pick(rows, totalWeight, word);
  const file = publish(id, d, { snapBlock, logs, rows, totalWeight, root, proofs }, { word, pick: chosen });
  log(`draw ${id}: ${rows.length} eligible wallets at block ${snapBlock}, total weight ${totalWeight}, root ${root}, winner ${chosen?.row.account ?? "nobody"}; published ${file}`);
  if (!chosen) {
    const { request } = await pub.simulateContract({ address: DRAW, abi: drawAbi, functionName: "rollover", args: [id, sig], account: wallet.account });
    await send(`rollover(${id})`, request);
    return;
  }
  const r = chosen.row;
  const { request } = await pub.simulateContract({ address: DRAW, abi: drawAbi, functionName: "settle", args: [id, sig, r.account, r.cumulativeBefore, r.weight, proofs[chosen.index]], account: wallet.account });
  await send(`settle(${id}) -> ${r.account} ${d.amount} wei`, request);
}

async function tick() {
  for (const [name, fn] of [["harvest", harvest], ["commit regular", () => commitDue(0)], ["commit mega", () => commitDue(1)]]) {
    try { await fn(); } catch (e) { log(`${name}: ${e.shortMessage ?? e.message}`); }
  }
  try {
    const n = await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "drawCount" });
    for (let id = n > 10n ? n - 10n : 0n; id < n; id++) {
      try { await settleReady(id); } catch (e) { log(`settle ${id}: ${e.shortMessage ?? e.message}`); }
    }
  } catch (e) { log(`drawCount: ${e.shortMessage ?? e.message}`); }
  try {
    if (!(await pub.readContract({ address: DRAW, abi: drawAbi, functionName: "solvent" }))) await alert("solvency", "TombolaDraw is NOT solvent", 600);
  } catch (e) { log(`solvency: ${e.shortMessage ?? e.message}`); }
}

if (process.env.ONCE === "1") { await tick(); process.exit(0); }
for (;;) { await tick(); await new Promise((r) => setTimeout(r, TICK * 1000)); }
