// Draw maths and the in-browser verifier for Tombola on Pons. Mirrors TombolaDraw.weightFor, bot/pons/snapshot.mjs
// (the canonical draw-list algorithm, copied byte for byte into ./snapshot.js) and bot/pons/verify-draw.mjs.
import { keccak256, decodeEventLog, decodeFunctionData, getAddress } from "viem";
import { drawAbi, beaconAbi, tokenAbi } from "./generated/abis.js";
import { TRANSFER, replay, buildList, merkle, pick, randomWordOf, weightFor, WAD, ZERO, FULL_MULTIPLIER_AFTER, ELIGIBLE_AFTER, MIN_BALANCE } from "./snapshot.js";

export { TRANSFER, replay, buildList, merkle, pick, randomWordOf, weightFor, WAD, ZERO, FULL_MULTIPLIER_AFTER, ELIGIBLE_AFTER, MIN_BALANCE };
// commitDelay is TombolaDraw.COMMIT_DELAY; the drand evmnet constants are DrandBeacon.GENESIS / PERIOD, pinned here so
// a lying RPC can't move a round's publish time [R10 finding 3]
export const DEFAULTS = { commitDelay: 600n, drandGenesis: 1727521075n, drandPeriod: 3n };

const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
export const TX_RE = /^0x[0-9a-f]{64}$/i;

/** Hold multiplier in WAD, as in TombolaDraw.weightFor (1x rising to 3x over 72 hours). */
export function multiplierWad(held) {
  const h = BigInt(held);
  return h >= FULL_MULTIPLIER_AFTER ? 3n * WAD : WAD + (h * 2n * WAD) / FULL_MULTIPLIER_AFTER;
}

/** drand evmnet round `round` is published at this unix time (pinned constants, never the RPC's). */
export const roundTimeOf = (round) => DEFAULTS.drandGenesis + (BigInt(round) - 1n) * DEFAULTS.drandPeriod;

// drand evmnet relays, as in bot/lib.mjs: drand's own relays serve the v2 beacon path; Cloudflare's serves only the
// v1 path, keyed by evmnet's chain hash. Every relay returns the same signature for a round. [R6 finding 10]
export const EVMNET_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
export const DRAND_URLS = [
  (round) => `https://api.drand.sh/v2/beacons/evmnet/rounds/${round}`,
  (round) => `https://api2.drand.sh/v2/beacons/evmnet/rounds/${round}`,
  (round) => `https://api3.drand.sh/v2/beacons/evmnet/rounds/${round}`,
  (round) => `https://drand.cloudflare.com/${EVMNET_HASH}/public/${round}`,
];
export const FETCH_TIMEOUT_MS = 10_000;

/** Rejects with a TimeoutError after `ms`, even when the underlying promise ignores its abort signal. */
function withTimeout(p, ms, what) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`${what} timed out`), { name: "TimeoutError" })), ms); });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

/** The host a relay URL names ("api2.drand.sh"), for the check lines. */
export const relayHost = (u) => { try { return new URL(u).host; } catch { return String(u); } };

/**
 * Asks every drand evmnet relay for a round at once (Promise.allSettled), each with a `timeoutMs` deadline, and
 * returns every relay's answer, so one bad or fast relay never decides the check [R10 finding 4]:
 *   { sigs: [{ sig, relays: [host] }], unpublished: [host], failed: ["host: why"] }
 * `sigs` is de-duplicated by signature (lowercase hex). A relay is `unpublished` when it answered that the round
 * isn't out (404/425, or no signature); `failed` when it errored, timed out, or answered for another round. Throws if
 * no relay answered at all (an outage, not evidence about the draw).
 */
