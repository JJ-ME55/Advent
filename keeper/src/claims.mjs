// Opening doors and claiming prizes. It's an advent calendar: nobody is told they've won until they open their door,
// and nothing is paid until they press Claim. The keeper writes each settled door's full result (winners and amounts)
// to RESULTS_DIR, a private folder; this module reads those, records opens and claims in CLAIMS_FILE, and pays a
// claim once. The keeper reads CLAIMS_FILE to publish only the winners who have opened or claimed.
//
// CLAIMS_FILE: { "door": { "<d>": { "<wallet>": { openedAt, pending, claimedAt, lamports, signature } } }, "bonus": {…} }
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { doorTime } from "./doors.mjs";

export const KINDS = ["door", "bonus"];
/** Seconds after the door opens during which a prize can be claimed; none = forever. Fish and JJ haven't set the rule yet. */
export const CLAIM_DEADLINE_SECONDS = process.env.CLAIM_DEADLINE_SECONDS ? Number(process.env.CLAIM_DEADLINE_SECONDS) : null;

const short = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-3)}` : a);
const str = (v) => (typeof v === "bigint" ? v.toString() : v);

export function readResult(resultsDir, d) {
  try { return JSON.parse(readFileSync(join(resultsDir, `door-${d}.json`), "utf8")); } catch { return null; }
}

/**
 * @param pay async (kind, to, lamports, memo) => { signature } — sends from the door or bonus wallet; absent = claims disabled.
 */
export function createClaims({ file, resultsDir, pay = null, now = () => Math.floor(Date.now() / 1000), log = () => {}, deadlineSeconds = CLAIM_DEADLINE_SECONDS } = {}) {
  let state = { door: {}, bonus: {} };
  try { state = { ...state, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { /* nothing opened yet */ }
  const save = () => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(`${file}.tmp`, JSON.stringify(state)); renameSync(`${file}.tmp`, file); };
  const rec = (kind, d, wallet) => state[kind]?.[d]?.[wallet] ?? null;
  const put = (kind, d, wallet, patch) => { (state[kind][d] ??= {})[wallet] = { ...(rec(kind, d, wallet) ?? {}), ...patch }; save(); return rec(kind, d, wallet); };
  const result = (d) => readResult(resultsDir, d);
  const list = (res, kind) => (kind === "door" ? res?.winners : res?.bonus) ?? [];

  const api = {
    result,
    /** The wallet's view of door d (kind "door") or its Bonus Box ("bonus"): null until the door has settled. */
    open(kind, d, wallet) {
      const res = result(d);
      if (!res?.winners) return null;
      const win = list(res, kind).find((w) => w.account === wallet);
      const r = rec(kind, d, wallet);
      if (!r?.openedAt) put(kind, d, wallet, { openedAt: now() });
      const c = rec(kind, d, wallet);
      return { won: !!win, k: win?.k ?? null, lamports: str(win?.lamports ?? 0n), claimed: !!c?.signature, claimSignature: c?.signature ?? null, claimedAt: c?.claimedAt ?? null };
    },
    /**
     * Pay the wallet's prize for door d once. Returns [status, body] like a route. Race-safe: the record is marked
     * pending before the send, so a second click during the send gets 409 and never a second payment; a failed send
     * clears the mark so the holder can try again.
     */
    async claim(kind, d, wallet) {
      const res = result(d);
      if (!res?.winners) return [409, { ok: false, error: "the door hasn't opened yet", opensAt: doorTime(d) }];
      const win = list(res, kind).find((w) => w.account === wallet);
      if (!win) return [403, { ok: false, error: kind === "door" ? "this wallet didn't win this door" : "this wallet didn't win this Bonus Box" }];
      const r = rec(kind, d, wallet);
      if (r?.signature) return [409, { claimed: true, signature: r.signature, lamports: str(r.lamports) }];
      if (r?.pending) return [409, { claimed: false, ok: false, error: "a claim is already on its way", pending: true }];
      if (deadlineSeconds !== null && now() > doorTime(d) + deadlineSeconds) return [410, { ok: false, error: "the claim window for this door has closed", closedAt: doorTime(d) + deadlineSeconds }];
      if (!pay) return [503, { ok: false, error: "claims aren't enabled on this server" }];
      put(kind, d, wallet, { pending: now(), openedAt: r?.openedAt ?? now() });
      try {
        const sent = await pay(kind, wallet, BigInt(win.lamports), win.memo);
        put(kind, d, wallet, { pending: null, claimedAt: now(), lamports: str(win.lamports), signature: sent.signature });
        log(`claim(${kind} ${d}, ${short(wallet)}, ${win.lamports} lamports) -> ${sent.signature}`);
        return [200, { ok: true, claimed: true, lamports: str(win.lamports), signature: sent.signature }];
      } catch (e) {
        put(kind, d, wallet, { pending: null });
        log(`claim(${kind} ${d}, ${short(wallet)}, ${win.lamports} lamports) FAILED ${e.message}`);
        return [502, { ok: false, error: `payment failed: ${e.message}` }];
      }
    },
    /** What may be shown publicly for door d: counts and totals, and only the winners who have opened or claimed. */
    publicView(kind, d, res = result(d)) {
      const all = list(res, kind);
      const recs = state[kind]?.[d] ?? {};
      const revealed = all.filter((w) => recs[w.account]?.openedAt || recs[w.account]?.signature).map((w) => ({ k: w.k, account: w.account, lamports: str(w.lamports), opened: true, claimed: !!recs[w.account]?.signature, claimSignature: recs[w.account]?.signature ?? null }));
      const claimed = all.filter((w) => recs[w.account]?.signature);
      return {
        winnerCount: all.length, totalLamports: all.reduce((a, w) => a + BigInt(w.lamports), 0n).toString(),
        openedCount: all.filter((w) => recs[w.account]?.openedAt).length, claimedCount: claimed.length, claimedLamports: claimed.reduce((a, w) => a + BigInt(w.lamports), 0n).toString(),
        unclaimedLamports: all.filter((w) => !recs[w.account]?.signature).reduce((a, w) => a + BigInt(w.lamports), 0n).toString(),
        winners: revealed,
      };
    },
    /** The published shape of a winner list: every prize, but a name only once its holder has opened or claimed. */
    scrub(kind, d, winners) {
      const recs = state[kind]?.[d] ?? {};
      return (winners ?? []).map((w) => { const r = recs[w.account]; const shown = r?.openedAt || r?.signature; return { k: w.k, lamports: str(w.lamports), ...(shown ? { account: w.account, claimed: !!r?.signature, claimSignature: r?.signature ?? null } : {}) }; });
    },
    setPay(fn) { pay = fn; },
    reload() { try { state = { door: {}, bonus: {}, ...JSON.parse(readFileSync(file, "utf8")) }; } catch { /* keep */ } },
    get state() { return state; },
  };
  return api;
}
