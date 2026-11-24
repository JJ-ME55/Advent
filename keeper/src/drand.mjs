// drand evmnet (BN254, 3 s rounds): the public randomness every door is drawn from. Rounds are addressed by time so
// a door's round can be named before it exists; the signature is fetched from several relays and hashed into the
// seed. Verification of the BLS signature itself happens in the verifier (bls-bn254) and on the site; the keeper
// only needs the relays to agree.
import { createHash } from "node:crypto";

export const GENESIS = 1727521075n;
export const PERIOD = 3n;
export const CHAIN_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
export const RELAYS = ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"];

/** The first round whose time is >= t. */
export function roundAt(t) {
  t = BigInt(t);
  if (t <= GENESIS) return 1n;
  return (t - GENESIS + PERIOD - 1n) / PERIOD + 1n;
}
export const roundTime = (round) => GENESIS + (BigInt(round) - 1n) * PERIOD;

/** The round's signature as a hex string, or null if no relay has it yet. Throws only if every relay errors. */
export async function drandSignature(round, { relays = RELAYS, fetchFn = fetch, timeoutMs = 8000 } = {}) {
  let errors = 0, unpublished = 0;
  for (const base of relays) {
    try {
      const r = await fetchFn(`${base}/v2/beacons/evmnet/rounds/${round}`, { signal: AbortSignal.timeout(timeoutMs) });
      if (r.status === 404) { unpublished++; continue; }
      if (!r.ok) { errors++; continue; }
      const j = await r.json();
      if (typeof j.signature === "string" && /^[0-9a-f]{128}$/i.test(j.signature)) return j.signature.toLowerCase();
      errors++;
    } catch { errors++; }
  }
  if (unpublished > 0) return null;
  throw new Error(`drand: ${errors} relays failed for round ${round}`);
}

/** Every relay's answer, for the verifier's cross-check: Map(relay -> signature | null | error). */
export async function drandSignatures(round, opts = {}) {
  const out = new Map();
  for (const base of opts.relays ?? RELAYS) {
    try { out.set(base, await drandSignature(round, { ...opts, relays: [base] })); } catch (e) { out.set(base, `error: ${e.message}`); }
  }
  return out;
}

export const seedOf = (signatureHex) => createHash("sha256").update(Buffer.from(signatureHex.replace(/^0x/, ""), "hex")).digest("hex");
