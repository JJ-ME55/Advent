// Launch day: point the site at the token. Given the token's address it reads the token's first Transfer (the mint to
// the Pons bonding curve) for the curve address, the launch block and its timestamp, writes them into config.js,
// builds dist/, and prints the keeper's and the bot's settings so they can be pasted in. Nothing is committed.
//   node scripts/go-live.mjs 0xTOKEN [https://buy.url]
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createPublicClient, http, getAddress, parseAbiItem } from "viem";

const here = dirname(fileURLToPath(import.meta.url));
const cfgPath = join(here, "..", "config.js");
const token = getAddress(process.argv[2] ?? (() => { console.error("usage: node scripts/go-live.mjs 0xTOKEN [buyUrl]"); process.exit(2); })());
const buyUrl = process.argv[3];
const cfg = readFileSync(cfgPath, "utf8");
const rpc = /rpcUrl:\s*"([^"]+)"/.exec(cfg)[1];
const pub = createPublicClient({ transport: http(rpc) });

const code = await pub.getCode({ address: token });
if (!code || code === "0x") { console.error(`${token} has no code on ${rpc}`); process.exit(1); }
const head = await pub.getBlockNumber();
// the mint (Transfer from the zero address to the curve) is the token's first log: scan back from the head in
// chunks (public RPCs cap the range) until it shows up. START_BLOCK=<n> in the environment skips the scan.
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
const CHUNK = 2000n, MAX_BACK = BigInt(process.env.MAX_BACK ?? 600_000);
let mint = null;
if (process.env.START_BLOCK) {
  const sb = BigInt(process.env.START_BLOCK);
  const got = await pub.getLogs({ address: token, event: TRANSFER, fromBlock: sb, toBlock: sb + CHUNK });
  mint = got.find((l) => l.args.from === ZERO) ?? null;
} else {
  for (let to = head; to > 0n && !mint; to -= CHUNK) {
    const from = to > CHUNK ? to - CHUNK + 1n : 0n;
    const got = await pub.getLogs({ address: token, event: TRANSFER, fromBlock: from, toBlock: to });
    const mints = got.filter((l) => l.args.from === ZERO).sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
    if (mints.length) mint = mints[0];
    if (!mint && head - to > MAX_BACK) { console.error(`no mint within ${MAX_BACK} blocks of the head; pass START_BLOCK=<launch block>`); process.exit(1); }
  }
}
if (!mint) { console.error("mint not found"); process.exit(1); }
const curve = getAddress(mint.args.to);
const launchBlock = mint.blockNumber;
const launchTime = Number((await pub.getBlock({ blockNumber: launchBlock })).timestamp);
console.log(`token ${token}\ncurve ${curve} (the mint's recipient)\nlaunch block ${launchBlock} at ${launchTime} (${new Date(launchTime * 1000).toISOString()})`);

let out = cfg
  .replace(/token:\s*"[^"]*"/, `token: "${token}"`)
  .replace(/curve:\s*"[^"]*"/, `curve: "${curve}"`)
  .replace(/startBlock:\s*\d+/, `startBlock: ${launchBlock}`)
  .replace(/launchTime:\s*\d+/, `launchTime: ${launchTime}`);
// the draw contract is already in config.js (or named in its comment): make sure the live one is set
const drawInComment = /Deployed at (0x[0-9a-fA-F]{40})/.exec(out)?.[1];
if (drawInComment && /draw:\s*""/.test(out)) out = out.replace(/draw:\s*""/, `draw: "${drawInComment}"`);
if (buyUrl) out = out.replace(/buyUrl:\s*"[^"]*"/, `buyUrl: "${buyUrl}"`);
writeFileSync(cfgPath, out);
console.log("config.js updated:", /draw:\s*"([^"]*)"/.exec(out)[1] ? "draw set" : "DRAW STILL EMPTY");

const b = spawnSync(process.execPath, [join(here, "build.mjs")], { stdio: "inherit" });
if (b.status !== 0) process.exit(b.status);

const draw = /draw:\s*"([^"]*)"/.exec(out)[1], splitter = /splitter:\s*"([^"]*)"/.exec(out)[1], pm = /poolManager:\s*"([^"]*)"/.exec(out)[1];
console.log(`
keeper.env (Hetzner):
  DRAW=${draw}
  SPLITTER=${splitter}
  TOKEN=${token}
  CURVE=${curve}
  POOL_MANAGER=${pm}
  START_BLOCK=${launchBlock}
  LAUNCH_TIME=${launchTime}
  EXCLUDE=${curve},${pm},0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952,0x0000000000000000000000000000000000000000,0x000000000000000000000000000000000000dEaD

xbot wrangler vars: DRAW=${draw} TOKEN=${token} SPLITTER=${splitter} CURVE=${curve} START_BLOCK=${launchBlock} LAUNCH_TIME=${launchTime}
`);
