// The ADVENT keeper. Every tick (TICK_SECONDS, default 20):
//   1. claim: sweep pump.fun creator fees into the treasury when the vault holds > CLAIM_MIN_SOL, then split what
//      arrived 70/10/10/10 to the door, Christmas, bonus and team wallets (every split is a plain transfer with a memo);
//   2. snapshot + commit: at a door's snapshot time (door time - 10 min) build the list from the coin's balance
//      history, publish it to DRAWS_DIR, send the commit memo;
//   3. settle: once the door's drand round is out, fix the winners and their prizes (door and bonus box). Nothing is
//      paid: a winner finds out by opening their door on the site and claims there (api.mjs + claims.mjs). The full
//      result goes to RESULTS_DIR (private); the published door-<d>.json names a winner only once they've opened;
//   4. publish snapshot.json for the site and the bot; alert on anything that fails.
// Environment: RPC_URL (comma list), HELIUS_API_KEY, MINT, TREASURY_KEYPAIR (pump creator wallet), DOOR_KEYPAIR,
// BONUS_KEYPAIR, XMAS_WALLET, TEAM_WALLET, EXCLUDE (comma list; curve/pool/treasury/door/bonus/xmas/team are added),
// DRAWS_DIR (public), RESULTS_DIR and CLAIMS_FILE (private, shared with the API), STATE_FILE, BONUS_ENTRANTS_FILE
// (json array per door, written by the API), ALERT_WEBHOOK, ONCE=1.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connections, loadKeypair, balanceOf, sendSol, sendMemo, heliusDeltas, rpcDeltas, PublicKey, LAMPORTS_PER_SOL } from "./solana.mjs";
import { snapshot, commit, settle } from "./draw.mjs";
import { replay, buildList } from "./drum.mjs";
import { nextDoor, isSnapshotDue, isSettleDue, doorTime, doorRoundTime, LAST_DOOR } from "./doors.mjs";
import { claimCreatorFees } from "./claim.mjs";
import { createClaims } from "./claims.mjs";

const env = (k, d) => { const v = process.env[k] ?? d; if (v === undefined || v === "") throw new Error(`${k} is required`); return v; };
const num = (k, d) => Number(process.env[k] ?? d);
const log = (...a) => console.log(new Date().toISOString(), ...a);

const TICK = num("TICK_SECONDS", 20);
const CLAIM_MIN = BigInt(Math.round(num("CLAIM_MIN_SOL", 0.05) * LAMPORTS_PER_SOL));
const RESERVE = BigInt(Math.round(num("RESERVE_SOL", 0.02) * LAMPORTS_PER_SOL)); // gas kept in every hot wallet
const SPLIT = { door: 7000n, xmas: 1000n, bonus: 1000n, team: 1000n };
const MINT = env("MINT");
const DRAWS_DIR = process.env.DRAWS_DIR ?? "./draws";
const STATE_FILE = process.env.STATE_FILE ?? "./state/keeper-state.json";
const ENTRANTS_FILE = process.env.BONUS_ENTRANTS_FILE ?? "./state/bonus-entrants.json";
const RESULTS_DIR = process.env.RESULTS_DIR ?? "./state/results";
const CLAIMS_FILE = process.env.CLAIMS_FILE ?? "./state/claims.json";
mkdirSync(DRAWS_DIR, { recursive: true }); mkdirSync(join(STATE_FILE, ".."), { recursive: true }); mkdirSync(RESULTS_DIR, { recursive: true });
const claims = createClaims({ file: CLAIMS_FILE, resultsDir: RESULTS_DIR }); // read-only here: the API writes it
const json = (v) => JSON.stringify(v, (k, x) => (typeof x === "bigint" ? x.toString() : x), 1);

const conns = connections();
const treasury = loadKeypair(env("TREASURY_KEYPAIR"));
const door = loadKeypair(env("DOOR_KEYPAIR"));
const bonus = loadKeypair(env("BONUS_KEYPAIR"));
const xmas = new PublicKey(env("XMAS_WALLET")), team = new PublicKey(env("TEAM_WALLET"));
const wallets = { door: door.publicKey, xmas, bonus: bonus.publicKey, team };
const EXCLUDE = [...new Set([...(process.env.EXCLUDE ?? "").split(",").map((s) => s.trim()).filter(Boolean), treasury.publicKey.toBase58(), door.publicKey.toBase58(), bonus.publicKey.toBase58(), xmas.toBase58(), team.toBase58()])];
const cfg = { mint: MINT, exclude: EXCLUDE, doorWallet: door.publicKey.toBase58(), reserveLamports: RESERVE, floorLamports: BigInt(Math.round(num("FLOOR_SOL", 0.1) * LAMPORTS_PER_SOL)) };

