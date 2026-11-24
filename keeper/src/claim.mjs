// pump.fun creator fees: sweep what the curve (and, after graduation, the PumpSwap pool) holds into the creator
// vault, then collect the vault into the creator's wallet. Everything is permissionless but the fee payer signs;
// here the creator (the treasury keypair) pays. The SDK is CommonJS-only in practice (its ESM entry trips on an
// Anchor named export), so it is loaded with createRequire.
import { createRequire } from "node:module";
import { Transaction, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import { withRpc } from "./solana.mjs";

const require = createRequire(import.meta.url);
const pump = require("@pump-fun/pump-sdk");
const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Lamports waiting in the creator vault PDA (curve fees already swept) for `creator`. */
export async function creatorVaultLamports(conns, creator) {
  const pda = pump.creatorVaultPda(new PublicKey(creator));
  const vault = Array.isArray(pda) ? pda[0] : pda;
  return withRpc(conns, (c) => c.getBalance(vault, "confirmed")).then(BigInt);
}

/** Lamports of creator fee sitting unswept on the bonding curve (BondingCurve.creatorFee), 0 once migrated. */
export async function curveCreatorFee(conns, mint) {
  return withRpc(conns, async (c) => {
    const sdk = new pump.OnlinePumpSdk(c);
    try { const bc = await sdk.fetchBondingCurve(new PublicKey(mint)); return { lamports: BigInt(bc.creatorFee?.toString() ?? 0), complete: !!bc.complete, creator: bc.creator?.toBase58?.() ?? null }; }
    catch (e) { return { lamports: 0n, complete: null, creator: null, error: e.message }; }
  });
}

/**
 * Sweep + collect in one transaction when at least `minLamports` is claimable (vault + unswept curve fee).
 * Returns { lamports, signature } or null when there was nothing worth claiming.
 */
export async function claimCreatorFees(conns, creatorKeypair, mint, minLamports = 50_000_000n) {
  const creator = creatorKeypair.publicKey;
  const vault = await creatorVaultLamports(conns, creator);
  const curve = await curveCreatorFee(conns, mint);
  const claimable = vault + curve.lamports;
  if (claimable < minLamports) return null;
  return withRpc(conns, async (c) => {
    const sdk = new pump.OnlinePumpSdk(c);
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 })];
    const mintPk = new PublicKey(mint);
    if (curve.lamports > 0n) ixs.push(await pump.PUMP_SDK.sweepCreatorFeeInstruction({ payer: creator, mint: mintPk, creator, quoteMint: NATIVE_MINT }));
    if (curve.complete) {
      try { ixs.push(await pump.PUMP_SDK.sweepPoolCreatorFeeInstruction({ payer: creator, mint: mintPk, coinCreator: creator, quoteMint: NATIVE_MINT })); } catch { /* no canonical pool yet */ }
    }
    ixs.push(...(await sdk.collectCoinCreatorFeeInstructions(creator, creator)));
    const tx = new Transaction().add(...ixs);
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = creator; tx.sign(creatorKeypair);
    const before = BigInt(await c.getBalance(creator, "confirmed"));
    const sig = await c.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await c.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    const after = BigInt(await c.getBalance(creator, "confirmed"));
    return { lamports: after > before ? after - before : claimable, signature: sig };
  });
}
