// The draw list for Tombola on Pons: rebuilt from the token's Transfer logs alone, so anyone can recompute it.
//
// Rules (TombolaDraw.weightFor, the original design's):
//   balance at the snapshot block >= 10,000 tokens; held for 30 minutes; weight = balance x multiplier, 1x rising
//   to 3x over 72 hours; any transfer OUT resets the hold clock, and tokens received after the clock started don't
//   restart it (the clock is the oldest moment since the last outgoing transfer at which the wallet first held
//   anything: the IMD design's "sending resets, receiving counts as fresh" is approximated by: hold start = the
//   time of the first inbound transfer after the last outbound one. Infra addresses are excluded.
//
// Leaves are (account, cumulativeBefore, weight) in ascending address order, so the list is canonical and the
// Merkle root is the same for everyone who rebuilds it. OpenZeppelin StandardMerkleTree hashing: leaf =
// keccak256(bytes.concat(keccak256(abi.encode(account, cumulativeBefore, weight)))), sorted-pair parents.
import { encodeAbiParameters, keccak256, concat, parseAbiItem } from "viem";

export const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
export const MIN_BALANCE = 10_000n * 10n ** 18n;
export const ELIGIBLE_AFTER = 30n * 60n;
export const FULL_MULTIPLIER_AFTER = 72n * 3600n;
export const WAD = 10n ** 18n;
export const ZERO = "0x0000000000000000000000000000000000000000";

export function weightFor(bal, holdStart, t) {
  if (bal < MIN_BALANCE || holdStart > t || t - holdStart < ELIGIBLE_AFTER) return 0n;
  const held = t - holdStart;
  const mult = held >= FULL_MULTIPLIER_AFTER ? 3n * WAD : WAD + (held * 2n * WAD) / FULL_MULTIPLIER_AFTER;
  return (bal * mult) / WAD;
}

/**
 * Replays Transfer logs (ascending by block, logIndex) up to and including the snapshot block, with each log's
 * block timestamp supplied by `timeOf(blockNumber)`. Returns Map(address -> {balance, holdStart}).
 */
export async function replay(logs, timeOf, { exclude = new Set() } = {}) {
  const st = new Map();
  const get = (a) => st.get(a) ?? { balance: 0n, holdStart: 0n };
  for (const l of logs) {
    const from = l.args.from.toLowerCase(), to = l.args.to.toLowerCase(), v = BigInt(l.args.value);
    if (v === 0n) continue;
    const t = BigInt(await timeOf(l.blockNumber));
    if (from !== ZERO) {
      const s = get(from);
      s.balance -= v;
      s.holdStart = t; // sending resets the clock; if the balance is now 0 the next inbound starts it again
      st.set(from, s);
    }
    if (to !== ZERO) {
      const s = get(to);
      if (s.balance === 0n) s.holdStart = t; // first tokens since empty: the clock starts now
      s.balance += v;
      st.set(to, s);
    }
  }
  for (const a of exclude) st.delete(a.toLowerCase());
  return st;
}

/** The canonical list: eligible wallets in ascending address order with cumulative weights. */
export function buildList(state, snapshotTime) {
  const t = BigInt(snapshotTime);
  const rows = [];
  for (const [account, s] of st_entries(state)) {
    const weight = weightFor(s.balance, s.holdStart, t);
    if (weight > 0n) rows.push({ account, balance: s.balance, holdStart: s.holdStart, weight });
  }
  rows.sort((x, y) => (x.account < y.account ? -1 : x.account > y.account ? 1 : 0));
  let cum = 0n;
  for (const r of rows) { r.cumulativeBefore = cum; cum += r.weight; }
  return { rows, totalWeight: cum };
}
const st_entries = (m) => (m instanceof Map ? m.entries() : Object.entries(m));

export const leafOf = (account, cumulativeBefore, weight) =>
  keccak256(concat([keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], [account, cumulativeBefore, weight]))]));
const pair = (a, b) => (a < b ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/** Merkle root and per-leaf proofs over the rows (duplicating the last leaf to a power of two, as the contract test does). */
export function merkle(rows) {
  if (rows.length === 0) return { root: keccak256("0x"), proofs: [] }; // an empty list pins keccak("") so a rollover is still a commitment
  const leaves = rows.map((r) => leafOf(r.account, r.cumulativeBefore, r.weight));
  let depth = 0;
  while (1 << depth < leaves.length) depth++;
  let level = Array.from({ length: 1 << depth }, (_, i) => leaves[Math.min(i, leaves.length - 1)]);
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1]));
    level = next;
    levels.push(level);
  }
  const proofs = rows.map((_, idx) => {
    const p = [];
    let pos = idx;
    for (let d = 0; d < depth; d++) { p.push(levels[d][pos ^ 1]); pos >>= 1; }
    return p;
  });
  return { root: levels.at(-1)[0], proofs };
}

/** The winner for a random word: the row whose cumulative range holds word mod totalWeight. */
export function pick(rows, totalWeight, randomWord) {
  if (totalWeight === 0n) return null;
  const target = BigInt(randomWord) % totalWeight;
  let lo = 0, hi = rows.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].cumulativeBefore + rows[mid].weight > target) hi = mid;
    else lo = mid + 1;
  }
  return { index: lo, row: rows[lo], target };
}

export const randomWordOf = (randomness, id) => BigInt(keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [randomness, BigInt(id)])));