let state = { doors: {}, claimed: "0", split: "0", alerts: {}, lastDeltaSig: null };
try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* first run */ }
const save = () => { writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1)); renameSync(`${STATE_FILE}.tmp`, STATE_FILE); };
let deltaCache = [];
const CACHE_FILE = join(DRAWS_DIR, "deltas.json");
try { deltaCache = JSON.parse(readFileSync(CACHE_FILE, "utf8")).map((d) => ({ ...d, delta: BigInt(d.delta) })); } catch { /* none yet */ }

async function alert(key, text, every = 3600) {
  const now = Math.floor(Date.now() / 1000);
  if (state.alerts[key] && now - state.alerts[key] < every) return;
  state.alerts[key] = now; save();
  log("ALERT", text);
  if (process.env.ALERT_WEBHOOK) { try { await fetch(process.env.ALERT_WEBHOOK, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: `ADVENT keeper: ${text}` }), signal: AbortSignal.timeout(10_000) }); } catch { /* best effort */ } }
}

const chain = {
  now: () => Math.floor(Date.now() / 1000),
  deltas: async (mint, untilSig) => {
    const fresh = process.env.HELIUS_API_KEY ? await heliusDeltas(mint, { untilSignature: untilSig }) : await rpcDeltas(conns, mint, { seen: new Set(deltaCache.map((d) => d.signature)) });
    if (fresh.length) { deltaCache = deltaCache.concat(fresh); writeFileSync(CACHE_FILE, JSON.stringify(deltaCache, (k, v) => (typeof v === "bigint" ? v.toString() : v))); }
    return fresh;
  },
  balance: (a) => balanceOf(conns, a),
  sendMemo: (text) => sendMemo(conns, treasury, text),
  sendSol: (to, lamports, memo) => sendSol(conns, door, to, lamports, memo),
};

async function claimAndSplit() {
  if (process.env.CLAIM === "0") return; // no pump.fun on devnet: fees arrive by hand
  const got = await claimCreatorFees(conns, treasury, MINT, CLAIM_MIN);
  if (!got) return;
  log(`claim(${got.lamports} lamports) tx ${got.signature}`);
  state.claimed = (BigInt(state.claimed) + got.lamports).toString();
  const spendable = (await balanceOf(conns, treasury.publicKey)) - RESERVE;
  if (spendable <= 0n) return;
  for (const [name, bps] of Object.entries(SPLIT)) {
    const amt = (spendable * bps) / 10_000n;
    if (amt <= 0n) continue;
    const r = await sendSol(conns, treasury, wallets[name], amt, `ADVENT split ${name} ${bps}bps`);
    log(`split(${name}, ${amt} lamports) tx ${r.signature}`);
  }
  state.split = (BigInt(state.split) + spendable).toString(); save();
}

async function doors() {
  const now = chain.now();
  const d = nextDoor(now - 3600) ?? LAST_DOOR; // the door whose window we're in or just past
  for (const id of [d - 1, d]) {
    if (id < Number(process.env.FIRST_DOOR ?? 1) || id > LAST_DOOR) continue;
    const s = (state.doors[id] ??= {});
    if (!s.committed && isSnapshotDue(id, now)) {
      const bonusPot = (await balanceOf(conns, bonus.publicKey)) - RESERVE;
      const snap = await snapshot(chain, cfg, id, { cachedDeltas: deltaCache.slice() });
      if (snap.winners === 0) { log(`door ${id}: nothing to draw (pot ${snap.pot}, eligible ${snap.rows.length})`); s.skipped = { pot: snap.pot.toString(), eligible: snap.rows.length }; save(); continue; }
      const c = await commit(chain, snap);
      log(`commit(door ${id}, snapshot ${snap.snapshotTime}, ${snap.rows.length} eligible, total ${snap.totalWeight}, hash ${snap.hash}, round ${snap.round}, ${snap.pot} lamports, ${snap.winners} winners) tx ${c.signature}`);
      s.snapshot = { ...snap.doc, pot: snap.pot.toString(), winners: snap.winners, round: snap.round.toString(), bonusPot: (bonusPot > 0n ? bonusPot : 0n).toString() };
      s.committed = { signature: c.signature, slot: c.slot, blockTime: c.blockTime, memo: c.memo };
      writeFileSync(join(DRAWS_DIR, `door-${id}.json`), JSON.stringify({ ...s.snapshot, commit: s.committed }, null, 1));
      save();
    }
    if (s.committed && !s.settled && isSettleDue(id, now)) {
      const snap = rehydrate(id, s);
      let entrants = [];
      try { entrants = JSON.parse(readFileSync(ENTRANTS_FILE, "utf8"))[id] ?? []; } catch { /* no game yet */ }
      const r = await settle(chain, cfg, snap, { bonusEntrants: entrants, bonusPotLamports: BigInt(s.snapshot.bonusPot) });
      if (r.status !== "settled") { if (now > doorRoundTime(id) + num("LATE_AFTER_SECONDS", 600)) await alert(`late-${id}`, `door ${id}: drand round ${snap.round} still unpublished ${now - doorRoundTime(id)} s after its time`); continue; }
      for (const w of r.winners) log(`settle(door ${id}) -> winner ${w.k}: ${w.account} ${w.lamports} lamports, awaiting claim`);
      for (const w of r.bonus) log(`bonus(door ${id}) -> winner ${w.k}: ${w.account} ${w.lamports} lamports, awaiting claim`);
      s.settled = { signature: r.signature, seed: r.seed, winners: r.winners, bonus: r.bonus, at: now };
      writeFileSync(join(RESULTS_DIR, `door-${id}.json`), json({ door: id, hash: snap.hash, round: s.snapshot.round, ...s.settled }));
      writeFileSync(join(DRAWS_DIR, `door-${id}.json`), json({ ...s.snapshot, commit: s.committed, result: publicResult(id, s.settled) }));
      save();
    }
  }
}

