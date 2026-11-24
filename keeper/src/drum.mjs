// The drum: who is in a door's draw and with how many tickets, rebuilt from the coin's balance history alone so
// anyone can recompute it. Tombola's rules (ref/tombola-bot/snapshot.mjs), ported to Solana:
//   balance at the snapshot >= MIN_BALANCE, held for ELIGIBLE_AFTER; weight = balance x multiplier, 1x rising to 3x
//   over FULL_MULTIPLIER_AFTER; any outgoing transfer resets the hold clock; tokens received into an empty wallet
//   start it; later inbound transfers don't restart it. Excluded wallets (curve, pool, treasury, team, burn) are
//   dropped and published with the list.
//
// Balance history arrives as per-transaction net deltas per owner ({owner, delta, time, slot, signature}), which is
// what Helius's tokenBalanceChanges give and what a plain RPC replay can produce too.
import { createHash } from "node:crypto";

export const DECIMALS = 6n; // pump.fun mints
export const UNIT = 10n ** DECIMALS;
export const MIN_BALANCE = 100_000n * UNIT; // 0.01% of a 1B supply
export const ELIGIBLE_AFTER = 30n * 60n;
export const FULL_MULTIPLIER_AFTER = 72n * 3600n;
export const WAD = 10n ** 18n;

export function weightFor(bal, holdStart, t) {
  bal = BigInt(bal); holdStart = BigInt(holdStart); t = BigInt(t);
  if (bal < MIN_BALANCE || holdStart > t || t - holdStart < ELIGIBLE_AFTER) return 0n;
  const held = t - holdStart;
  const mult = held >= FULL_MULTIPLIER_AFTER ? 3n * WAD : WAD + (held * 2n * WAD) / FULL_MULTIPLIER_AFTER;
  return (bal * mult) / WAD;
}

/** Sort deltas into the order the chain applied them: by slot, then signature order within the slot, then index. */
export function sortDeltas(deltas) {
  return [...deltas].sort((a, b) => Number(a.slot - b.slot) || (a.txIndex ?? 0) - (b.txIndex ?? 0) || (a.index ?? 0) - (b.index ?? 0));
}

/**
 * Replays deltas with time <= snapshotTime into Map(owner -> {balance, holdStart}). A delta of 0 is ignored. The
 * excluded set is removed at the end so their transfers still move other wallets' balances correctly.
 */
export function replay(deltas, snapshotTime, { exclude = new Set() } = {}) {
  const st = new Map();
  const t0 = BigInt(snapshotTime);
  for (const d of sortDeltas(deltas)) {
    const t = BigInt(d.time);
    if (t > t0) break;
    const v = BigInt(d.delta);
    if (v === 0n) continue;
    const s = st.get(d.owner) ?? { balance: 0n, holdStart: 0n };
    if (v < 0n) {
      s.balance += v; // may go negative only if the history is incomplete: the caller checks
      s.holdStart = t;
    } else {
      if (s.balance <= 0n) s.holdStart = t;
      s.balance += v;
    }
    st.set(d.owner, s);
  }
  for (const a of exclude) st.delete(a);
  return st;
}

/** The canonical list: eligible wallets in ascending (byte-wise) address order with cumulative weights. */
export function buildList(state, snapshotTime) {
  const t = BigInt(snapshotTime);
  const rows = [];
  for (const [account, s] of state) {
    if (s.balance < 0n) throw new Error(`negative balance for ${account}: the transfer history is incomplete`);
    const weight = weightFor(s.balance, s.holdStart, t);
    if (weight > 0n) rows.push({ account, balance: s.balance, holdStart: s.holdStart, weight });
  }
  rows.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  let cum = 0n;
  for (const r of rows) { r.cumulativeBefore = cum; cum += r.weight; }
  return { rows, totalWeight: cum };
}

