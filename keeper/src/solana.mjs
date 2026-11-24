// Solana: a connection with fallback endpoints, memo and SOL-transfer transactions, memo lookup, and the coin's
// balance history from Helius (per-transaction net deltas per owner, which is what the drum replays).
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync } from "node:fs";

export { LAMPORTS_PER_SOL, PublicKey, Keypair };
export const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/** RPC_URL may list several endpoints, comma-separated; each call tries them in order. */
export function rpcs(env = process.env) {
  return (env.RPC_URL ?? "https://api.mainnet-beta.solana.com").split(",").map((s) => s.trim()).filter(Boolean);
}
export function connections(env = process.env) {
  return rpcs(env).map((u) => new Connection(u, { commitment: "confirmed" }));
}
/** Runs fn(connection) against each endpoint until one succeeds. */
export async function withRpc(conns, fn) {
  let last;
  for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw last ?? new Error("no RPC endpoints");
}

export function loadKeypair(path = process.env.KEYPAIR_FILE) {
  if (!path) throw new Error("KEYPAIR_FILE is not set");
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export const memoInstruction = (text, signer) => new TransactionInstruction({ keys: signer ? [{ pubkey: signer, isSigner: true, isWritable: false }] : [], programId: MEMO_PROGRAM, data: Buffer.from(text, "utf8") });

async function sendAndConfirm(conns, tx, signers) {
  return withRpc(conns, async (c) => {
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = signers[0].publicKey;
    tx.sign(...signers);
    const sig = await c.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const t = await c.getTransaction(sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    return { signature: sig, slot: t?.slot ?? null, blockTime: t?.blockTime ?? null };
  });
}

/** A memo-only transaction from `signer`: the door's commitment. */
export function sendMemo(conns, signer, text) {
  return sendAndConfirm(conns, new Transaction().add(memoInstruction(text, signer.publicKey)), [signer]);
}

/** A SOL transfer with a memo: a payout. */
export function sendSol(conns, signer, to, lamports, memo) {
  const tx = new Transaction()
    .add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: new PublicKey(to), lamports: BigInt(lamports) }))
    .add(memoInstruction(memo, signer.publicKey));
  return sendAndConfirm(conns, tx, [signer]);
}

export const balanceOf = (conns, pubkey) => withRpc(conns, (c) => c.getBalance(new PublicKey(pubkey), "confirmed")).then(BigInt);

/** Memos signed by `address`, newest first: [{signature, slot, blockTime, memo}]. Memo text comes from the log. */
export async function memosOf(conns, address, { limit = 200, filter = () => true } = {}) {
  return withRpc(conns, async (c) => {
    const sigs = await c.getSignaturesForAddress(new PublicKey(address), { limit }, "confirmed");
    const out = [];
    for (const s of sigs) {
      if (!s.memo) continue;
      const memo = s.memo.replace(/^\[\d+\]\s*/, ""); // "[len] text"
      if (filter(memo)) out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime, memo });
    }
    return out;
  });
}

/** The commit memo text and its parser. */
export const commitMemo = ({ door, hash, round, total, winners }) => `ADVENT commit door=${door} hash=${hash} round=${round} total=${total} winners=${winners}`;
export function parseCommit(memo) {
  const m = /^ADVENT commit door=(-?\d+) hash=([0-9a-f]{64}) round=(\d+) total=(\d+) winners=(\d+)$/.exec(memo.trim());
  return m ? { door: Number(m[1]), hash: m[2], round: BigInt(m[3]), total: BigInt(m[4]), winners: Number(m[5]) } : null;
}
export const payoutMemo = ({ door, k, n, hash, kind = "door" }) => `ADVENT ${kind} door=${door} winner=${k}/${n} hash=${hash}`;

/**
 * Balance history of a mint from Helius's enhanced transactions API: every transaction touching the mint, newest
 * first, paginated with `before`. Returns per-owner net deltas in raw units with the transaction's time and slot,
 * oldest first. Stops at `untilSignature` (exclusive) when given, so the caller can extend a cached history.
 */
export async function heliusDeltas(mint, { apiKey = process.env.HELIUS_API_KEY, untilSignature = null, fetchFn = fetch, maxPages = 400, pageLimit = 100 } = {}) {
  if (!apiKey) throw new Error("HELIUS_API_KEY is not set");
  const deltas = [];
  let before = null, pages = 0, done = false;
  while (!done && pages++ < maxPages) {
    const url = `${process.env.HELIUS_BASE ?? "https://api.helius.xyz"}/v0/addresses/${mint}/transactions?api-key=${apiKey}&limit=${pageLimit}${before ? `&before=${before}` : ""}`;
    const r = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`helius ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const txs = await r.json();
    if (!txs.length) break;
    for (const tx of txs) {
      if (untilSignature && tx.signature === untilSignature) { done = true; break; }
      if (tx.transactionError) continue;
      const perOwner = new Map();
      for (const a of tx.accountData ?? []) {
        for (const ch of a.tokenBalanceChanges ?? []) {
          if (ch.mint !== mint) continue;
          const v = BigInt(ch.rawTokenAmount.tokenAmount);
          perOwner.set(ch.userAccount, (perOwner.get(ch.userAccount) ?? 0n) + v);
        }
      }
      let i = 0;
      for (const [owner, delta] of perOwner) deltas.push({ owner, delta, time: tx.timestamp, slot: tx.slot, signature: tx.signature, index: i++ });
    }
    before = txs[txs.length - 1].signature;
  }
  return deltas.reverse();
}
