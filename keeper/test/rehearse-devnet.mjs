// A full door on devnet, end to end, in about 15 minutes:
//   1. a throwaway mint (6 decimals) whose supply sits in a "curve" wallet; four buyers get tokens from it
//      (one below the minimum, one too late); the door and bonus wallets get gas; the door wallet gets a pot;
//   2. a door scheduled SNAPSHOT_LEAD + 2 min from now; the keeper is run with ONCE=1 every 15 s until the door
//      is settled (snapshot → commit memo → drand round → winners fixed, nothing paid);
//   3. every buyer opens the door through the API with a signed message; the winners claim and are paid;
//   4. verify-door recomputes it and checks the claimed payouts.
// Needs keys/treasury.json funded on devnet (faucet.solana.com). Writes to scratch/rehearsal/.
//   node test/rehearse-devnet.mjs
import { Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction } from "@solana/web3.js";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo, transfer } from "@solana/spl-token";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connections, withRpc, loadKeypair, balanceOf } from "../src/solana.mjs";

process.on("unhandledRejection", (e) => console.log("unhandled (ignored):", String(e?.message ?? e).slice(0, 120)));
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
process.env.RPC_URL = RPC;
const conns = connections();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const out = join(root, "scratch", "rehearsal"); rmSync(out, { recursive: true, force: true }); mkdirSync(out, { recursive: true }); // a fresh door every time

const treasury = loadKeypair(join(root, "keys", "treasury.json"));
const door = loadKeypair(join(root, "keys", "door.json"));
const bonus = loadKeypair(join(root, "keys", "bonus.json"));
const curve = Keypair.generate();
const buyers = Array.from({ length: 4 }, () => Keypair.generate());
log("treasury", treasury.publicKey.toBase58(), "balance", Number(await balanceOf(conns, treasury.publicKey)) / LAMPORTS_PER_SOL, "SOL");

async function fund(to, sol) {
  await retry(() => withRpc(conns, async (c) => {
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: treasury.publicKey, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) }));
    const { blockhash, lastValidBlockHeight } = await c.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash; tx.feePayer = treasury.publicKey; tx.sign(treasury);
    const s = await c.sendRawTransaction(tx.serialize()); await c.confirmTransaction({ signature: s, blockhash, lastValidBlockHeight }, "confirmed");
  }), "fund"); await sleep(1500);
}
const conn = conns[0];
// public devnet rate-limits: retry everything in the setup with backoff
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(fn, what) { for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= 6) throw e; log(`${what}: ${e.message.slice(0, 80)} (retry ${i + 1})`); await sleep(2500 * 2 ** i); } } }

// 1. the coin and its "buyers"
await fund(curve.publicKey, 0.05);
for (const b of buyers) await fund(b.publicKey, 0.02);
await fund(door.publicKey, 0.5); // the pot (+ gas)
await fund(bonus.publicKey, 0.05);
const mint = await retry(() => createMint(conn, treasury, treasury.publicKey, null, 6), "createMint"); await sleep(2000);
log("mint", mint.toBase58());
const curveAta = await retry(() => getOrCreateAssociatedTokenAccount(conn, curve, mint, curve.publicKey), "curve ata");
await retry(() => mintTo(conn, treasury, mint, curveAta.address, treasury, 1_000_000_000n * 1_000_000n), "mintTo");
const buy = async (b, tokens) => { const ata = await retry(() => getOrCreateAssociatedTokenAccount(conn, b, mint, b.publicKey), "buyer ata"); await retry(() => transfer(conn, curve, curveAta.address, ata.address, curve, tokens * 1_000_000n), "buy"); await sleep(2000); };
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
  RESULTS_DIR: join(out, "results"), CLAIMS_FILE: join(out, "claims.json"), VILLAGE_STATE_FILE: join(out, "village.json"),
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
  if (t > doorAt + 2400) { log("gave up: the door never settled"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 15_000));
}
const doc = JSON.parse(readFileSync(join(out, "draws", "door--1.json"), "utf8"));
log("settled: prizes", doc.result.winners.map((w) => `#${w.k} ${w.lamports}${w.account ? " " + w.account : " (unopened)"}`).join(" | "), "bonus", doc.result.bonus.length);
if (doc.result.winners.some((w) => w.account)) { log("FAIL: the published door names a winner before anyone opened"); process.exit(1); }

