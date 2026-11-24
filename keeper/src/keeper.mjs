// The ADVENT keeper. Every tick (TICK_SECONDS, default 20):
//   1. claim: sweep pump.fun creator fees into the treasury when the vault holds > CLAIM_MIN_SOL, then split what
//      arrived 70/10/10/10 to the door, Christmas, bonus and team wallets (every split is a plain transfer with a memo);
//   2. snapshot + commit: at a door's snapshot time (door time - 10 min) build the list from the coin's balance
//      history, publish it to DRAWS_DIR, send the commit memo;
//   3. settle: once the door's drand round is out, pay the winners (and the bonus box) from the door wallet;
//   4. publish snapshot.json for the site and the bot; alert on anything that fails.
// Environment: RPC_URL (comma list), HELIUS_API_KEY, MINT, TREASURY_KEYPAIR (pump creator wallet), DOOR_KEYPAIR,
// BONUS_KEYPAIR, XMAS_WALLET, TEAM_WALLET, EXCLUDE (comma list; curve/pool/treasury/door/bonus/xmas/team are added),
// DRAWS_DIR, STATE_FILE, BONUS_ENTRANTS_FILE (json array per door, written by the API), ALERT_WEBHOOK, ONCE=1.
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { connections, loadKeypair, balanceOf, sendSol, sendMemo, heliusDeltas, memosOf, parseCommit, PublicKey, LAMPORTS_PER_SOL } from "./solana.mjs";
import { snapshot, commit, settle } from "./draw.mjs";
import { nextDoor, isSnapshotDue, isSettleDue, doorTime, doorRoundTime, LAST_DOOR } from "./doors.mjs";
import { claimCreatorFees } from "./claim.mjs";

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
mkdirSync(DRAWS_DIR, { recursive: true }); mkdirSync(join(STATE_FILE, ".."), { recursive: true });

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
    const fresh = await heliusDeltas(mint, { untilSignature: untilSig });
    if (fresh.length) { deltaCache = deltaCache.concat(fresh); writeFileSync(CACHE_FILE, JSON.stringify(deltaCache, (k, v) => (typeof v === "bigint" ? v.toString() : v))); }
    return [];
  },
  balance: (a) => balanceOf(conns, a),
  sendMemo: (text) => sendMemo(conns, treasury, text),
  sendSol: (to, lamports, memo) => sendSol(conns, door, to, lamports, memo),
};

async function claimAndSplit() {
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
      const snap = await snapshot(chain, cfg, id, { cachedDeltas: deltaCache });
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
      const r = await settle({ ...chain, sendSol: (to, l, m) => sendSol(conns, /ADVENT bonus/.test(m) ? bonus : door, to, l, m) }, cfg, snap, { bonusEntrants: entrants, bonusPotLamports: BigInt(s.snapshot.bonusPot) });
      if (r.status !== "settled") { if (now > doorRoundTime(id) + num("LATE_AFTER_SECONDS", 600)) await alert(`late-${id}`, `door ${id}: drand round ${snap.round} still unpublished ${now - doorRoundTime(id)} s after its time`); continue; }
      for (const w of r.winners) log(`settle(door ${id}) -> ${w.account} ${w.lamports} lamports (winner ${w.k}) tx ${w.signature}`);
      for (const w of r.bonus) log(`bonus(door ${id}) -> ${w.account} ${w.lamports} lamports (winner ${w.k}) tx ${w.signature}`);
      s.settled = { signature: r.signature, seed: r.seed, winners: r.winners, bonus: r.bonus, at: now };
      writeFileSync(join(DRAWS_DIR, `door-${id}.json`), JSON.stringify({ ...s.snapshot, commit: s.committed, result: s.settled }, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1));
      save();
    }
  }
}

function rehydrate(id, s) {
  const rows = s.snapshot.rows.map((r) => ({ ...r, balance: BigInt(r.balance), weight: BigInt(r.weight), cumulativeBefore: BigInt(r.cumulativeBefore) }));
  return { door: id, snapshotTime: s.snapshot.snapshotTime, rows, totalWeight: BigInt(s.snapshot.totalWeight), hash: s.committed.memo.match(/hash=([0-9a-f]{64})/)[1], pot: BigInt(s.snapshot.pot), winners: s.snapshot.winners, round: BigInt(s.snapshot.round) };
}

async function publish() {
  const [t, dw, xw, bw] = await Promise.all([treasury.publicKey, door.publicKey, xmas, bonus.publicKey].map((a) => balanceOf(conns, a)));
  const now = chain.now();
  const next = nextDoor(now);
  const out = {
    at: now, mint: MINT, wallets: Object.fromEntries(Object.entries(wallets).map(([k, v]) => [k, v.toBase58()])), treasury: treasury.publicKey.toBase58(),
    pots: { treasury: t.toString(), door: (dw > RESERVE ? dw - RESERVE : 0n).toString(), xmas: xw.toString(), bonus: (bw > RESERVE ? bw - RESERVE : 0n).toString() },
    claimed: state.claimed, nextDoor: next, nextDoorAt: next ? doorTime(next) : null, exclude: EXCLUDE,
    doors: Object.fromEntries(Object.entries(state.doors).map(([k, v]) => [k, { committed: !!v.committed, settled: !!v.settled, winners: v.settled?.winners?.map((w) => ({ account: w.account, lamports: w.lamports, signature: w.signature })) ?? [], eligible: v.snapshot?.rows?.length ?? null, pot: v.snapshot?.pot ?? null }])),
  };
  writeFileSync(join(DRAWS_DIR, "snapshot.json"), JSON.stringify(out, null, 1));
}

async function tick() {
  for (const [name, fn] of [["claim", claimAndSplit], ["doors", doors], ["publish", publish]]) {
    try { await fn(); } catch (e) { log(`${name}: ${e.message}`); if (name === "doors") await alert("doors", `${name}: ${e.message}`, 600); }
  }
}

log(`keeper ${treasury.publicKey.toBase58()} on mint ${MINT}; door wallet ${door.publicKey.toBase58()}; excluded ${EXCLUDE.length}`);
if (process.env.ONCE === "1") { await tick(); process.exit(0); }
for (;;) { await tick(); await new Promise((r) => setTimeout(r, TICK * 1000)); }
