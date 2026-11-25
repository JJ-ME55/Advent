// A door's draw, from snapshot to the fixed winners, against an abstract chain so it runs the same in tests, on devnet and on
// mainnet. The chain adapter supplies: deltas(mint, untilSig), sendMemo(text), sendSol(to, lamports, memo),
// balance(address), now(). Every step is idempotent through the state object the caller persists.
import { replay, buildList, canonical, winnerCount, prizes, pickWinners, bonusShares } from "./drum.mjs";
import { doorRound, doorRoundTime, snapshotTime, COMMIT_MARGIN } from "./doors.mjs";
import { drandSignature, seedOf } from "./drand.mjs";
import { commitMemo, payoutMemo } from "./solana.mjs";

export const DEFAULT_FLOOR_LAMPORTS = 100_000_000n; // ~$20: no prize below this
export const BONUS_WINNERS = 10;

/** Build and pin door d's list. Returns the snapshot doc (to publish) and what to commit. */
export async function snapshot(chain, cfg, d, { potLamports, cachedDeltas = [] } = {}) {
  const t = snapshotTime(d);
  const deltas = cachedDeltas.concat(await chain.deltas(cfg.mint, cachedDeltas.at(-1)?.signature ?? null));
  const st = replay(deltas, t, { exclude: new Set(cfg.exclude) });
  const { rows, totalWeight } = buildList(st, t);
  const pot = potLamports ?? (await chain.balance(cfg.doorWallet)) - cfg.reserveLamports;
  const n = winnerCount(rows.length, pot, cfg.floorLamports ?? DEFAULT_FLOOR_LAMPORTS);
  const round = doorRound(d);
  const { doc, hash } = canonical({ door: d, mint: cfg.mint, snapshotTime: t, exclude: cfg.exclude }, rows, totalWeight);
  return { door: d, snapshotTime: t, rows, totalWeight, hash, doc, pot, winners: n, round, deltas };
}

/** Send the commitment memo; refuses if the round is too close. */
export async function commit(chain, snap) {
  const now = chain.now();
  const rt = doorRoundTime(snap.door);
  if (now > rt - COMMIT_MARGIN) throw new Error(`too late to commit door ${snap.door}: ${rt - now} s to the round`);
  const text = commitMemo({ door: snap.door, hash: snap.hash, round: snap.round, total: snap.totalWeight, winners: snap.winners });
  const r = await chain.sendMemo(text);
  return { ...r, memo: text };
}

/**
 * Once the round is out: pick the winners and fix their prizes. Nothing is sent: it's an advent calendar, so a winner
 * finds out by opening their door on the site and claims the prize then (api.mjs, claims.mjs). The money stays in the
 * door and bonus wallets until claimed. `bonusEntrants` are the wallets that finished the village game.
 */
export async function settle(chain, cfg, snap, { bonusEntrants = [], bonusPotLamports = 0n, fetchSignature = drandSignature } = {}) {
  const sig = await fetchSignature(snap.round);
  if (!sig) return { status: "unpublished" };
  const seed = seedOf(sig);
  const winners = pickWinners(snap.rows, seed, snap.door, snap.winners);
  const amounts = prizes(snap.pot, winners.length);
  const door = winners.map((w, i) => ({ k: w.k, account: w.account, weight: w.weight, totalWeight: w.totalWeight, lamports: amounts[i], memo: payoutMemo({ door: snap.door, k: w.k, n: winners.length, hash: snap.hash }) }));
  let bonus = [];
  if (bonusEntrants.length && bonusPotLamports > 0n) {
    const entrants = [...new Set(bonusEntrants)].sort().map((account) => ({ account, weight: 1n }));
    const n = Math.min(BONUS_WINNERS, entrants.length);
    const bw = pickWinners(entrants, seed, snap.door, n, "bonus");
    const shares = bonusShares(bonusPotLamports, n, seed, snap.door);
    bonus = bw.map((w, i) => ({ k: w.k, account: w.account, lamports: shares[i], memo: payoutMemo({ door: snap.door, k: w.k, n, hash: snap.hash, kind: "bonus" }) }));
  }
  return { status: "settled", signature: sig, seed, winners: door, bonus };
}