// 3. everyone opens their door through the API; winners claim
// a free port: the API prints the one it got
const apiProc = spawn(process.execPath, [join(here, "..", "src", "api.mjs")], { env: { ...env, PORT: "0" }, stdio: ["ignore", "pipe", "inherit"] });
const PORT = await new Promise((resolve, reject) => { let buf = ""; apiProc.stdout.on("data", (c) => { buf += c; process.stdout.write(c); const m = /advent api on :(\d+)/.exec(buf); if (m) resolve(Number(m[1])); }); apiProc.on("exit", (c) => reject(new Error(`api exited ${c}`))); });
const call = async (method, path, body) => { const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }); return [r.status, await r.json()]; };
const signedBody = async (kp, action) => { const [, { nonce }] = await call("GET", `/nonce/${kp.publicKey.toBase58()}`); const msg = `ADVENT ${action} ${kp.publicKey.toBase58()} ${nonce}`; return { wallet: kp.publicKey.toBase58(), nonce, signature: bs58.encode(nacl.sign.detached(Buffer.from(msg), kp.secretKey)) }; };
let claimedDoor = 0, claimedBonus = 0, failed = false;
for (const b of buyers) {
  const [oc, o] = await call("POST", "/door/-1/open", await signedBody(b, "open--1"));
  log(`open(door -1, ${b.publicKey.toBase58().slice(0, 6)}) -> ${oc} ${JSON.stringify(o)}`);
  if (oc === 200 && o.won) {
    const [cc, c] = await call("POST", "/door/-1/claim", await signedBody(b, "claim--1"));
    log(`claim(door -1, ${b.publicKey.toBase58().slice(0, 6)}) -> ${cc} ${JSON.stringify(c)}`);
    if (cc !== 200) failed = true; else claimedDoor++;
    const [c2c, c2] = await call("POST", "/door/-1/claim", await signedBody(b, "claim--1"));
    log(`claim again -> ${c2c} ${JSON.stringify(c2)}`); if (c2c !== 409) failed = true;
  }
  const [bc, bo] = await call("POST", "/bonus/-1/open", await signedBody(b, "bonus--1"));
  if (bc === 200 && bo.won) { const [cc, c] = await call("POST", "/bonus/-1/claim", await signedBody(b, "bonus-claim--1")); log(`claim(bonus -1, ${b.publicKey.toBase58().slice(0, 6)}) -> ${cc} ${JSON.stringify(c)}`); if (cc !== 200) failed = true; else claimedBonus++; }
}
const [, pub] = await call("GET", "/winners/-1");
log(`GET /winners/-1 -> ${pub.winnerCount} prizes, ${pub.claimedCount} claimed, named: ${pub.winners.map((w) => w.account.slice(0, 6)).join(" ")}`);
apiProc.kill();
if (failed || claimedDoor !== doc.result.winners.length) { log(`FAIL: ${claimedDoor}/${doc.result.winners.length} door prizes claimed, ${claimedBonus} bonus`); process.exit(1); }
keeper(); // republish: the keeper picks the claims up for door--1.json so the verifier (and the poster) see them
await sleep(3000);

// 4. verify
const v = spawnSync(process.execPath, [join(here, "..", "src", "verify-door.mjs"), "-1"], { env: { ...env, TREASURY: treasury.publicKey.toBase58(), DOOR_WALLET: door.publicKey.toBase58() }, stdio: "inherit" });
process.exit(v.status);