/** The published snapshot and its hash: fixed key order, bigints as decimal strings, so the hash is reproducible. */
export function canonical(meta, rows, totalWeight) {
  const doc = {
    door: meta.door, mint: meta.mint, snapshotTime: Number(meta.snapshotTime), snapshotSlot: Number(meta.snapshotSlot ?? 0),
    exclude: [...meta.exclude].sort(), totalWeight: totalWeight.toString(),
    rows: rows.map((r) => ({ account: r.account, balance: r.balance.toString(), holdStart: Number(r.holdStart), weight: r.weight.toString(), cumulativeBefore: r.cumulativeBefore.toString() })),
  };
  const text = JSON.stringify(doc);
  return { doc, text, hash: sha256Hex(text) };
}

export const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** The random word for pick k of door d from drand's seed (sha256 of the round's signature). */
export function wordFor(seedHex, door, k, tag = "") {
  const h = createHash("sha256");
  h.update(Buffer.from(seedHex.replace(/^0x/, ""), "hex"));
  const b = Buffer.alloc(8); b.writeUInt32BE(door, 0); b.writeUInt32BE(k, 4);
  h.update(b);
  if (tag) h.update(Buffer.from(tag, "utf8"));
  return BigInt("0x" + h.digest("hex"));
}

/** Who holds `target` in a cumulative list (rows must carry cumulativeBefore). */
export function pickAt(rows, totalWeight, word) {
  if (totalWeight === 0n || rows.length === 0) return null;
  const target = word % totalWeight;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (rows[mid].cumulativeBefore <= target) lo = mid; else hi = mid - 1; }
  return { index: lo, row: rows[lo], target };
}

/**
 * n winners without replacement: pick k uses word_k over the list with earlier winners removed and cumulative
 * weights rebuilt. Returns [{k, account, weight, target, totalWeight}].
 */
export function pickWinners(rows, seedHex, door, n, tag = "") {
  let pool = rows.map((r) => ({ account: r.account, weight: r.weight }));
  const out = [];
  for (let k = 1; k <= n && pool.length; k++) {
    let cum = 0n;
    for (const r of pool) { r.cumulativeBefore = cum; cum += r.weight; }
    const p = pickAt(pool, cum, wordFor(seedHex, door, k, tag));
    out.push({ k, account: p.row.account, weight: p.row.weight, target: p.target, totalWeight: cum });
    pool = pool.filter((_, i) => i !== p.index);
  }
  return out;
}

/** Fish's curve, then capped so no prize is below `floorLamports`, then by the eligible count. */
export const WINNER_CURVE = [[5000, 50], [2500, 30], [1000, 20], [500, 10], [200, 5], [100, 2], [0, 1]];
export function winnerCount(eligible, potLamports, floorLamports) {
  if (eligible === 0 || potLamports <= 0n) return 0;
  let n = 1;
  for (const [min, count] of WINNER_CURVE) if (eligible >= min) { n = count; break; }
  if (floorLamports > 0n) n = Math.min(n, Math.max(1, Number(potLamports / floorLamports)));
  return Math.min(n, eligible);
}

/** The grand winner takes GRAND_BPS of the door; the rest is split equally, dust to the grand. */
export const GRAND_BPS = 4000n;
export function prizes(potLamports, n) {
  const pot = BigInt(potLamports);
  if (n <= 0 || pot <= 0n) return [];
  if (n === 1) return [pot];
  const rest = pot - (pot * GRAND_BPS) / 10_000n;
  const each = rest / BigInt(n - 1);
  const grand = pot - each * BigInt(n - 1);
  return [grand, ...Array(n - 1).fill(each)];
}

/** The bonus pot in n random-looking but deterministic shares (weights from the seed), each at least 1/(3n). */
export function bonusShares(potLamports, n, seedHex, door) {
  const pot = BigInt(potLamports);
  if (n <= 0 || pot <= 0n) return [];
  const ws = Array.from({ length: n }, (_, i) => 1000n + (wordFor(seedHex, door, i + 1, "share") % 2000n)); // 1000..2999
  const total = ws.reduce((a, b) => a + b, 0n);
  const out = ws.map((w) => (pot * w) / total);
  out[0] += pot - out.reduce((a, b) => a + b, 0n);
  return out;
}
