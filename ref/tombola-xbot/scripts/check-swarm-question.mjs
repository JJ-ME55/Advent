// Validates the swarm-check question with IMD's free POST /requests/check. Pays nothing.
//
//   DRAW=0x.. BEACON=0x.. TOKEN=0x.. CURVE=0x.. SPLITTER=0x.. START_BLOCK=<token deploy block> node scripts/check-swarm-question.mjs [--quote]
//
// --quote also sends the full body to POST /requests/quote, which validates every field (definitions,
// guards, quorum) exactly as the paid intake will. It creates an order that simply expires after
// 10 minutes unpaid; nothing is charged.
import { oracleBody, checkInput } from "../src/swarm.js";
import { excludeList, POOL_MANAGER, PONS_LOCKER } from "../src/chain.js";

const env = {
  IMD_API: process.env.IMD_API ?? "https://api.imd.fun",
  IMD_CHAIN_ID: "4663",
  SWARM_PANEL_SIZE: process.env.SWARM_PANEL_SIZE ?? "5",
  SWARM_QUORUM: process.env.SWARM_QUORUM ?? "4",
  PUBLIC_RPC: process.env.PUBLIC_RPC ?? "https://rpc.mainnet.chain.robinhood.com",
  START_BLOCK: process.env.START_BLOCK, // the token's deploy block: where the Transfer replay starts
  EXCLUDE: process.env.EXCLUDE,
};
if (!env.START_BLOCK) {
  // the body refuses START_BLOCK 0 on a mainnet (round-8 finding 6); with no token yet, use the public RPC's head
  const r = await fetch(env.PUBLIC_RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) });
  env.START_BLOCK = String(Number((await r.json()).result));
  console.log(`START_BLOCK unset: using the head of ${env.PUBLIC_RPC}, ${env.START_BLOCK}, as a stand-in deploy block`);
}
const info = {
  draw: process.env.DRAW ?? "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  splitter: process.env.SPLITTER ?? "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9",
  beacon: process.env.BEACON ?? "0x5FbDB2315678afecb367f032d93F642f64180aa3",
  token: process.env.TOKEN ?? "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  curve: process.env.CURVE ?? "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
  poolManager: POOL_MANAGER, locker: PONS_LOCKER,
};
info.exclude = excludeList(env, info);
const body = oracleBody(env, info);
console.log("Full oracle.request body:\n" + JSON.stringify(body, null, 2));
const longest = Math.max(...Object.values(body.definitions).map((v) => v.length));
console.log(`\nquestion ${body.question.length}/2000 chars, longest definition ${longest}/512 chars, body ${JSON.stringify(body).length} bytes`);

const r = await fetch(`${env.IMD_API}/requests/check`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "oracle.request", input: checkInput(body) }),
});
const j = await r.json();
console.log(`\nPOST /requests/check -> ${r.status}`);
console.log(JSON.stringify({ blockers: j.blockers, suggestions: j.suggestions, proposed: j.proposed, judged: j.judged, online: j.online, request: j.request }, null, 2));

if (process.argv.includes("--quote")) {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const q = await fetch(`${env.IMD_API}/requests/quote`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ requestKey: crypto.randomUUID(), action: "oracle.request", input: body }),
  });
  const qj = await q.json();
  console.log(`\nPOST /requests/quote (validation only, never paid) -> ${q.status}`);
  console.log(JSON.stringify(qj.problems ?? qj.error ? qj : { status: qj.order?.status, action: qj.order?.quote?.action, expiresAt: qj.order?.quote?.expiresAt, onchain: !!qj.order?.onchain }, null, 2));
}
process.exitCode = j.blockers?.length ? 1 : 0;