export async function drandSignature(round, { urls = DRAND_URLS, fetchFn = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const one = async (url) => {
    const u = url(round);
    const host = relayHost(u);
    try {
      const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined;
      return await withTimeout((async () => {
        const r = await fetchFn(u, { signal });
        if (!r.ok) {
          if (r.status === 404 || r.status === 425) return { host, unpublished: true };
          throw new Error(`HTTP ${r.status}`);
        }
        const j = await r.json();
        // a relay serving another round's beacon is skipped, as in bot/lib.mjs [R9 finding 11]
        if (j?.round !== undefined && j?.round !== null && String(j.round) !== String(round)) throw new Error(`answered round ${j.round}`);
        if (typeof j?.signature === "string" && /^[0-9a-f]+$/i.test(j.signature)) return { host, sig: `0x${j.signature.toLowerCase()}` };
        return { host, unpublished: true };
      })(), timeoutMs, u);
    } catch (e) {
      return { host, error: e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : (e?.message ?? String(e)) };
    }
  };
  const settled = await Promise.allSettled(urls.map(one));
  const sigs = [], unpublished = [], failed = [];
  settled.forEach((s, i) => {
    const a = s.status === "fulfilled" ? s.value : { host: relayHost(urls[i](round)), error: s.reason?.message ?? "failed" };
    if (a.sig) {
      const g = sigs.find((x) => x.sig === a.sig);
      if (g) g.relays.push(a.host); else sigs.push({ sig: a.sig, relays: [a.host] });
    } else if (a.unpublished) unpublished.push(a.host);
    else failed.push(`${a.host}: ${a.error}`);
  });
  if (!sigs.length && !unpublished.length) throw new Error(`no drand relay answered for round ${round}: ${failed.join("; ")}`);
  return { sigs, unpublished, failed };
}

/** The drand signature in a transaction that called the draw contract: settle(id, sig, ...) or rollover(id, sig, root). Null if none. */
function drawCallSignature(tx, draw, id) {
  if (!tx || !same(tx.to, draw)) return null;
  let fn;
  try { fn = decodeFunctionData({ abi: drawAbi, data: tx.input }); } catch { return null; }
  if (fn.functionName !== "settle" && fn.functionName !== "rollover") return null;
  if (id !== undefined && BigInt(fn.args[0]) !== BigInt(id)) return null;
  const sig = fn.args[1];
  return typeof sig === "string" && sig.length > 2 ? sig : null; // "0x": the round was already proven, no signature sent
}

/**
 * The drand signature from the settle (or rollover) transaction's calldata. Null when it can't be read (the keeper
 * sent "0x" because the round was already proven, or the call didn't come straight from the keeper). Its source
 * doesn't matter: the beacon's isValid and keccak checks decide whether it is the round's.
 */
export async function settleSignature({ pub, draw, id, log }) {
  if (typeof pub.getTransaction !== "function" || !log?.transactionHash) return null;
  const tx = await pub.getTransaction({ hash: log.transactionHash });
  return drawCallSignature(tx, draw, id);
}

/**
 * The signature that proved `round` on the beacon, from the transaction that emitted its RoundProven log: a direct
 * `beacon.prove(round, sig)`, or a settle/rollover on the draw contract (another draw on the same round). Null when
 * it can't be read. Only a candidate: the caller checks it with isValid and keccak256 [R7 finding 3].
 */
export async function proveSignature({ pub, beacon, draw, round, fromBlock, toBlock }) {
  if (typeof pub.getTransaction !== "function") return null;
  const r = BigInt(round);
  const logs = await chunkedLogs(pub, (a, b) => pub.getContractEvents({ address: beacon, abi: beaconAbi, eventName: "RoundProven", args: { round: r }, fromBlock: a, toBlock: b }), {
    fromBlock, toBlock, until: (all) => all.some((l) => l.args?.round !== undefined && BigInt(l.args.round) === r),
  });
  const log = logs.find((l) => l.args?.round !== undefined && BigInt(l.args.round) === r);
  if (!log?.transactionHash) return null;
  const tx = await pub.getTransaction({ hash: log.transactionHash });
  if (!tx) return null;
  try {
    if (same(tx.to, beacon)) {
      const { functionName, args } = decodeFunctionData({ abi: beaconAbi, data: tx.input });
      return functionName === "prove" && BigInt(args[0]) === r ? args[1] : null;
    }
    return drawCallSignature(tx, draw);
  } catch { /* not a call we can decode */ }
  return null;
}

/**
 * Checks draw randomness against the beacon [R7 finding 3, Info 12a]. Candidate signatures come from `sources`
 * (async functions tried in order, each returning a signature or null, or throwing). A candidate is kept only if
 * beacon.isValid(round, sig) and keccak256(sig) == stored. Returns one of:
 *  { status: "pass", sig, from }                     a valid signature that hashes to the stored randomness
 *  { status: "fail", sig, from, why }                a VALID signature that hashes to something else, or stored is zero
 *  { status: "unknown", why }                        nothing checkable (junk calldata, drand down, isValid erroring)
 *  { status: "unknown", conflict: true, why }        drand's relays contradict this RPC, but the site can't tell which lies
 * Junk or wrong-round RPC-sourced signatures are discarded, never a FAIL: only drand's real signature passes isValid,
 * and it is unique per round, so a valid one that disagrees with the beacon is the only evidence of a bad beacon.
 * A source marked `independent` (drand's relays, the one source the RPC doesn't control) is ALWAYS asked, whether or
 * not an RPC-sourced candidate was found or passed, and its signature is compared with `stored` before anything else
 * [R8 finding 9, R9 finding 8]. Its `get` returns every relay's answer (drandSignature) [R10 finding 4]. A pass
 * carries `relay: { status: "agree" | "none", from, why, others }`: it passes when ANY relay's signature hashes to
 * `stored` (and isValid accepts it, or an RPC-sourced candidate already passed); `others` names the relays that said
 * something else. A relay signature that hashes elsewhere is a FAIL only if isValid accepts it. A conflict means no
 * relay signature both hashes to `stored` and passes isValid, while some relay served one; or every relay says the
 * round isn't published although `due` (set by the caller from the device clock) says it is out [R10 finding 3]. A
 * lying RPC that hides the settle calldata so the relays are the only candidate therefore still gets the loud
 * conflict, never the benign "couldn't check ... try again later".
 */
export async function checkRandomness({ pub, beacon, round, stored, sources }) {
  if (!stored || BigInt(stored) === 0n) return { status: "fail", why: `the beacon has no randomness stored for round ${round}, yet the draw was settled` };
  const why = [];
  const errMsg = (e) => e?.shortMessage ?? e?.message ?? "error";
  const isValid = (sig) => pub.readContract({ address: beacon, abi: beaconAbi, functionName: "isValid", args: [round, sig] });
  // 1. the RPC-sourced candidates (calldata), in order, until one passes
  let rpc = null;
  for (const { from, get, none, independent } of sources) {
    if (independent || rpc) continue;
    let sig;
    try { sig = await get(); } catch (e) { why.push(e?.whyUnknown ?? `${from}: ${errMsg(e)}`); continue; }
    if (!sig) { if (none) why.push(none); continue; }
    let valid;
    try {
      valid = await isValid(sig);
    } catch (e) {
      why.push(`the beacon's isValid call failed for the signature from ${from} (${errMsg(e)})`);
      continue;
    }
    if (valid !== true) { why.push(`the signature in ${from} isn't drand's for round ${round}`); continue; }
    if (keccak256(sig) !== stored) return { status: "fail", sig, from, why: `drand's valid signature for round ${round} (from ${from}) hashes to ${keccak256(sig)}, but the beacon stored ${stored}` };
    rpc = { sig, from };
  }
  // 2. drand's relays, always, and every relay's answer [R10 finding 4]. The site can't check BLS itself, so isValid
  // (through the RPC) is the only judge of a signature; two signatures for one round can't both be drand's.
  const rel = sources.find((s) => s.independent);
  if (!rel) return rpc ? { status: "pass", ...rpc } : { status: "unknown", why: why.length ? why.join("; ") : "no signature found" };
  let ans;
  try { ans = await rel.get(); } catch (e) {
    const rwhy = e?.whyUnknown ?? `${rel.from}: ${errMsg(e)}`;
    if (rpc) return { status: "pass", ...rpc, relay: { status: "none", from: rel.from, why: e?.whyUnknown ?? errMsg(e) } };
    return { status: "unknown", why: [...why, rwhy].join("; ") };
  }
  const sigs = ans?.sigs ?? [], unpublished = ans?.unpublished ?? [], failed = ans?.failed ?? [];
  const names = (hosts) => hosts.join(", ");
  // what the other relays said, listed as INFO when the draw passes anyway
  const aside = [];
  if (unpublished.length && sigs.length) aside.push(`${names(unpublished)} said round ${round} isn't published`);
  if (failed.length) aside.push(`couldn't use ${failed.join("; ")}`);
  if (!sigs.length) {
    const who = names(unpublished) || rel.from;
    // [R10 finding 3] by this device's clock (and drand's pinned evmnet constants) the round is already out, so an
    // honest relay serves it: "not published" contradicts the RPC's settled draw and is never a benign gap
    if (rel.due) {
      return {
        status: "unknown", conflict: true, ...(rpc ?? {}),
        why: `${who} say round ${round} isn't published, but by this device's clock it was published at ${rel.due}, and this RPC says the draw was settled with it: the relays, this RPC or this device's clock is wrong. Check again with your own RPC or bot/pons/verify-draw.mjs`,
      };
    }
    if (rpc) return { status: "pass", ...rpc, relay: { status: "none", from: rel.from, why: rel.none ? `${rel.none} (${who})` : "no signature" } };
    return { status: "unknown", why: [...why, rel.none ? `${rel.none} (${who})` : `${rel.from} have no signature`].join("; ") };
  }
  for (const g of sigs) { g.hash = keccak256(g.sig); g.at = names(g.relays); }
  const match = sigs.find((g) => g.hash === stored);
  const elsewhere = sigs.filter((g) => g !== match);
  const matched = rpc ? `, which ${rpc.from} matched` : "";
  // a relay signature that the beacon calls VALID but that hashes elsewhere is the only FAIL, whatever other relays say
  for (const g of elsewhere) {
    try { g.valid = await isValid(g.sig); } catch (e) { g.err = errMsg(e); }
    if (g.valid === true) {
      return {
        status: "fail", sig: g.sig, from: g.at,
        why: rpc || match
          ? `${g.at} returned a signature for round ${round} that the beacon calls valid, but it hashes to ${g.hash}, not the stored ${stored}${matched}. Only one signature per round is drand's: the beacon or this RPC is lying`
          : `drand's valid signature for round ${round} (from ${g.at}) hashes to ${g.hash}, but the beacon stored ${stored}`,
      };
    }
  }
  const rejects = (g) => (g.err !== undefined ? `failed the beacon's isValid call for it (${g.err})` : "says that signature isn't valid");
  const odd = elsewhere.map((g) => `${g.at} served a different signature (hashing to ${g.hash}) that this RPC's beacon ${g.err !== undefined ? `couldn't check (${g.err})` : "rejects"}`);
  if (match) {
    const others = [...odd, ...aside];
    if (rpc) return { status: "pass", ...rpc, relay: { status: "agree", from: match.at, hosts: match.at, others } };
    let rvalid, rerr;
    try { rvalid = await isValid(match.sig); } catch (e) { rerr = errMsg(e); }
    const from = `drand's relays (${match.at})`;
    if (rvalid === true) return { status: "pass", sig: match.sig, from, relay: { status: "agree", from, hosts: match.at, others } };
    if (rerr !== undefined) {
      // the relay agrees with the stored randomness; only this RPC's isValid call failed (a timeout or a 429 is honest)
      return { status: "unknown", why: [...why, `the beacon's isValid call failed for the signature from ${match.at}, which does hash to the stored randomness (${rerr})`].join("; ") };
    }
    return {
      status: "unknown", conflict: true,
      why: `${match.at} returned a signature for round ${round} that hashes to the stored randomness ${stored}, but this RPC's beacon says that signature isn't valid: either the relays or this RPC is wrong${odd.length ? ` (also: ${odd.join("; ")})` : ""}. Check again with your own RPC or bot/pons/verify-draw.mjs`,
    };
  }
  // no relay signature hashes to the stored randomness
  if (elsewhere.length === 1 && !unpublished.length) {
    const g = elsewhere[0];
    return {
      status: "unknown", conflict: true, ...(rpc ?? {}),
      why: `${g.at} returned a signature for round ${round} that hashes to ${g.hash}, not the stored randomness ${stored}${rpc ? ` that ${rpc.from} matched` : ""}, and this RPC ${rejects(g)}: either the relays or this RPC is wrong. Check again with your own RPC or bot/pons/verify-draw.mjs`,
    };
  }
  return {
    status: "unknown", conflict: true, ...(rpc ?? {}),
    why: `drand's relays disagree with each other for round ${round}, and none serves a signature that hashes to the stored randomness ${stored}${rpc ? ` that ${rpc.from} matched` : ""}: ${[...odd, ...(unpublished.length ? [`${names(unpublished)} said the round isn't published`] : [])].join("; ")}. Check again with your own RPC or bot/pons/verify-draw.mjs`,
  };
}

/**
 * The one-line verdict under the checks, as [class, text] [R8 findings 2 and 9, R9 finding 8]. `via` names the RPC,
 * since everything but drand's relays came through it. A conflict between drand's relays and this RPC leads the
 * summary, before any other reason, and is never worded as a benign "try again later". When the only gap is the
 * randomness, the rest was recomputed FROM the unchecked stored randomness, so it isn't "everything else matches".
 */
const RELAY_UNCONFIRMED = "drand's relays didn't confirm the randomness";
export function verifySummary(res, via) {
  if (!res.ok) return ["bad", `Verification FAILED. Something here doesn't match the chain (read through ${via}).`];
  if (!res.incomplete) return ["good", `Verified: this draw was drawn fairly from public data (read through ${via}).`];
  const why = res.incompleteWhy?.length ? res.incompleteWhy : [res.randomnessWhy ? `randomness couldn't be checked (${res.randomnessWhy})` : "a check couldn't run"];
  if (res.randomnessConflict) {
    const conflict = why.filter((w) => w.startsWith("drand's relays DISAGREE"));
    const rest = why.filter((w) => !w.startsWith("drand's relays DISAGREE"));
    const head = conflict.length ? conflict.join("; ") : `drand's relays DISAGREE with this RPC (${res.randomnessWhy})`;
    return ["unsure conflict", `Warning: ${head}. Don't trust this result: drand's relays, which this RPC doesn't control, contradict what ${via} says about the randomness, and the rest of the draw was recomputed from the randomness this RPC stored.${rest.length ? ` Also couldn't check: ${rest.join("; ")}.` : ""} Verify with your own RPC (above) or bot/pons/verify-draw.mjs.`];
  }
  // [R10 finding 3] every check passed, but only through this RPC: amber, never the green "Verified"
  if (why.every((w) => w.startsWith(RELAY_UNCONFIRMED))) {
    return ["unsure", `Checked only through ${via}: ${why.join("; ")}. Everything this RPC returned is consistent, but drand's relays, the one source it doesn't control, didn't confirm the randomness, and an RPC that lies can make its own data agree. Try Verify again later, or verify with your own RPC (above) or bot/pons/verify-draw.mjs.`];
  }
  if (why.every((w) => w.startsWith("randomness couldn't be checked"))) {
    return ["unsure", `Couldn't finish: ${why.join("; ")}. The rest was recomputed from the stored randomness, which could not be checked (read through ${via}). Try again later, or verify with your own RPC (above) or bot/pons/verify-draw.mjs.`];
  }
  return ["unsure", `Couldn't check this draw: ${why.join("; ")}. This is not a FAIL: nothing that was read contradicts the chain, but the draw wasn't fully recomputed. Verify with your own RPC (above) or bot/pons/verify-draw.mjs.`];
}

// ------------------------------------------------------------------ chunked log scans [finding 8]

export const LOG_CHUNK = 3_000_000n; // public RPCs refuse ranges around 10M blocks
// A size error ("logs matched by query exceeds limit of 10000") shrinks the window down to one block: Robinhood's
// 32M-gas block pool fits a few hundred transfers a block, so no single block can exceed the 10,000-result cap [R8 finding 2].
// Any other error stops shrinking at OTHER_FLOOR, so an outage fails fast instead of walking down to one block.
const MIN_CHUNK = 1n;
const OTHER_FLOOR = 2_000n;
const RETRIES = 2; // a transient error (429, timeout) is retried at the same size this many times before halving
const toBlockNum = (b) => (b === undefined || b === null || b === "earliest" ? 0n : BigInt(b));
const TRANSIENT_ERR = /\b429\b|rate.?limit|too many requests|timed? ?out|timeout|ECONNRESET|fetch failed|network/i;
const RANGE_ERR = /range|too many|too big|more than|exceed|limit|too large|response size|results|block span|10000/i;
/** Does this RPC error say the range or the response was too big (so a smaller window would help)? A rate limit or
 * a timeout is transient instead: retried at the same size first. */
export const isRangeError = (e) => {
  const msg = `${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? ""}`;
  return !TRANSIENT_ERR.test(msg) && RANGE_ERR.test(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Dedupes by (blockNumber, logIndex) and sorts ascending by the same. */
export function sortLogs(logs) {
  const seen = new Map();
  for (const l of logs) seen.set(`${l.blockNumber}:${l.logIndex}`, l);
  return [...seen.values()].sort((x, y) =>
    x.blockNumber === y.blockNumber ? Number(x.logIndex) - Number(y.logIndex) : x.blockNumber < y.blockNumber ? -1 : 1);
}

/**
 * Calls `fetchRange(from, to)` over [fromBlock, toBlock] in chunks of `chunk` blocks. A range or size error halves
 * the chunk (down to one block, then gives up); any other error is retried at the same size up to RETRIES times
 * before it halves too (down to OTHER_FLOOR). After each success the chunk doubles back towards `chunk`, as
 * bot/lib.mjs getLogsChunked does, so one dense window doesn't slow the rest of the scan [R6 finding 11]. `backward`
 * walks from the head down. `until(all)` may stop early. `onProgress(doneBlocks, totalBlocks)` reports the scan.
 * Returns the logs deduped and merge-sorted by (blockNumber, logIndex).
 */
export async function chunkedLogs(pub, fetchRange, { fromBlock, toBlock = "latest", chunk = LOG_CHUNK, backward = false, until, retryDelayMs = 250, onProgress } = {}) {
  const lo0 = toBlockNum(fromBlock);
  let hi0;
  if (toBlock === "latest") {
    // a client that can't report its head gets one query; a real viem client always can
    if (typeof pub.getBlockNumber !== "function") return sortLogs(await fetchRange(lo0, "latest"));
    hi0 = await pub.getBlockNumber();
  } else hi0 = BigInt(toBlock);
  const max = BigInt(chunk) > 0n ? BigInt(chunk) : 1n;
  const out = [];
  let size = max, lo = lo0, hi = hi0, tries = 0;
  const total = hi0 >= lo0 ? hi0 - lo0 + 1n : 0n;
  while (lo <= hi) {
    const a = backward ? (hi - size + 1n > lo ? hi - size + 1n : lo) : lo;
    const b = backward ? hi : (lo + size - 1n < hi ? lo + size - 1n : hi);
    let logs;
    try {
      logs = await fetchRange(a, b);
    } catch (e) {
      const range = isRangeError(e);
      if (!range && tries < RETRIES) { tries++; if (retryDelayMs) await sleep(retryDelayMs * tries); continue; }
      tries = 0;
      const floor = range ? MIN_CHUNK : OTHER_FLOOR;
      const min = floor < max ? floor : max;
      if (size <= min) throw e;
      size = size / 2n > min ? size / 2n : min;
      continue;
    }
    tries = 0;
    out.push(...logs);
    if (backward) hi = a - 1n; else lo = b + 1n;
    onProgress?.(backward ? hi0 - hi : lo - lo0, total);
    if (size < max) size = size * 2n < max ? size * 2n : max;
    if (until && (await until(out))) break;
  }
  return sortLogs(out);
}

/** An error that is evidence about the chain (logs or values that contradict each other), not an RPC failure. Verify
 * FAILs on these; any other error while reading the chain is the neutral "couldn't check" state [R8 finding 2]. */
export const mismatch = (message) => Object.assign(new Error(message), { mismatch: true });

const argId = (l) => (l.args?.id === undefined ? undefined : BigInt(l.args.id));

/** The Committed log for draw `id`, scanning back from `toBlock` (the head). */
export async function findCommitted({ pub, draw, id, fromBlock, toBlock = "latest" }) {
  const idN = BigInt(id);
  const logs = await chunkedLogs(pub, (a, b) => pub.getContractEvents({ address: draw, abi: drawAbi, eventName: "Committed", args: { id: idN }, fromBlock: a, toBlock: b }), {
    fromBlock, toBlock, backward: true, until: (all) => all.length > 0,
  });
  const mine = logs.filter((l) => argId(l) === undefined || argId(l) === idN);
  if (mine.length !== 1) throw mismatch(`expected one Committed log for draw ${id}, found ${mine.length}`);
  return mine[0];
}

/** The log that ended draw `id`: Settled, RolledOver or Cancelled, scanning forward from its commit. */
export async function findDrawEnd({ pub, draw, id, fromBlock, toBlock = "latest" }) {
  const idN = BigInt(id);
  const names = ["Settled", "RolledOver", "Cancelled"];
  const logs = await chunkedLogs(pub, async (a, b) => (await Promise.all(names.map((eventName) =>
    pub.getContractEvents({ address: draw, abi: drawAbi, eventName, args: { id: idN }, fromBlock: a, toBlock: b })))).flat(), {
    fromBlock, toBlock, until: (all) => all.length > 0,
  });
  const mine = logs.filter((l) => argId(l) === idN && names.includes(l.eventName));
  if (mine.length !== 1) throw mismatch(`expected one settle, rollover or cancel log for draw ${id}, found ${mine.length}`);
  return mine[0];
}

// ------------------------------------------------------------------ the draw list from Transfer logs

/** Every Transfer log of `token` in [fromBlock, toBlock], chunked and sorted. */
export function transferLogs({ pub, token, fromBlock, toBlock = "latest", onProgress, until }) {
  return chunkedLogs(pub, async (a, b) => (await pub.getLogs({ address: token, event: TRANSFER, fromBlock: a, toBlock: b })).filter((l) => l.args?.from && l.args?.to), {
    fromBlock, toBlock, onProgress, until,
  });
}

/**
 * A block-timestamp reader with a cache: `prefetch(blocks)` reads the missing ones in parallel batches, `timeOf(n)`
 * answers one (reading it if needed). The timestamps are what snapshot.replay needs for every transfer's block.
 */
export function blockTimes(pub, cache = new Map()) {
  const timeOf = async (b) => {
    const k = BigInt(b);
    if (!cache.has(k)) cache.set(k, (await pub.getBlock({ blockNumber: k })).timestamp);
    return cache.get(k);
  };
  const prefetch = async (blocks, { batch = 40, onProgress } = {}) => {
    const need = [...new Set(blocks.map((b) => BigInt(b)))].filter((b) => !cache.has(b));
    for (let i = 0; i < need.length; i += batch) {
      await Promise.all(need.slice(i, i + batch).map(timeOf));
      onProgress?.(Math.min(i + batch, need.length), need.length);
    }
  };
  return { timeOf, prefetch, cache };
}

/**
 * The canonical draw list at `snapshotTime` from Transfer logs (sorted, with their block timestamps readable through
 * `timeOf`): the chain state at the last block whose timestamp is <= snapshotTime is exactly the replay of every
 * transfer in a block at or before that time (timestamps never decrease), so no block search is needed. Returns the
 * state too, for a wallet's hold start. `exclude` drops the infra addresses, as the keeper does.
 */
export async function listAtTime({ logs, timeOf, snapshotTime, exclude = [] }) {
  const t = BigInt(snapshotTime);
  const used = [];
  let lastBlock = null;
  for (const l of logs) {
    if ((await timeOf(l.blockNumber)) > t) break; // sorted by block: everything after is later too
    used.push(l);
    lastBlock = l.blockNumber;
  }
  const state = await replay(used, timeOf, { exclude: new Set(exclude.map((a) => a.toLowerCase())) });
  const list = buildList(state, t);
  return { ...list, state, transfers: used.length, lastBlock };
}

// ------------------------------------------------------------------ provenance [R5 finding 15, R6 finding 9]

/** Whole tokens for a message ("under 1" for dust). */
export function fmtTokens(wei) {
  const w = BigInt(wei ?? 0);
  if (w > 0n && w < WAD) return "under 1";
  return (w / WAD).toLocaleString("en-US");
}
/** "12,000 tokens", "1 token", "under 1 token". */
export const tokensText = (wei) => { const n = fmtTokens(wei); return `${n} token${n === "1" || n === "under 1" ? "" : "s"}`; };

const anyOf = (list, a) => (list ?? []).some((x) => same(x, a));
/** The pool addresses a buy can come from: Pons' bonding curve before graduation, the Uniswap v4 PoolManager after. */
const poolsOf = ({ pools, poolManager, curve }) => [...(pools ?? []), poolManager, curve].filter(Boolean);

/**
 * Pool-sourced tokens that receipt `rc` delivered to `wallet`, by the X bot's rule (xbot/src/chain.js
 * recordFirstBuys): a token Transfer counts as a buy only when it is from a pool (Pons' curve before graduation, the
 * PoolManager after), or from an address that received tokens from a pool earlier in the same transaction, and then
 * only up to what that address received and hasn't passed on yet. So a 1-wei swap bundled with a large
 * wallet-to-wallet transfer credits at most 1 wei, whoever made the swap. Transfers to a pool, an infra address
 * (`skip`) or address zero are never credited.
 * Sells are tracked the same way [R7 finding 8]: tokens the wallet sends to a pool, directly or through an address it
 * sent them to earlier in the same transaction (a router), up to what that address got from it.
 * Returns { wei, direct, sold, steps } (wei: pool-sourced tokens received; direct: some came straight from a pool;
 * sold: tokens the wallet sold to a pool; steps: the buys and sells in log order, for netting).
 */
export function poolCreditInReceipt(rc, { token, wallet, skip = [], ...poolOpts }) {
  const pools = poolsOf(poolOpts);
  const isPool = (a) => anyOf(pools, a);
  const skipTo = [...pools, ...skip, ZERO];
  const credit = new Map(); // lower-cased address -> pool-sourced tokens it holds within this transaction
  const fromW = new Map(); // lower-cased address -> tokens it got from the wallet within this transaction
  let wei = 0n, direct = false, sold = 0n;
  const steps = [];
  for (const log of rc.logs ?? []) {
    if (!same(log.address, token)) continue;
    let ev;
    try { ev = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics }); } catch { continue; }
    if (ev.eventName !== "Transfer") continue;
    const from = ev.args.from.toLowerCase(), to = ev.args.to.toLowerCase();
    const value = BigInt(ev.args.value ?? 0n);
    // the wallet's own tokens heading for the pool, directly or through a router
    let mine = 0n;
    if (same(from, wallet)) mine = value;
    else {
      const have = fromW.get(from) ?? 0n;
      if (have > 0n) { mine = value < have ? value : have; fromW.set(from, have - mine); }
    }
    if (mine > 0n) {
      if (isPool(to)) { sold += mine; steps.push({ kind: "sell", wei: mine }); }
      else if (!same(to, wallet) && !anyOf(skipTo, to)) fromW.set(to, (fromW.get(to) ?? 0n) + mine);
    }
    let bought = 0n, viaPool = false;
    if (isPool(from)) { bought = value; viaPool = true; }
    else {
      const have = credit.get(from) ?? 0n;
      if (have > 0n) { bought = value < have ? value : have; credit.set(from, have - bought); }
    }
    if (bought === 0n || anyOf(skipTo, to)) continue;
    credit.set(to, (credit.get(to) ?? 0n) + bought);
    if (same(to, wallet)) { wei += bought; if (viaPool) direct = true; steps.push({ kind: "buy", wei: bought }); }
  }
  return { wei, direct, sold, steps };
}

/** Runs buy/sell steps in order: a buy adds to the credit, a sell takes from it, never below zero. */
export function netCredit(steps, start = 0n) {
  let c = start;
  for (const s of steps) c = s.kind === "buy" ? c + s.wei : c > s.wei ? c - s.wei : 0n;
  return c;
}

/** Pool buys under a tenth of the balance at the snapshot are "small", as the X bot flags them. */
export const isSmallBuy = (boughtWei, balance) => balance !== undefined && balance !== null && BigInt(boughtWei) * 10n < BigInt(balance);

/**
 * Heuristic: how much did `wallet` buy from the pool before `beforeTs`, net of what it sold back?
 * Scans Transfer(to = wallet) and Transfer(from = wallet) logs up to `toBlock` and runs, over each transaction in
 * order, what poolCreditInReceipt credits (buys) and debits (sells) the wallet: a running credit that a sell lowers,
 * never below zero, so a buy-and-sell round trip leaves nothing [R7 finding 8]. A transaction whose transfers all go
 * straight to or from a pool needs no receipt. A claimed `firstBuyTx` is counted too, so a failed scan still has it.
 * With `balance` (the wallet's balance at the snapshot), the net credit is capped at it, and a net under a tenth of
 * it is `small`. `pools` (or `poolManager` / `curve`) name the pool addresses; `skip` the infra addresses.
 * Returns { bought: true|false|null, small, boughtWei, grossWei, soldWei, at, tx, how }: boughtWei is the net
 * credit; `at`/`tx` are the earliest buy found. bought null means it couldn't tell.
 */
export async function boughtFromPool({ pub, token, wallet, beforeTs, balance, firstBuyTx, fromBlock = "earliest", toBlock = "latest", maxTx = 25, skip = [], ...poolOpts }) {
  const pools = poolsOf(poolOpts);
  const isPool = (a) => anyOf(pools, a);
  const tsCache = new Map();
  const tsOf = async (bn) => {
    const k = BigInt(bn);
    if (!tsCache.has(k)) tsCache.set(k, Number((await pub.getBlock({ blockNumber: k })).timestamp));
    return tsCache.get(k);
  };
  const ctx = { token, pools, wallet, skip };
  const credits = new Map(); // lower-cased tx hash -> { wei, direct, sold, steps, at, block, idx }
  const sum = (k) => [...credits.values()].reduce((s, c) => s + c[k], 0n);
  const ordered = () => [...credits.entries()].sort(([, x], [, y]) => (x.block !== y.block ? (x.block < y.block ? -1 : 1) : x.idx - y.idx));
  const net = () => {
    const n = netCredit(ordered().flatMap(([, c]) => c.steps));
    return balance !== undefined && balance !== null && n > BigInt(balance) ? BigInt(balance) : n;
  };
  const before = (at) => beforeTs === undefined || at <= beforeTs;
  const creditTx = async (hash) => {
    const rc = await pub.getTransactionReceipt({ hash });
    const at = await tsOf(rc.blockNumber);
    const c = rc.status === "success" && before(at) ? poolCreditInReceipt(rc, ctx) : { wei: 0n, direct: false, sold: 0n, steps: [] };
    const first = (rc.logs ?? []).find((l) => same(l.address, token));
    credits.set(hash.toLowerCase(), { ...c, at, block: BigInt(rc.blockNumber), idx: Number(first?.logIndex ?? 0) });
  };
  // missingBuys: some buys may not be counted (net is a lower bound); missingSells: some sells may not be (an upper bound)
  let missingBuys = false, missingSells = false;
  const notes = [];
  const result = (bought, how) => {
    const wei = net(), gross = sum("wei"), sold = sum("sold");
    const first = ordered().find(([, c]) => c.wei > 0n);
    const small = bought === true && isSmallBuy(wei, balance);
    let text = how;
    if (gross > 0n) {
      const direct = [...credits.values()].some((c) => c.wei > 0n && c.direct);
      const share = balance ? `, ${(Number((wei * 10_000n) / (BigInt(balance) || 1n)) / 100).toFixed(2)}% of its balance at the snapshot` : "";
      // sells only lower the credit they follow (and the balance caps it), so the gross figures are shown when they did
      const soldText = wei >= gross ? ""
        : sold > 0n ? ` after sells (${tokensText(gross)} bought, ${tokensText(sold)} sold back)`
        : ` (${tokensText(gross)} bought; counted up to its balance at the snapshot)`;
      const found = wei === 0n && bought !== null
        ? `${tokensText(gross)} bought from the pool and ${tokensText(sold)} sold back to it, which leaves no net pool buy`
        : `${bought === true ? "" : "at least "}${tokensText(wei)} bought from the pool${soldText}${share} (${direct ? "some straight from the pool" : "through a router"})`;
      text = how ? `${how}; found ${found}` : found;
    }
    return { bought, small, boughtWei: wei, grossWei: gross, soldWei: sold, at: first ? first[1].at : null, tx: first ? first[0] : null, how: text };
  };
  const scan = (args) => chunkedLogs(pub, (a, b) => pub.getContractEvents({
    address: token, abi: tokenAbi, eventName: "Transfer", args, fromBlock: a, toBlock: b,
  }), { fromBlock, toBlock });

  if (firstBuyTx && TX_RE.test(firstBuyTx)) {
    try { await creditTx(firstBuyTx); } catch { /* the scan below decides */ }
  }
  let incoming = [], outgoing = [];
  try {
    incoming = (await scan({ to: wallet })).filter((l) => !l.args?.to || same(l.args.to, wallet));
  } catch (e) {
    missingBuys = true; missingSells = true; // a transfer in may also carry a router sell
    notes.push(`couldn't scan the logs (${e.shortMessage ?? e.message})`);
  }
  if (!missingBuys && !incoming.length && !credits.size) return result(null, "no transfers to this wallet were found in the scanned blocks");
  try {
    outgoing = (await scan({ from: wallet })).filter((l) => !l.args?.from || same(l.args.from, wallet));
  } catch (e) {
    missingSells = true;
    notes.push(`couldn't scan its transfers out (${e.shortMessage ?? e.message})`);
  }
  const byTx = new Map(); // hash -> { in: [], out: [] }
  for (const [dir, ls] of [["in", incoming], ["out", outgoing]]) {
    for (const l of ls) {
      const k = String(l.transactionHash).toLowerCase();
      if (!byTx.has(k)) byTx.set(k, { in: [], out: [], block: BigInt(l.blockNumber), idx: Number(l.logIndex ?? 0) });
      const t = byTx.get(k);
      t[dir].push(l);
      if (BigInt(l.blockNumber) === t.block && Number(l.logIndex ?? 0) < t.idx) t.idx = Number(l.logIndex ?? 0);
    }
  }
  const txs = [...byTx.entries()].sort(([, x], [, y]) => (x.block !== y.block ? (x.block < y.block ? -1 : 1) : x.idx - y.idx));
  let checked = 0, stop = "";
  for (const [hash, t] of txs) {
    if (credits.has(hash)) continue;
    const at = await tsOf(t.block);
    if (!before(at)) break; // sorted ascending
    const pm = (l, k) => l.args?.[k] && isPool(l.args[k]) && l.args.value !== undefined;
    if (t.in.every((l) => pm(l, "from")) && t.out.every((l) => pm(l, "to"))) {
      // straight to and from a pool: no receipt needed
      const steps = [...t.in.map((l) => ({ l, kind: "buy" })), ...t.out.map((l) => ({ l, kind: "sell" }))]
        .sort((x, y) => Number(x.l.logIndex ?? 0) - Number(y.l.logIndex ?? 0)).map(({ l, kind }) => ({ kind, wei: BigInt(l.args.value) }));
      const wei = steps.filter((s) => s.kind === "buy").reduce((s, x) => s + x.wei, 0n);
      credits.set(hash, { wei, direct: wei > 0n, sold: steps.filter((s) => s.kind === "sell").reduce((s, x) => s + x.wei, 0n), steps, at, block: t.block, idx: t.idx });
      continue;
    }
    if (!stop && ++checked > maxTx) stop = `more than ${maxTx} transfers to check`;
    if (!stop) {
      try { await creditTx(hash); continue; }
      catch (e) { stop = `couldn't read a transfer's receipt (${e.shortMessage ?? e.message})`; }
    }
    if (t.in.length) missingBuys = true;
    if (t.out.length || t.in.some((l) => !pm(l, "from"))) missingSells = true; // a router hop may hide a sell
  }
  if (stop) notes.push(stop);
  const how = notes.join("; ");
  const wei = net();
  if (missingSells) return result(wei === 0n && !missingBuys ? false : null, how);
  if (missingBuys) return result(wei > 0n && !isSmallBuy(wei, balance) ? true : null, how); // a lower bound still proves a buy of a tenth
  if (wei > 0n) return result(true, "");
  if (sum("wei") > 0n) return result(false, "");
  return result(false, "no pool buy found: no transfer to this wallet came from the pool, directly or through a router in the same transaction");
}

/** The pool flag a provenance result implies: "none", "small", null (a buy of a tenth or more) or "unknown". */
export const poolFlagOf = (b) => (!b || b.bought === null ? "unknown" : b.bought === false ? "none" : b.small ? "small" : null);
const FLAG_RANK = { none: 3, small: 2, unknown: 1 };
/** The stronger of two pool flags ("none" > "small" > "unknown" > null), so a refill never clears a stronger one. */
export function strongerFlag(a, b) {
  const ra = FLAG_RANK[a] ?? 0, rb = FLAG_RANK[b] ?? 0;
  if (!ra && !rb) return null;
  return ra >= rb ? a : b;
}

// ------------------------------------------------------------------ verifier

const trackNum = (x) => (x === 0 || x === "0" || x === "regular" ? 0 : x === 1 || x === "1" || x === "mega" ? 1 : null);
const toWei = (x) => { try { return x === undefined || x === null ? null : BigInt(x); } catch { return null; } };

/**
 * Recomputes draw `id` from public data, like bot/pons/verify-draw.mjs, and reports each check through `onCheck`:
 *   1. the drand round was committed before it was published: round time >= snapshot + COMMIT_DELAY (pinned drand
 *      constants), the Committed block is before the round's time, and the round is out before the settle block;
 *   2. drand's signature (the settle calldata first, then the beacon's prove transaction, then drand's relays) is
 *      valid and hashes to the beacon's stored randomness; the random word is keccak256(randomness, id);
 *   3. the draw list rebuilt from the token's Transfer logs at the snapshot has the root the contract pinned and the
 *      same total weight;
 *   4. the winner is the wallet whose cumulative range holds randomWord mod totalWeight, and the Settled log's
 *      winner, amount and transaction are what the page shows.
 * `row` is the winner row being shown (from the chain scan or the bot's snapshot). Returns { ok, checks, chain }
 * where `chain` holds the values read from the chain, for the page to show instead of the row's. `incomplete` is
 * true when a check couldn't run (drand unreachable, or the RPC refused or failed a read): nothing failed, but the
 * result isn't a full verification; `incompleteWhy` lists why. Only evidence (values or logs that contradict each
 * other) is a FAIL; an RPC error never is [R8 finding 2].
 * `exclude` are the infra addresses (as the keeper's EXCLUDE), `pools` the buy sources for the provenance heuristic
 * (Pons' curve, the PoolManager), `startBlock` the token's deploy block. `drandOpts` is passed to drandSignature
 * (tests set a short timeout or a mock fetch); `now` is the device clock in seconds (tests pin it), used only to tell
 * whether drand's relays should already have the draw's round.
 */
export async function verifyDraw({ pub, draw, token, id, row, startBlock = 0, exclude = [], pools = [], onCheck = () => {}, onProgress = () => {}, drandOpts = {}, now = () => Math.floor(Date.now() / 1000) }) {
  const checks = [];
  const add = (status, text, extra = {}) => { const c = { status, text, ...extra }; checks.push(c); onCheck(c); return c; };
  const ok = (cond, text) => add(cond ? "pass" : "fail", text);
  const st = { chain: undefined, randomnessWhy: null, randomnessConflict: false, relayUnconfirmed: false };
  const done = (extra = {}) => {
    const unk = checks.filter((c) => c.unknown);
    return { ok: !checks.some((c) => c.status === "fail"), incomplete: unk.length > 0, incompleteWhy: unk.map((c) => c.why).filter(Boolean), checks, chain: st.chain, randomnessWhy: st.randomnessWhy, randomnessConflict: st.randomnessConflict, relayUnconfirmed: st.relayUnconfirmed, ...extra };
  };
  const errText = (e) => e?.shortMessage ?? e?.message ?? String(e);
  const couldnt = (what, e) => add("warn",
    `Couldn't check ${what}: the RPC refused or failed (${errText(e)}). This is not a FAIL: nothing read so far contradicts the chain. Verify again with your own RPC or bot/pons/verify-draw.mjs`,
    { unknown: true, why: `the RPC refused or failed ${what} (${errText(e)})` });
  try {
    return await body();
  } catch (e) {
    if (e?.mismatch) { add("fail", e.message); return done(); }
    couldnt("a read", e);
    return done();
  }

  async function body() {
  const v = (functionName, args = []) => pub.readContract({ address: draw, abi: drawAbi, functionName, args });
  const fromBlock = toBlockNum(startBlock);

  const idN = BigInt(id);
  const count = await v("drawCount");
  if (!ok(idN < count, `The draw contract has a draw #${id} (it has ${count} so far)`)) return done();
  const d = await v("getDraw", [idN]);
  const [beacon, splitter, head] = await Promise.all([v("beacon"), v("splitter"), pub.getBlockNumber()]);
  const skip = [...new Set([draw, splitter, ...exclude].filter(Boolean).map((a) => a.toLowerCase()))];
  add("info", `Draw ${id}: ${Number(d.track) === 0 ? "regular" : "mega"} track, snapshot at ${new Date(Number(d.snapshotTime) * 1000).toLocaleString()}, drand round ${d.drandRound}`);
  if (d.cancelled) { add("fail", "This draw was cancelled before it settled: nobody won it"); return done(); }
  if (!ok(d.settled, "The draw is settled")) return done();

  // 0: the draw's own logs, and the row shown on the page against them
  let committed, end;
  try {
    committed = await findCommitted({ pub, draw, id: idN, fromBlock, toBlock: head });
    end = await findDrawEnd({ pub, draw, id: idN, fromBlock: committed.blockNumber, toBlock: head });
  } catch (e) {
    if (e?.mismatch) { add("fail", `Could not find the draw's commit and settle logs: ${e.message}`); return done(); }
    couldnt("the draw's commit and settle logs", e);
    return done();
  }
  const paid = end.eventName === "Settled";
  const rolled = end.eventName === "RolledOver";
  if (end.eventName === "Cancelled") { add("fail", "The draw contract cancelled this draw: nobody won it"); return done(); }
  const chain = {
    id: Number(idN), kind: paid ? "paid" : "rolled", track: Number(d.track) === 1 ? "mega" : "regular",
    winner: paid ? end.args.winner : ZERO, amountWei: (paid ? end.args.amount : d.amount).toString(), tx: end.transactionHash,
    at: null,
  };
  st.chain = chain;
  let committedAt = null;
  try {
    const [cb, eb] = await Promise.all([pub.getBlock({ blockNumber: committed.blockNumber }), pub.getBlock({ blockNumber: end.blockNumber })]);
    committedAt = cb.timestamp; chain.at = Number(eb.timestamp);
  } catch { /* optional */ }
  ok(Number(committed.args.track) === Number(d.track) && BigInt(committed.args.snapshotTime) === BigInt(d.snapshotTime) && BigInt(committed.args.drandRound) === BigInt(d.drandRound) && BigInt(committed.args.amount) === BigInt(d.amount)
    && committed.args.root === d.root && BigInt(committed.args.totalWeight) === BigInt(d.totalWeight),
    `The Committed log (tx ${committed.transactionHash}) agrees with the stored draw: snapshot, round, prize, and the list's root and total weight were pinned at commit`);
  ok(!paid || (same(end.args.winner, d.winner) && BigInt(end.args.totalWeight) === BigInt(d.totalWeight) && end.args.root === d.root && BigInt(end.args.randomWord) === BigInt(d.randomWord) && BigInt(end.args.amount) === BigInt(d.amount)),
    `The ${end.eventName} log (tx ${end.transactionHash}) agrees with the stored draw`);
  if (row) {
    const rowWinner = row.winner || ZERO;
    ok(same(rowWinner, chain.winner), rolled
      ? `The page shows ${same(rowWinner, ZERO) ? "no winner" : `a winner (${rowWinner})`}; the contract rolled this pot over`
      : `The winner shown on the page is the one the contract paid (${getAddress(chain.winner)})`);
    const amt = toWei(row.amountWei);
    if (!(rolled && amt === null)) ok(amt !== null && amt.toString() === chain.amountWei, `The amount shown on the page (${row.amountWei ?? "none"} wei) is what the contract ${paid ? "paid" : "rolled over"} (${chain.amountWei} wei)`);
    ok(trackNum(row.track) === Number(d.track), `The track shown on the page (${row.track ?? "none"}) is the draw's (${chain.track})`);
    if (row.kind !== undefined && row.kind !== null) ok(row.kind === chain.kind, `The page shows this draw as ${row.kind === "rolled" ? "rolled over" : row.kind === "paid" ? "paid" : JSON.stringify(row.kind)}; the contract ${paid ? "paid a winner" : "rolled the pot over"}`);
    ok(typeof row.tx === "string" && same(row.tx, chain.tx), `The transaction linked on the page is the contract's ${end.eventName} transaction`);
    if (row.at !== undefined && row.at !== null && chain.at !== null) ok(Number(row.at) === chain.at, "The time shown on the page is the settle block's time");
  } else add("info", "No row to compare: showing the chain's values");

  // 1: committed before the round. The round's publish time comes from drand's pinned evmnet constants, never the
  // RPC's beacon GENESIS / PERIOD, which a lying RPC also answers [R10 finding 3].
  const roundN = BigInt(d.drandRound);
  const roundTime = roundTimeOf(roundN);
  const roundWhen = new Date(Number(roundTime) * 1000).toLocaleString();
  {
    const delay = await v("COMMIT_DELAY").catch(() => undefined);
    const cd = typeof delay === "bigint" ? delay : DEFAULTS.commitDelay;
    const snapT = BigInt(d.snapshotTime);
    const late = roundN >= 1n && roundTime >= snapT + cd;
    ok(late, late
      ? `drand round ${d.drandRound} is published at ${roundWhen}, at least ${fmtDur(Number(cd))} after the snapshot, so nobody knew it when the snapshot was taken`
      : `drand round ${d.drandRound} is published at ${roundWhen}, less than the contract's ${fmtDur(Number(cd))} commit delay after the snapshot: it could have been known when the snapshot was taken`);
    if (committedAt === null) {
      add("warn", `Couldn't read the time of the block that committed this draw, so the site couldn't check it came before drand round ${d.drandRound} (published at ${roundWhen})`,
        { unknown: true, why: "the RPC didn't return the Committed block's time, so the commit wasn't checked against the round's publish time" });
    } else {
      ok(committedAt + cd <= roundTime, committedAt + cd <= roundTime
        ? `The commit (block ${committed.blockNumber}, ${new Date(Number(committedAt) * 1000).toLocaleString()}) is at least ${fmtDur(Number(cd))} before the round's time ${roundWhen}: the randomness didn't exist yet`
        : `The commit (block ${committed.blockNumber}, ${new Date(Number(committedAt) * 1000).toLocaleString()}) is less than ${fmtDur(Number(cd))} before the round's time ${roundWhen}: the contract refuses that, so this RPC's draw is made up`);
      ok(committedAt >= snapT, committedAt >= snapT
        ? "The snapshot time is at or before the commit block, as the contract requires"
        : `The snapshot time (${new Date(Number(snapT) * 1000).toLocaleString()}) is after the commit block: the contract refuses that, so this RPC's draw is made up`);
    }
    const verb = paid ? "settled" : "rolled over";
    if (chain.at === null) {
      add("warn", `Couldn't read the time of the block that ${verb} this draw, so the site couldn't check that drand round ${d.drandRound} (published at ${roundWhen}) came out before it`,
        { unknown: true, why: `the RPC didn't return the ${end.eventName} block's time, so the round's publish time wasn't checked against it` });
    } else {
      const atWhen = new Date(chain.at * 1000).toLocaleString();
      ok(roundTime <= BigInt(chain.at), roundTime <= BigInt(chain.at)
        ? `drand round ${d.drandRound} was published (${roundWhen}) before this draw was ${verb} (${atWhen})`
        : `drand round ${d.drandRound} is published after this draw was ${verb}: drand's evmnet publishes it at ${roundWhen}, but the ${end.eventName} block is at ${atWhen}. Nobody could have settled it then: this RPC's randomness for the round is made up`);
    }
  }

  // 2: randomness. Candidate signatures, in order: the settle transaction's calldata, the calldata of the transaction
  // that proved the round on the beacon (a direct prove, or another draw's settle), then drand's relays. A candidate
  // counts only if isValid and keccak256(sig) == stored, since prove() ignores its signature once the round is proven
  // [R7 finding 3]. Not getting a valid one is an unknown, never a FAIL: the beacon checked it on chain, and the rest of
  // the draw is still recomputed below from the stored randomness [R6 finding 10].
  const stored = await pub.readContract({ address: beacon, abi: beaconAbi, functionName: "randomness", args: [d.drandRound] });
  const range = { fromBlock: committed.blockNumber, toBlock: end.blockNumber };
  const rnd = await checkRandomness({
    pub, beacon, round: d.drandRound, stored,
    sources: [
      { from: "the settle transaction's calldata", get: () => settleSignature({ pub, draw, id: idN, log: end }) },
      { from: "the beacon's prove transaction", get: () => proveSignature({ pub, beacon, draw, round: d.drandRound, ...range }) },
      {
        from: "drand's relays",
        independent: true,
        none: `drand's relays don't have round ${d.drandRound}`,
        // a round more than 30 s past its publish time by this device's clock: relays saying "not published" is a conflict
        due: roundN >= 1n && Number(roundTime) + 30 <= now() ? roundWhen : null,
        get: async () => {
          try { return await drandSignature(d.drandRound, drandOpts); }
          catch { throw Object.assign(new Error("drand unreachable"), { whyUnknown: "drand unreachable" }); }
        },
      },
    ],
  });
  let randomnessWhy = null;
  if (rnd.status === "pass") {
    add("info", `drand round ${d.drandRound}'s signature, read from ${rnd.from}`);
    add("pass", "The signature verifies against drand's public key (beacon isValid, eth_call)");
    add("pass", "The beacon's stored randomness is keccak256 of that signature");
    if (rnd.relay?.status === "agree" && rnd.from !== rnd.relay.from) add("pass", `drand's relays, which this RPC doesn't control, return the same signature (${rnd.relay.hosts}) [R8 finding 9]`);
    for (const o of rnd.relay?.others ?? []) add("info", `Another drand relay disagreed, but ${rnd.relay.hosts} matched the stored randomness: ${o}`);
    if (rnd.relay?.status === "none") {
      // [R10 finding 3] an RPC-only pass is amber, never the green "Verified": a lying RPC answers its own isValid
      st.relayUnconfirmed = true;
      add("warn", `drand's relays couldn't cross-check it (${rnd.relay.why}), so the signature was checked only through this RPC`,
        { unknown: true, why: `drand's relays didn't confirm the randomness (${rnd.relay.why}); it was checked only through this RPC` });
    }
  } else if (rnd.status === "fail") {
    add("fail", `The beacon's stored randomness doesn't match drand: ${rnd.why}`);
  } else if (rnd.conflict) {
    randomnessWhy = st.randomnessWhy = rnd.why;
    st.randomnessConflict = true; // [R9 finding 8] leads the summary, never "try again later"
    add("warn", `drand's relays DISAGREE with this RPC: ${rnd.why}. The beacon's stored randomness for round ${d.drandRound} is used unchecked`, { unknown: true, why: `drand's relays DISAGREE with this RPC (${rnd.why})` });
  } else {
    randomnessWhy = st.randomnessWhy = rnd.why;
    add("warn", `Couldn't check randomness (${rnd.why}): the beacon's stored randomness for round ${d.drandRound} is used unchecked. Try Verify again later`, { unknown: true, why: `randomness couldn't be checked (${rnd.why})` });
  }
  const word = randomWordOf(stored, idN);
  ok(word === BigInt(d.randomWord), "The random word is keccak256(randomness, draw id), as the contract recorded");

  // 3: the list, rebuilt from every Transfer up to the snapshot. The settle block bounds the scan: the snapshot is
  // before the commit, which is before the settle.
  let list;
  try {
    const logs = await transferLogs({ pub, token, fromBlock, toBlock: end.blockNumber, onProgress: (a, b) => onProgress(`Scanning transfers, block ${a} of ${b}`) });
    const times = blockTimes(pub);
    await times.prefetch(logs.map((l) => l.blockNumber), { onProgress: (i, n) => onProgress(`Reading block times ${i}/${n}`) });
    list = await listAtTime({ logs, timeOf: times.timeOf, snapshotTime: d.snapshotTime, exclude: skip });
  } catch (e) {
    if (e?.mismatch) { add("fail", `Could not rebuild the draw list from Transfer logs: ${e.message}`); return done({ chain, randomnessWhy }); }
    // the public RPC caps eth_getLogs at 10,000 results: a refusal is not evidence about the draw [R8 finding 2]
    couldnt("the token's Transfer logs, so the list and the winner weren't recomputed", e);
    return done({ chain, randomnessWhy });
  }
  const { rows, totalWeight, state } = list;
  const { root } = merkle(rows);
  if (skip.length) add("info", `Infra addresses left out of the list, as the keeper does: ${skip.map((a) => getAddress(a)).join(", ")}`);
  add("info", `Replayed ${list.transfers} transfers${list.lastBlock !== null ? ` up to block ${list.lastBlock}` : ""}: ${rows.length} eligible wallets, total weight ${totalWeight}`);
  ok(root === d.root, root === d.root
    ? `The list rebuilt from Transfer logs has the root the contract pinned (${root})`
    : `The list rebuilt from Transfer logs has root ${root}, but the contract pinned ${d.root}: the keeper's published list isn't the chain's`);
  ok(totalWeight === BigInt(d.totalWeight), `Its total weight ${totalWeight} ${totalWeight === BigInt(d.totalWeight) ? "matches" : "differs from"} the contract's ${d.totalWeight}`);

  // 4: the winner
  const chosen = pick(rows, totalWeight, word);
  if (!chosen) {
    ok(rolled && same(d.winner, ZERO), "Nobody was eligible at the snapshot, so the pot rolled over");
    return done({ chain, randomnessWhy });
  }
  ok(paid && same(chosen.row.account, d.winner), `Recomputed winner ${getAddress(chosen.row.account)} (index ${chosen.index}, target ${chosen.target} of ${totalWeight}) ${paid && same(chosen.row.account, d.winner) ? "is" : "is NOT"} the contract's winner`);
  if (paid) {
    const inList = rows.find((r) => same(r.account, d.winner));
    if (inList) ok(BigInt(end.args.amount) === BigInt(d.amount) && same(end.args.winner, d.winner), `Settled log: ${getAddress(end.args.winner)} paid ${end.args.amount} wei (tx ${end.transactionHash})`);
    else add("fail", `The contract's winner ${d.winner} isn't in the list rebuilt from Transfer logs`);
  }

  // Provenance: how long it held and whether it ever bought
  const ws = state.get(d.winner.toLowerCase());
  const bal = ws?.balance ?? 0n;
  if (ws) {
    chain.heldSeconds = Number(BigInt(d.snapshotTime) - ws.holdStart);
    add("info", `Winner had held ${fmtTokens(bal)} tokens for ${fmtDur(chain.heldSeconds)} at the snapshot (hold clock replayed from Transfer logs)`);
  }
  // the X bot's capped pool-source rule, so a dust swap bundled with a big transfer isn't a "buy" [R6 finding 9]
  const b = await boughtFromPool({ pub, token, pools, skip, wallet: d.winner, beforeTs: Number(d.snapshotTime), balance: bal, firstBuyTx: row?.firstBuyTx, fromBlock, toBlock: committed.blockNumber });
  const siteFlag = poolFlagOf(b);
  if (!pools.length) add("info", "No pool addresses configured: the pool-buy heuristic can't tell a buy from a transfer");
  else if (siteFlag === null) add("pass", `Heuristic: the winner bought from the pool before the draw: ${b.how}, first on ${new Date(b.at * 1000).toLocaleString()}`);
  else if (siteFlag === "small") add("warn", `Heuristic: the winner bought under 10% of its ${fmtTokens(bal)}-token balance from the pool before the draw (${b.how}). The rest arrived by transfer`);
  else if (siteFlag === "none") add("warn", `Heuristic: ${b.how} before the draw. Its tokens may all have arrived by transfer`);
  else add("warn", `Couldn't confirm the winner bought from the pool: ${b.how}`);
  chain.boughtWei = b.boughtWei.toString();
  chain.balanceWei = bal.toString();
  chain.poolFlag = pools.length ? siteFlag : "unknown";
  // the bot's own flag, from the snapshot: shown, and never cleared by this check
  const botFlag = row && ["none", "small"].includes(row.poolFlag) ? row.poolFlag : null;
  const botWei = row ? toWei(row.boughtWei) : null;
  if (row && (botFlag || botWei !== null)) {
    const said = botFlag === "none" ? "no pool buy found" : botFlag === "small" ? "pool buys under 10% of the balance" : "bought from the pool";
    add("info", `The bot's snapshot says: ${said}${botWei !== null ? ` (${tokensText(botWei)} bought before the snapshot)` : ""}`);
    if (botFlag && strongerFlag(botFlag, siteFlag) === botFlag && botFlag !== siteFlag) {
      add("warn", `The bot flags this winner (${said}) and this check found ${siteFlag === null ? "a buy" : siteFlag === "unknown" ? "nothing conclusive" : "a weaker signal"}; the card keeps the bot's flag`);
    }
  }

  return done({ chain, bought: pools.length ? b : null, randomnessWhy });
  }
}

export function fmtDur(s) {
  s = Math.max(0, Math.floor(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${s}s`;
}
