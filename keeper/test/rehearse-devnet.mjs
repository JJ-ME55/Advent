// A full door on devnet, end to end, in about 15 minutes:
//   1. a throwaway mint (6 decimals) whose supply sits in a "curve" wallet; four buyers get tokens from it
//      (one below the minimum, one too late); the door and bonus wallets get gas; the door wallet gets a pot;
//   2. a door scheduled SNAPSHOT_LEAD + 2 min from now; the keeper is run with ONCE=1 every 15 s until the door
//      is settled (snapshot → commit memo → drand round → payouts);
//   3. verify-door recomputes it.
// Needs keys/treasury.json funded on devnet (faucet.solana.com). Writes to scratch/rehearsal/.
//   node test/rehearse-devnet.mjs
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer } from "@solana/spl-token";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connections, withRpc, loadKeypair, balanceOf } from "../src/solana.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
process.env.RPC_URL = RPC;
const conns = connections();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const out = join(root, "scratch", "rehearsal"); mkdirSync(out, { recursive: true });

const treasury = loadKeypair(join(root, "keys", "treasury.json"));
const door = loadKeypair(join(root, "keys", "door.json"));
const bonus = loadKeypair(join(root, "keys", "bonus.json"));
const curve = Keypair.generate();
const buyers = Array.from({ length: 4 }, () => Keypair.generate());
log("treasury", treasury.publicKey.toBase58(), "balance", Number(await balanceOf(conns, treasury.publicKey)) / LAMPORTS_PER_SOL, "SOL");

async function fund(to, sol) {
  await withRpc(conns, async (c) => {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = treasury.publicKey; tx.sign(treasury);
    const s = await c.sendRawTransaction(tx.serialize()); await c.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, "confirmed");
  });
}
const conn = conns[0];

// 1. the coin and its "buyers"
await fund(curve.publicKey, 0.05);
for (const b of buyers) await fund(b.publicKey, 0.02);
await fund(door.publicKey, 0.5); // the pot (+ gas)
await fund(bonus.publicKey, 0.05);
const mint = await createMint(conn, treasury, treasury.publicKey, null, 6);
log("mint", mint.toBase58());
const curveAta = await getOrCreateAssociatedTokenAccount(conn, curve, mint, curve.publicKey);
await mintTo(conn, treasury, mint, curveAta.address, treasury, 1_000_000_000n * 1_000_000n);
const buy = async (b, tokens) => { const ata = await getOrCreateAssociatedTokenAccount(conn, b, mint, b.publicKey); await transfer(conn, curve, curveAta.address, ata.address, curve, tokens * 1_000_000n); };
await buy(buyers[0], 300_000n); await buy(buyers[1], 150_000n); await buy(buyers[2], 50_000n); // 50k is under the 100k minimum
log("buyers", buyers.map((b) => b.publicKey.toBase58()).join(" "));

// 2. the door: snapshot in 2 min, door SNAPSHOT_LEAD later; eligibility needs ELIGIBLE_AFTER (60 s here)
const lead = 180, elig = 60;
const now = Math.floor(Date.now() / 1000);
const doorAt = now + 120 + lead;
const env = {
  ...process.env, RPC_URL: RPC, MINT: mint.toBase58(), TREASURY_KEYPAIR: join(root, "keys", "treasury.json"), DOOR_KEYPAIR: join(root, "keys", "door.json"), BONUS_KEYPAIR: join(root, "keys", "bonus.json"),
  XMAS_WALLET: Keypair.generate().publicKey.toBase58(), TEAM_WALLET: Keypair.generate().publicKey.toBase58(), EXCLUDE: curve.publicKey.toBase58(),
  DRAWS_DIR: join(out, "draws"), STATE_FILE: join(out, "keeper-state.json"), BONUS_ENTRANTS_FILE: join(out, "bonus-entrants.json"),
  CLAIM: "0", ONCE: "1", FIRST_DOOR: "-1", LAST_DOOR: "-1", DOOR_TIMES: JSON.stringify({ "-1": doorAt }), SNAPSHOT_LEAD_SECONDS: String(lead), ELIGIBLE_AFTER_SECONDS: String(elig), FLOOR_SOL: "0.01", RESERVE_SOL: "0.01",
};
writeFileSync(join(out, "bonus-entrants.json"), JSON.stringify({ "-1": [buyers[0].publicKey.toBase58(), buyers[1].publicKey.toBase58()] }));
writeFileSync(join(out, "env.json"), JSON.stringify({ mint: mint.toBase58(), curve: curve.publicKey.toBase58(), doorAt, buyers: buyers.map((b) => b.publicKey.toBase58()) }, null, 1));
log(`door -1 at ${new Date(doorAt * 1000).toISOString()} (snapshot ${lead} s before). Late buyer joins after the snapshot.`);

const keeper = () => { const r = spawnSync(process.execPath, [join(here, "..", "src", "keeper.mjs")], { env, stdio: "inherit" }); if (r.status !== 0) log(`keeper exited ${r.status}`); };
let lateDone = false;
for (;;) {
  const t = Math.floor(Date.now() / 1000);
  if (!lateDone && t >= doorAt - lead + 5) { await buy(buyers[3], 400_000n); lateDone = true; log("late buyer bought after the snapshot (must not be in the list)"); }
  keeper();
  const f = join(out, "draws", "door--1.json");
  if (existsSync(f) && JSON.parse(readFileSync(f, "utf8")).result) break;
  if (t > doorAt + 900) { log("gave up: the door never settled"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 15_000));
}
const doc = JSON.parse(readFileSync(join(out, "draws", "door--1.json"), "utf8"));
log("settled: winners", doc.result.winners.map((w) => `${w.account} ${w.lamports}`).join(" | "), "bonus", doc.result.bonus.length);

// 3. verify
const v = spawnSync(process.execPath, [join(here, "..", "src", "verify-door.mjs"), "-1"], { env: { ...env, TREASURY: treasury.publicKey.toBase58(), DOOR_WALLET: door.publicKey.toBase58() }, stdio: "inherit" });
process.exit(v.status);