function rehydrate(id, s) {
  const rows = s.snapshot.rows.map((r) => ({ ...r, balance: BigInt(r.balance), weight: BigInt(r.weight), cumulativeBefore: BigInt(r.cumulativeBefore) }));
  return { door: id, snapshotTime: s.snapshot.snapshotTime, rows, totalWeight: BigInt(s.snapshot.totalWeight), hash: s.committed.memo.match(/hash=([0-9a-f]{64})/)[1], pot: BigInt(s.snapshot.pot), winners: s.snapshot.winners, round: BigInt(s.snapshot.round) };
}

/** A settled result as the world may see it: seed and signature in full, every prize, names only once opened. */
function publicResult(id, settled) {
  return { signature: settled.signature, seed: settled.seed, at: settled.at, winners: claims.scrub("door", id, settled.winners), bonus: claims.scrub("bonus", id, settled.bonus) };
}

async function publish() {
  claims.reload(); // the API has been writing opens and claims
  const [t, dw, xw, bw] = await Promise.all([treasury.publicKey, door.publicKey, xmas, bonus.publicKey].map((a) => balanceOf(conns, a)));
  const now = chain.now();
  const next = nextDoor(now);
  let eligibleNow = null, totalTicketsNow = null;
  try { const { rows, totalWeight } = buildList(replay(deltaCache, now, { exclude: new Set(EXCLUDE) }), now); eligibleNow = rows.length; totalTicketsNow = totalWeight.toString(); } catch { /* incomplete history: leave null */ }
  const out = {
    at: now, mint: MINT, eligibleNow, totalTicketsNow, wallets: Object.fromEntries(Object.entries(wallets).map(([k, v]) => [k, v.toBase58()])), treasury: treasury.publicKey.toBase58(),
    pots: { treasury: t.toString(), door: (dw > RESERVE ? dw - RESERVE : 0n).toString(), xmas: xw.toString(), bonus: (bw > RESERVE ? bw - RESERVE : 0n).toString() },
    claimed: state.claimed, nextDoor: next, nextDoorAt: next ? doorTime(next) : null, exclude: EXCLUDE,
    doors: Object.fromEntries(Object.entries(state.doors).map(([k, v]) => [k, { committed: !!v.committed, settled: !!v.settled, eligible: v.snapshot?.rows?.length ?? null, pot: v.snapshot?.pot ?? null, ...(v.settled ? { door: claims.publicView("door", Number(k), v.settled), bonus: claims.publicView("bonus", Number(k), v.settled) } : {}) }])),
  };
  writeFileSync(join(DRAWS_DIR, "snapshot.json"), json(out));
  // a settled door's public file follows the opens and claims as they come in
  for (const [k, v] of Object.entries(state.doors)) if (v.settled) writeFileSync(join(DRAWS_DIR, `door-${k}.json`), json({ ...v.snapshot, commit: v.committed, result: publicResult(Number(k), v.settled) }));
}

async function tick() {
  for (const [name, fn] of [["claim", claimAndSplit], ["doors", doors], ["publish", publish]]) {
    try { await fn(); } catch (e) { log(`${name}: ${e.message}`); if (name === "doors") await alert("doors", `${name}: ${e.message}`, 600); }
  }
}

log(`keeper ${treasury.publicKey.toBase58()} on mint ${MINT}; door wallet ${door.publicKey.toBase58()}; excluded ${EXCLUDE.length}`);
if (process.env.ONCE === "1") { await tick(); process.exit(0); }
for (;;) { await tick(); await new Promise((r) => setTimeout(r, TICK * 1000)); }
