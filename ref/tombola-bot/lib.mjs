// Shared helpers for the keeper, verify-drop and the launch kit (launch/bind.mjs, launch/make-token.mjs).
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { scryptSync, pbkdf2Sync, createDecipheriv } from "node:crypto";
import { createPublicClient, createWalletClient, http, fallback, defineChain, parseAbi, parseAbiItem, toFunctionSelector, keccak256, encodeAbiParameters, getContractAddress, pad, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "contracts", "out");

export function abi(name) {
  return JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), "utf8")).abi;
}

export const vaultAbi = abi("DropVault");
export const beaconAbi = abi("DrandBeacon");
export const tokenAbi = JSON.parse(readFileSync(join(out, "IDropToken.sol", "IDropToken.json"), "utf8")).abi;

export function env(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing environment variable ${name}`);
  return v;
}

/// [A7-14a] A numeric environment variable, validated: a typo (WAIT_SECONDS=30m) throws instead of becoming NaN.
export function numEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER, integer = true, environment = process.env } = {}) {
  const raw = environment[name];
  const text = String(raw === undefined || raw === "" ? fallback : raw).trim();
  const n = Number(text);
  const shape = integer ? /^-?[0-9]+$/ : /^-?[0-9]+(\.[0-9]+)?$/;
  if (!shape.test(text) || !Number.isFinite(n) || n < min || n > max) {
    throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

// ------------------------------------------------------------------ keys [A7-13]
// A key never goes on a command line. Each script takes, for a role PREFIX (KEEPER, PAYER, DEPLOYER), exactly one of:
//   PREFIX_ACCOUNT    a Foundry keystore (`cast wallet import <name> --interactive`): a name in ~/.foundry/keystores,
//                     or a path. Its password is asked for on the terminal, or read from PREFIX_PASSWORD_FILE
//   PREFIX_KEY_FILE   a file holding the hex private key (keep it outside the repo, readable only by you)
//   PREFIX_KEY        the key itself, in the environment (local tests; never typed inline on a command line)

/// Decrypts a Web3 Secret Storage v3 keystore (what `cast wallet import` writes) and returns the 0x-prefixed key.
export function decryptKeystore(json, password) {
  let ks = json;
  if (typeof json === "string") {
    // [A8-10b] JSON.parse quotes its input in the error, so a raw key named as a keystore would print part of itself
    try {
      ks = JSON.parse(json);
    } catch {
      throw new Error("isn't a keystore JSON file (a raw hex key goes in the _KEY_FILE variable, not _ACCOUNT)");
    }
  }
  if (!ks || typeof ks !== "object") throw new Error("isn't a keystore JSON file (a raw hex key goes in the _KEY_FILE variable, not _ACCOUNT)");
  const c = ks.crypto ?? ks.Crypto;
  if (!c || Number(ks.version) !== 3) throw new Error("not a version 3 keystore");
  const kp = c.kdfparams;
  const pw = Buffer.from(password, "utf8");
  const salt = Buffer.from(kp.salt, "hex");
  let dk;
  if (c.kdf === "scrypt") dk = scryptSync(pw, salt, kp.dklen, { N: kp.n, r: kp.r, p: kp.p, maxmem: 256 * kp.n * kp.r + (1 << 24) });
  else if (c.kdf === "pbkdf2") {
    if (kp.prf !== "hmac-sha256") throw new Error(`unsupported pbkdf2 prf ${kp.prf}`);
    dk = pbkdf2Sync(pw, salt, kp.c, kp.dklen, "sha256");
  } else throw new Error(`unsupported kdf ${c.kdf}`);
  const ct = Buffer.from(c.ciphertext, "hex");
  const mac = keccak256(`0x${Buffer.concat([dk.subarray(16, 32), ct]).toString("hex")}`).slice(2);
  if (mac !== String(c.mac).toLowerCase()) throw new Error("wrong keystore password (MAC mismatch)");
  if (c.cipher !== "aes-128-ctr") throw new Error(`unsupported cipher ${c.cipher}`);
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"));
  return `0x${Buffer.concat([d.update(ct), d.final()]).toString("hex")}`;
}

/// Reads a line from the terminal without echoing it.
export async function promptHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error("no terminal to ask for the keystore password on (under Git Bash, run through winpty, or set the _PASSWORD_FILE variable)");
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let s = "";
    const done = (fn, v) => {
      stdin.off("data", on);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      fn(v);
    };
    const on = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(resolve, s);
        if (ch === "\u0003") return done(reject, new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") s = s.slice(0, -1);
        else s += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", on);
  });
}

const HEX_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

/// The private key for a role, from PREFIX_ACCOUNT, PREFIX_KEY_FILE or PREFIX_KEY (see above); undefined if none is set.
export async function loadKey(prefix, { environment = process.env, prompt = promptHidden, keystoreDir = join(homedir(), ".foundry", "keystores") } = {}) {
  const set = ["ACCOUNT", "KEY_FILE", "KEY"].filter((s) => environment[`${prefix}_${s}`]);
  if (set.length > 1) throw new Error(`set only one of ${set.map((s) => `${prefix}_${s}`).join(", ")}`);
  if (!set.length) return undefined;
  const v = environment[`${prefix}_${set[0]}`];
  let key;
  if (set[0] === "ACCOUNT") {
    const path = isAbsolute(v) || v.includes("/") || v.includes("\\") ? v : join(keystoreDir, v);
    if (!existsSync(path)) throw new Error(`${prefix}_ACCOUNT: no keystore at ${path} (create it with: cast wallet import ${v} --interactive)`);
    let ks;
    try {
      ks = JSON.parse(readFileSync(path, "utf8")); // parsed before any password is asked for
    } catch {
      throw new Error(`${prefix}_ACCOUNT ${v} isn't a keystore JSON file (a raw hex key goes in ${prefix}_KEY_FILE)`);
    }
    const pwFile = environment[`${prefix}_PASSWORD_FILE`];
    const password = pwFile ? readFileSync(pwFile, "utf8").replace(/\r?\n$/, "") : await prompt(`password for keystore ${v} (${prefix}): `);
    try {
      key = decryptKeystore(ks, password);
    } catch (e) {
      throw new Error(`${prefix}_ACCOUNT ${v}: ${e.message}`);
    }
  } else if (set[0] === "KEY_FILE") {
    key = readFileSync(v, "utf8").trim();
    if (!HEX_KEY.test(key)) throw new Error(`${prefix}_KEY_FILE ${v} doesn't hold a 32-byte hex key`);
  } else {
    key = v.trim();
    if (!HEX_KEY.test(key)) throw new Error(`${prefix}_KEY isn't a 32-byte hex key`);
  }
  return key.startsWith("0x") ? key : `0x${key}`;
}

/// A viem account for a role (see loadKey), or undefined.
export async function loadAccount(prefix, opts) {
  const key = await loadKey(prefix, opts);
  return key ? privateKeyToAccount(key) : undefined;
}

export async function clients({ needWallet = false } = {}) {
  // RPC_URL may list several endpoints, comma-separated: the first is used until it fails, then the next (viem's
  // fallback transport, which ranks them back by health), so a public node's blip never delays a draw
  const rpcs = env("RPC_URL", "https://rpc.mainnet.chain.robinhood.com").split(",").map((u) => u.trim()).filter(Boolean);
  const rpc = rpcs[0];
  const transport = () => (rpcs.length > 1 ? fallback(rpcs.map((u) => http(u, { timeout: 15_000, retryCount: 1 })), { rank: false }) : http(rpc));
  const probe = createPublicClient({ transport: transport() });
  const id = await probe.getChainId();
  const chain = defineChain({
    id,
    name: id === 4663 ? "Robinhood Chain" : `chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: rpcs } },
    contracts: id === 4663 ? { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } : {},
  });
  const pub = createPublicClient({ chain, transport: transport() });
  if (!needWallet) return { pub, chain };
  // [A7-13] KEEPER_ACCOUNT (a Foundry keystore), KEEPER_KEY_FILE or KEEPER_KEY. Never commit a key.
  const account = await loadAccount("KEEPER");
  if (!account) throw new Error("Set KEEPER_ACCOUNT (a Foundry keystore name) or KEEPER_KEY_FILE (a key file) for the keeper wallet");
  const wallet = createWalletClient({ chain, transport: transport(), account });
  return { pub, wallet, account, chain };
}

// drand evmnet. drand's own relays serve the v2 beacon path; Cloudflare's relay serves only the v1 path,
// keyed by evmnet's chain hash. Every relay returns the same signature for a round.
const EVMNET_HASH = "04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3";
export const DRAND_URLS = [
  (round) => `https://api.drand.sh/v2/beacons/evmnet/rounds/${round}`,
  (round) => `https://api2.drand.sh/v2/beacons/evmnet/rounds/${round}`,
  (round) => `https://api3.drand.sh/v2/beacons/evmnet/rounds/${round}`,
  (round) => `https://drand.cloudflare.com/${EVMNET_HASH}/public/${round}`,
];
export const FETCH_TIMEOUT_MS = 10_000;

/// Fetches a drand evmnet round's signature, trying each relay with a 10-second timeout.
/// Returns null if a relay answered that the round isn't published yet, and throws if no relay answered at all.
export async function drandSignature(round, { urls = DRAND_URLS, fetchFn = fetch } = {}) {
  let answered = false;
  const errors = [];
  for (const url of urls) {
    try {
      const r = await fetchFn(url(round), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!r.ok) {
        // 404 and 425 mean "not published yet"; anything else is the relay failing, so try the next one
        if (r.status === 404 || r.status === 425) answered = true;
        else errors.push(`${url(round)}: HTTP ${r.status}`);
        continue;
      }
      const j = await r.json();
      // [A9-11] a relay answering for another round (stale cache, misrouted request) is a failing relay, not an answer
      if (j.round !== undefined && j.round !== null && String(j.round) !== String(round)) {
        errors.push(`${url(round)}: answered for round ${j.round}, not ${round}`);
        continue;
      }
      if (j.signature) return `0x${j.signature}`;
      answered = true;
    } catch (e) {
      errors.push(`${url(round)}: ${e.name === "TimeoutError" ? "timed out" : e.message}`);
    }
  }
  if (answered) return null;
  throw new Error(`no drand relay answered for round ${round}: ${errors.join("; ")}`);
}

/// [A6-17] The three answers the keeper acts on: "signed" (reveal), "unpublished" (a relay answered that the round
/// isn't out: abandon may be tried) and "outage" (no relay answered: wait, and never abandon).
export async function drandRound(round, opts) {
  try {
    const sig = await drandSignature(round, opts);
    return sig ? { status: "signed", sig } : { status: "unpublished", sig: null };
  } catch (e) {
    return { status: "outage", sig: null, error: e.message };
  }
}

/// [A8-8] What the keeper sends to reveal a drop whose drand round is `round`:
///   - the beacon already holds the round's randomness (someone proved it): "proven", sig "0x". After [A7-3] the vault
///     checks any non-empty calldata against the proven value, so a relay's wrong answer would revert every tick.
///   - otherwise each relay in turn: the first signature beacon.isValid accepts is "signed". A relay serving a wrong
///     signature is skipped (logged in `rejected`) and the next one is asked.
///   - no valid signature: "unpublished" if a relay answered that the round isn't out (abandon may be tried),
///     "invalid" if relays answered only with signatures the beacon refuses (never abandon: the round exists), and
///     "outage" if no relay answered at all.
export async function revealPlan(round, { randomness, isValid, urls = DRAND_URLS, fetchFn = fetch } = {}) {
  const stored = await randomness(round);
  if (stored && BigInt(stored) !== 0n) return { status: "proven", sig: "0x", rejected: [] };
  const rejected = [];
  let answered = false;
  const errors = [];
  for (const url of urls) {
    let sig;
    try {
      sig = await drandSignature(round, { urls: [url], fetchFn });
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    if (sig === null) {
      answered = true;
      continue;
    }
    let ok = false;
    try {
      ok = await isValid(round, sig);
    } catch (e) {
      errors.push(`isValid: ${e.shortMessage ?? e.message}`);
      continue;
    }
    if (ok) return { status: "signed", sig, rejected };
    rejected.push(url(round));
  }
  if (rejected.length) return { status: "invalid", sig: null, rejected, error: `the beacon refused the signature from ${rejected.join(", ")}` };
  if (answered) return { status: "unpublished", sig: null, rejected };
  return { status: "outage", sig: null, rejected, error: errors.join("; ") };
}

/// [A9-11] verify-drop's randomness check. Asks every relay in turn (one wrong relay never decides it):
///   - "pass": a relay's signature passes beacon.isValid and keccak256(sig) is the stored randomness
///   - "fail": a relay's signature passes beacon.isValid (so it is drand's) but hashes to something other than the
///     stored randomness: real evidence against the draw. Checked before any later relay is asked.
///   - "unknown": no relay gave a signature isValid accepts (all rejected, unpublished, or unreachable, or isValid
///     itself failed): couldn't check, never FAIL. `rejected` lists the relays whose signature isValid refused.
/// isValid(round, sig) and the stored value come from the caller's RPC.
export async function checkDrandRandomness(round, { stored, isValid, urls = DRAND_URLS, fetchFn = fetch } = {}) {
  const rejected = [];
  const errors = [];
  let unpublished = 0;
  for (const url of urls) {
    let sig;
    try {
      sig = await drandSignature(round, { urls: [url], fetchFn });
    } catch (e) {
      errors.push(e.message);
      continue;
    }
    if (sig === null) {
      unpublished++;
      continue;
    }
    let ok;
    try {
      ok = await isValid(round, sig);
    } catch (e) {
      errors.push(`beacon.isValid on ${url(round)}'s signature failed: ${e.shortMessage ?? e.message}`);
      continue;
    }
    if (!ok) {
      rejected.push(url(round));
      continue;
    }
    if (BigInt(keccak256(sig)) === BigInt(stored)) return { status: "pass", sig, from: url(round), rejected, errors };
    return { status: "fail", sig, from: url(round), rejected, errors, reason: `drand's signature for round ${round} from ${url(round)} passes beacon.isValid but hashes to ${keccak256(sig)}, not the stored randomness ${stored}` };
  }
  let reason;
  if (rejected.length) reason = `this RPC's beacon rejects every drand relay's signature for round ${round} (${rejected.join(", ")})${errors.length ? `; ${errors.join("; ")}` : ""}`;
  else if (unpublished && !errors.length) reason = `drand's relays don't have round ${round}`;
  else reason = `no drand relay gave a signature for round ${round} that could be checked: ${errors.join("; ") || "none answered"}`;
  return { status: "unknown", sig: null, rejected, errors, reason };
}

// ------------------------------------------------------------------ IMD's ProjectFactory
// Selectors checked against the live Robinhood factory 0x9C9D2FCB...265e (its dispatcher and `cast call`s on launch
// 1799): positionOf returns the pool key, the factory's position range and the current requester.
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const factoryAbi = parseAbi([
  "function claimFees(uint64 launchNumber)",
  "function setRequester(uint64 launchNumber, address next)",
  "function poolHook() view returns (address)",
  "function distributorOf(uint64 launchNumber) view returns (address)",
  "function positionOf(uint64 launchNumber) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks, int24 tickLower, int24 tickUpper, address requester)",
]);
const FACTORY_SELECTORS = {
  claimFees: "0xe0d0eac4",
  setRequester: "0x4a5706c7",
  poolHook: "0x3545c789",
  distributorOf: "0x6c637492",
  positionOf: "0xfb2c8e23",
};
for (const f of factoryAbi) {
  if (toFunctionSelector(f) !== FACTORY_SELECTORS[f.name]) throw new Error(`factory ABI: ${f.name} selector mismatch`);
}
// IMD's current ProjectFactory per chain id (IMD's contracts table; re-check before each launch)
export const IMD_FACTORIES = {
  4663: "0x9C9D2FCB75c2C132C0AC0C42DF3819A42347265e",
  11155111: "0x84cf2bc1dc2af577dba5d62e26f90d041ca38f7a",
};

export const sameAddr = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/// positionOf's tuple as an object (viem returns it as an array).
export function positionObject(p) {
  if (!Array.isArray(p)) return p;
  const [currency0, currency1, fee, tickSpacing, hooks, tickLower, tickUpper, requester] = p;
  return { currency0, currency1, fee, tickSpacing, hooks, tickLower, tickUpper, requester };
}

/// [A6-4][A6-7] Checks IMD's own record of a launch against what the vault and token say. Returns a list of problems
/// (empty when it all matches) and whether the factory pays the launcher fee to the vault.
///   pos           factory.positionOf(launchNumber)
///   poolHook      factory.poolHook()
///   token         the token the vault is (or will be) bound to
///   tokenFactory  token.FACTORY()
///   vaultFactory  vault.factory(), or undefined for a vault build without it
export function launchProblems({ factory, vault, launchNumber, pos, poolHook, token, tokenFactory, vaultFactory }) {
  pos = positionObject(pos);
  const problems = [];
  if (sameAddr(pos.currency1, ZERO_ADDRESS) && sameAddr(pos.hooks, ZERO_ADDRESS)) {
    problems.push(`factory ${factory} has no launch ${launchNumber} (positionOf is empty)`);
    return { problems, requesterIsVault: false, requester: pos.requester };
  }
  if (!sameAddr(pos.currency0, ZERO_ADDRESS)) problems.push(`launch ${launchNumber} pairs ${pos.currency0}, not ETH`);
  if (!sameAddr(pos.currency1, token)) problems.push(`launch ${launchNumber}'s token is ${pos.currency1}, not ${token}`);
  if (!sameAddr(pos.hooks, poolHook)) problems.push(`launch ${launchNumber}'s hook ${pos.hooks} isn't the factory's poolHook() ${poolHook}`);
  if (tokenFactory !== undefined && !sameAddr(tokenFactory, factory)) problems.push(`token.FACTORY() is ${tokenFactory}, not ${factory}`);
  if (vaultFactory !== undefined && !sameAddr(vaultFactory, factory)) problems.push(`vault.factory() is ${vaultFactory}, not ${factory}`);
  return { problems, requesterIsVault: sameAddr(pos.requester, vault), requester: pos.requester };
}

/// [A7-6] Compares vault.poolKey() with factory.positionOf(launchNumber). A bound vault's key must be the launch's
/// pool key and name the vault's token; an unbound vault's key must still be empty.
export function poolKeyProblems(key, pos, { bound, vaultToken, launchNumber }) {
  pos = positionObject(pos);
  const k = Array.isArray(key) ? { currency0: key[0], currency1: key[1], fee: key[2], tickSpacing: key[3], hooks: key[4] } : key;
  const out = [];
  if (!bound) {
    if (!sameAddr(k.currency1, ZERO_ADDRESS) || !sameAddr(k.hooks, ZERO_ADDRESS) || Number(k.fee) !== 0 || Number(k.tickSpacing) !== 0) {
      out.push(`vault.poolKey() is already set (${k.currency1}) although vault.token() is unset`);
    }
    return out;
  }
  const same =
    sameAddr(k.currency0, pos.currency0) &&
    sameAddr(k.currency1, pos.currency1) &&
    Number(k.fee) === Number(pos.fee) &&
    Number(k.tickSpacing) === Number(pos.tickSpacing) &&
    sameAddr(k.hooks, pos.hooks);
  if (!same) out.push(`vault.poolKey() (${k.currency0}, ${k.currency1}, ${k.fee}, ${k.tickSpacing}, ${k.hooks}) isn't factory.positionOf(${launchNumber})'s pool (${pos.currency0}, ${pos.currency1}, ${pos.fee}, ${pos.tickSpacing}, ${pos.hooks})`);
  if (!sameAddr(k.currency1, vaultToken)) out.push(`vault.poolKey()'s token ${k.currency1} isn't vault.token() ${vaultToken}`);
  return out;
}

// ------------------------------------------------------------------ IMD's published contracts [A7-10]
// IMD publishes its contract table in its docs ("Contract addresses", one section per chain). There is no API route
// that lists contracts (api.imd.fun/contracts is a 404; /launch/policies names the factories only abbreviated).
export const IMD_CONTRACTS_URL = "https://imd.fun/docs/llms.txt";
const DOC_CHAINS = { "Ethereum mainnet": 1, "Robinhood Chain": 4663, Sepolia: 11155111 };

/// Parses the docs' "Contract addresses" tables into { chainId: { ContractName: address } }.
export function parsePublishedContracts(text) {
  const start = text.search(/^## Contract addresses\s*$/m);
  if (start < 0) throw new Error("no 'Contract addresses' section in IMD's docs");
  const rest = text.slice(start);
  const end = rest.slice(3).search(/^## /m);
  const body = end < 0 ? rest : rest.slice(0, end + 3);
  const out = {};
  for (const sec of body.split(/^### /m).slice(1)) {
    const heading = sec.split(/\r?\n/, 1)[0].trim();
    const chainId = DOC_CHAINS[heading];
    if (!chainId) continue;
    const rows = {};
    for (const m of sec.matchAll(/^\|\s*([^|`]+?)\s*\|\s*`(0x[0-9a-fA-F]{40})`/gm)) rows[m[1]] = m[2];
    out[chainId] = rows;
  }
  return out;
}

/// IMD's currently published ProjectFactory and pool hook for a chain, fetched from its docs.
export async function publishedFactory(chainId, { url = IMD_CONTRACTS_URL, fetchFn = fetch } = {}) {
  const r = await fetchFn(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const table = parsePublishedContracts(await r.text())[Number(chainId)];
  if (!table?.ProjectFactory) throw new Error(`${url} lists no ProjectFactory for chain ${chainId}`);
  return { factory: table.ProjectFactory, hook: table.PoolInitializationGuard, url };
}

/// [A7-10] The vault pins its factory for good. Refuses unless it is IMD's current one: the published one when the
/// docs answered, else the kit's default for the chain.
export function factoryProblems({ vaultFactory, published, kitDefault, chainId }) {
  const out = [];
  const current = published?.factory ?? kitDefault;
  const source = published ? `IMD's published ProjectFactory (${published.url})` : `the kit's default ProjectFactory for chain ${chainId} (IMD's docs didn't answer)`;
  if (!current) out.push(`no current IMD ProjectFactory known for chain ${chainId}`);
  else if (!sameAddr(vaultFactory, current)) {
    out.push(`vault.factory() is ${vaultFactory}, but ${source} is ${current}. A launch through the new factory can never bind to this vault and its 12% would be stuck there: redeploy the vault with the current factory`);
  }
  if (published && kitDefault && !sameAddr(published.factory, kitDefault)) {
    out.push(`IMD now publishes ProjectFactory ${published.factory} for chain ${chainId}, not the kit's ${kitDefault}: IMD has rotated its factory. Update bot/lib.mjs IMD_FACTORIES, make-token.mjs CHAINS and the README, and redeploy the vault`);
  }
  return out;
}

/// [A7-10] The opening market cap against IMD's live launch terms (GET /requests/capabilities): the ETH pairing's
/// customCap {min, max} for custom_token on the chain. The pool opens at exactly this cap.
export function capProblems(capabilities, chainId, capWei) {
  const chain = capabilities?.launches?.chains?.find((c) => Number(c.chainId) === Number(chainId));
  if (!chain) return [`IMD's capabilities list no launches on chain ${chainId}`];
  if (!(chain.kinds ?? []).includes("custom_token")) return [`IMD doesn't take custom_token launches on chain ${chainId} now`];
  const eth = (chain.pairings ?? []).find((p) => p.pairWith === "eth" && (p.kinds ?? []).includes("custom_token"));
  if (!eth?.customCap) return [`IMD lists no ETH pairing with a custom cap for custom_token on chain ${chainId}`];
  const c = BigInt(capWei);
  if (c < BigInt(eth.customCap.min) || c > BigInt(eth.customCap.max)) return [`MARKET_CAP_WEI ${capWei} is outside IMD's custom cap range ${eth.customCap.min}..${eth.customCap.max} for chain ${chainId}`];
  return [];
}

/// [A7-10] Reads a POST /requests/check answer for what IMD will open the pool at. The plan and facts are plain
/// words, so this looks for an opening tick ("tick 184216") or an opening market cap in wei, and reports any that
/// disagrees with the vault by more than one spacing. Returns { problems, found }.
export function planOpeningProblems(check, { openingTick, tickSpacing = 60, capWei }) {
  const text = JSON.stringify([check?.plan ?? [], check?.facts ?? []]);
  const problems = [];
  const found = [];
  for (const m of text.matchAll(/(?:initial|opening|starting)[^"]{0,40}?tick[^0-9-"]{0,12}(-?[0-9]{4,6})/gi)) {
    const t = Number(m[1]);
    found.push(`tick ${t}`);
    if (Math.abs(t - Number(openingTick)) > Number(tickSpacing)) problems.push(`IMD's plan opens the pool at tick ${t}, but vault.openingTick() is ${openingTick}`);
  }
  for (const m of text.matchAll(/initialMarketCapWei\W{0,8}([0-9]{6,})/g)) {
    found.push(`cap ${m[1]} wei`);
    const t = tickForMarketCap(BigInt(m[1]));
    if (Math.abs(t - Number(openingTick)) > Number(tickSpacing)) problems.push(`IMD's plan opens at a ${m[1]} wei cap (tick ${t}), but vault.openingTick() is ${openingTick}`);
    else if (capWei !== undefined && BigInt(m[1]) !== BigInt(capWei)) problems.push(`IMD's plan opens at a ${m[1]} wei cap, not MARKET_CAP_WEI ${capWei}`);
  }
  return { problems, found };
}

/// [A10-10] What a POST /requests/check (or quote) answer says the launch pairs with. bindToken needs native ETH as
/// currency0 and reverts BadToken otherwise, which would strand the vault after payment. Looks in the plan and facts
/// (plain words, or structured fields such as pairWith / currency0 / quote) for a pairing. Returns
/// { pairing: "eth" | <other> | undefined, problems, found }: a problem for any pairing that isn't ETH; pairing
/// undefined when nothing names one (the paid quote must then be checked by hand).
export function planPairingProblems(check) {
  const parts = [check?.plan ?? [], check?.facts ?? []];
  for (const k of ["pairWith", "pairing", "pair", "quote", "pool", "economics"]) if (check?.[k] !== undefined) parts.push({ [k]: check[k] });
  const text = JSON.stringify(parts);
  const found = [];
  const ETHISH = /^(eth|ether|native(?: eth)?|0x0{40})$/i;
  for (const m of text.matchAll(/"(?:pairWith|pairing|pair|quoteCurrency|currency0)"\s*:\s*"([^"]{1,60})"/gi)) found.push(m[1].trim());
  for (const m of text.matchAll(/\bpair(?:s|ed|ing)?(?:\s+(?:it|the token|token))?\s+(?:with|against|to)\s+(?:the\s+)?(native\s+eth|[$]?[A-Za-z][A-Za-z0-9]{1,10})\b/gi)) found.push(m[1].replace(/^\$/, "").trim());
  for (const m of text.matchAll(/\b([$]?[A-Za-z][A-Za-z0-9]{1,10})\s*\/\s*[$]?[A-Za-z][A-Za-z0-9]{1,10}\s+pool\b/g)) found.push(m[1].replace(/^\$/, ""));
  const problems = [];
  let pairing;
  for (const f of found) {
    if (ETHISH.test(f)) pairing ??= "eth";
    else {
      pairing = f;
      problems.push(`IMD's answer pairs the launch with ${f}, not native ETH: bindToken needs currency0 = ETH and would revert BadToken, stranding the vault. Don't pay`);
    }
  }
  return { pairing, problems, found };
}

// ------------------------------------------------------------------ bind price and opening tick [A7-1][A7-10]
/// The pool tick at which the whole supply (1e27) is worth `capWei` of ETH (currency0 = ETH, currency1 = the
/// token, both 18 decimals): price = tokens per ETH = supply / cap, tick = floor(log_1.0001(price)).
export function tickForMarketCap(capWei, supply = 10n ** 27n) {
  const ln = (x) => {
    // natural log of a bigint, exact enough for a tick (relative error far below 1e-4)
    const s = BigInt(x).toString();
    const head = Number(s.slice(0, 16)) / 10 ** (Math.min(16, s.length) - 1);
    return Math.log(head) + (s.length - 1) * Math.LN10;
  };
  return Math.floor((ln(supply) - ln(capWei)) / Math.log(1.0001));
}

/// [A8-4] The largest pump (ticks below the vault's opening tick) bind.mjs accepts without MAX_PUMP_TICKS being raised.
/// At IMD's launch size (10 ETH opening cap, spacing 60) an honest 1 ETH of buys moves the tick about 2,381
/// (R8PumpBind's control run), so 3,000 ticks (the token at about x1.35 the opening price) lets roughly the first
/// 1.25 ETH of launch buys through. Anything above it is a decision: check the chart, then set MAX_PUMP_TICKS.
export const DEFAULT_MAX_PUMP_TICKS = 3000;

/// [A7-1][A8-4] The bind's price check, one-sided. A higher tick is a cheaper token (more tokens per ETH).
///   - a tick above openingTick + one spacing is in IMD's empty range above its position: any holder can put the spot
///     there with a dust sell for free. Refused with no override; a small buy moves the price back into the range.
///   - a tick more than maxPump below openingTick is a pumped price: the prize bands follow it for good. Refused; the
///     only way past it is a larger MAX_PUMP_TICKS, a tick limit chosen deliberately (no boolean accepts any pump).
export function priceCheck(tick, openingTick, tickSpacing, { maxPump = DEFAULT_MAX_PUMP_TICKS } = {}) {
  const t = Number(tick);
  const o = Number(openingTick);
  const s = Number(tickSpacing);
  const priceRatio = Math.pow(1.0001, o - t); // token price now / at opening
  if (t > o + s) {
    return {
      ok: false,
      kind: "empty",
      moved: t - o,
      priceRatio,
      reason: `the pool tick ${t} is ${t - o} ticks above the opening tick ${o} (a cheaper token than the opening price): the spot is in IMD's empty range above its position, where a free dust sell can put it anywhere. There is no override. Send a small buy (any size moves the price back into IMD's range), then re-run`,
    };
  }
  if (o - t > maxPump) {
    return {
      ok: false,
      kind: "pump",
      moved: o - t,
      priceRatio,
      reason: `the token price is x${priceRatio.toFixed(3)} the opening price (tick ${t}, ${o - t} ticks below the opening tick ${o}, limit MAX_PUMP_TICKS=${maxPump}): the prize bands and the first tax order would follow this price for good`,
    };
  }
  return { ok: true, kind: o - t > s ? "dearer" : "near", moved: Math.abs(o - t), priceRatio, reason: "" };
}

/// [A9-4] The drift tolerance, in tick spacings, between bind.mjs's price reads and for minTick: 4 spacings (240 ticks
/// at IMD's spacing 60, about 2.4%). One spacing (round 8) refused runs on ordinary launch buying of 0.03-0.04 ETH
/// (round 9 finding 4). A pump is still capped by MAX_PUMP_TICKS on every read and by minTick at inclusion.
export const DEFAULT_DRIFT_SPACINGS = 4;
export const MIN_DRIFT_SPACINGS = 1;
export const MAX_DRIFT_SPACINGS = 5;

/// [A9-4] The drift limit in ticks: MAX_DRIFT_TICKS if set (it must be 1-5 spacings), else 4 spacings. Throws on a
/// value outside that range, so a typo can't switch the guard off.
export function driftLimit(tickSpacing, raw) {
  const s = Number(tickSpacing);
  if (raw === undefined || raw === "") return DEFAULT_DRIFT_SPACINGS * s;
  const text = String(raw).trim();
  const n = Number(text);
  if (!/^[0-9]+$/.test(text) || n < MIN_DRIFT_SPACINGS * s || n > MAX_DRIFT_SPACINGS * s) {
    throw new Error(`MAX_DRIFT_TICKS must be a whole number of ticks from ${MIN_DRIFT_SPACINGS * s} to ${MAX_DRIFT_SPACINGS * s} (${MIN_DRIFT_SPACINGS}-${MAX_DRIFT_SPACINGS} tick spacings of ${s}), got ${JSON.stringify(raw)}`);
  }
  return n;
}

/// [A8-4][A9-4] Compares the slot0 reads of one bind attempt (in order). A later read more than `maxDrift` ticks
/// dearer (a lower tick) than the first means the price was pushed between the reads: refuse (bind.mjs retries with a
/// fresh baseline, each read still bounded by MAX_PUMP_TICKS). A cheaper later read is fine (the empty-range side is
/// checked on each read by priceCheck). `maxDrift` defaults to DEFAULT_DRIFT_SPACINGS spacings.
export function priceDriftProblems(ticks, tickSpacing, { maxDrift = DEFAULT_DRIFT_SPACINGS * Number(tickSpacing) } = {}) {
  if (!ticks.length) return [];
  const first = Number(ticks[0]);
  const out = [];
  ticks.forEach((t, i) => {
    if (i > 0 && Number(t) < first - maxDrift) out.push(`read ${i + 1} found tick ${t}, ${first - Number(t)} ticks dearer than the first read's ${first} (limit MAX_DRIFT_TICKS=${maxDrift}): the price was pushed during the bind`);
  });
  return out;
}

/// [A8-4][A9-4] The minTick bindToken(token, launchNumber, minTick) gets: max(openingTick - maxPump, lastTick -
/// maxDrift). A pump landing after the last read that takes the tick below it reverts the bind (PriceMoved) instead of
/// fixing the bands at the pumped price, and minTick never accepts more than MAX_PUMP_TICKS below the opening tick.
/// Without openingTick/maxPump it is lastTick - maxDrift.
export function bindMinTick(lastTick, tickSpacing, { openingTick, maxPump, maxDrift = DEFAULT_DRIFT_SPACINGS * Number(tickSpacing) } = {}) {
  let m = Number(lastTick) - Number(maxDrift);
  if (openingTick !== undefined && maxPump !== undefined) m = Math.max(m, Number(openingTick) - Number(maxPump));
  return m < -887272 ? -887272 : m;
}

/// [A9-4] Whether a bind attempt's failure is worth another attempt: a drift refusal or the vault's PriceMoved revert
/// (from the simulation, the gas estimate or a mined bind). Anything else is a real refusal.
export function priceRetryable(e) {
  const text = [e?.name, e?.shortMessage, e?.message, e?.cause?.shortMessage, e?.cause?.data?.errorName, e?.data?.errorName].filter(Boolean).join(" ");
  return e?.retryable === true || /PriceMoved/.test(text);
}

/// [A7-10] The vault's openingTick against the tick IMD initialized the pool at. `initTick` from the pool's Initialize
/// event when it was found; otherwise IMD's token-only position, whose top is the initial tick rounded down to a
/// spacing (launch 1799: initialized at 184216, position top 184200).
export function openingProblems({ openingTick, initTick, tickUpper, tickSpacing }) {
  const o = Number(openingTick);
  const s = Number(tickSpacing);
  if (initTick !== undefined && initTick !== null) {
    const d = Math.abs(o - Number(initTick));
    return d > s ? [`vault.openingTick() ${o} is ${d} ticks from the tick IMD initialized the pool at, ${initTick} (more than one spacing, ${s}): the vault's clamp and prize bands assume the opening price`] : [];
  }
  const u = Number(tickUpper);
  return o < u - s || o >= u + 2 * s ? [`vault.openingTick() ${o} doesn't fit IMD's position top ${u} (the initial tick rounded down to the spacing ${s}): IMD opened at a different price than the vault was deployed for`] : [];
}

/// The first block whose timestamp is >= `t`, by binary search over [lo, hi]. `timestampOf(n)` reads block n.
export async function blockAtTime(timestampOf, t, lo, hi) {
  t = BigInt(t);
  lo = BigInt(lo);
  hi = BigInt(hi);
  if ((await timestampOf(hi)) < t) return hi + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if ((await timestampOf(mid)) < t) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

export const INITIALIZE_EVENT = parseAbiItem("event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)");

/// The tick the pool was initialized at, from the PoolManager's Initialize log around `launchTime` (IMD deploys the
/// token and initializes its pool in one transaction). Undefined if no log was found.
export async function initializeTick(pub, poolManager, key, launchTime, { slack = 60n } = {}) {
  const head = await pub.getBlockNumber();
  const ts = async (n) => (await pub.getBlock({ blockNumber: n })).timestamp;
  const from = await blockAtTime(ts, BigInt(launchTime) - slack, 0n, head);
  let to = await blockAtTime(ts, BigInt(launchTime) + slack + 1n, from, head);
  if (to > head) to = head;
  const logs = await getLogsChunked((fromBlock, toBlock) => pub.getLogs({ address: poolManager, event: INITIALIZE_EVENT, args: { id: poolId(key) }, fromBlock, toBlock }), from, to, { chunk: 100_000n });
  return logs.length ? Number(logs[0].args.tick) : undefined;
}

// ------------------------------------------------------------------ vault code check [A7-14b]
/// keccak256 of a runtime code with its immutables zeroed (the build artifact has zeros there). Two vaults of one
/// build hash the same whatever their constructor arguments; an older build with the same ABI doesn't.
export function maskedCodeHash(code, immutableReferences = {}) {
  const hex = code.toLowerCase().replace(/^0x/, "").split("");
  for (const refs of Object.values(immutableReferences)) {
    for (const { start, length } of refs) for (let i = start * 2; i < (start + length) * 2 && i < hex.length; i++) hex[i] = "0";
  }
  return keccak256(`0x${hex.join("")}`);
}

/// Compares a deployed runtime code with a Foundry artifact's deployedBytecode, immutables masked.
export function codeMatchesBuild(artifact, code) {
  const d = artifact.deployedBytecode;
  if (!d?.object || d.object === "0x") return { ok: false, reason: "the build artifact has no deployedBytecode" };
  if (Object.keys(d.linkReferences ?? {}).length) return { ok: false, reason: "the build links libraries, which this check doesn't handle" };
  const refs = d.immutableReferences ?? {};
  const built = maskedCodeHash(d.object, refs);
  const deployed = maskedCodeHash(code, refs);
  const lenB = (d.object.length - 2) / 2;
  const lenD = (code.length - 2) / 2;
  if (built === deployed) return { ok: true, built, deployed };
  return { ok: false, built, deployed, reason: lenB !== lenD ? `its code is ${lenD} bytes, the build's ${lenB}` : `its code hash (immutables masked) is ${deployed}, the build's ${built}` };
}

// ------------------------------------------------------------------ token code check [A8-1]
/// The values a deployed runtime holds at each of the build's immutable references: { astId: ["0x<64 hex>", ...] }.
export function immutableValues(artifact, code) {
  const hex = code.toLowerCase().replace(/^0x/, "");
  const out = {};
  for (const [id, refs] of Object.entries(artifact.deployedBytecode?.immutableReferences ?? {})) {
    out[id] = refs.map(({ start, length }) => `0x${hex.slice(start * 2, (start + length) * 2).padStart(64, "0")}`);
  }
  return out;
}

const word = (v) => `0x${BigInt(v).toString(16).padStart(64, "0")}`;
const addrWord = (a) => word(BigInt(a));

/// The token-repo build's creation code hash (keccak256 of bytecode.object: TombolaToken has no constructor arguments).
export const creationCodeHash = (artifact) => keccak256(artifact.bytecode.object);

/// [A9-5] The address IMD's ProjectFactory deploys a launch's token at: CREATE2(factory, salt = the launch number as
/// a 32-byte word, keccak256(init code)). The init code is the creation bytecode followed by the ABI-encoded
/// constructor arguments, exactly what CREATE2 hashes (TombolaToken has none, so it is bytecode.object). Matched on
/// launch 2076 (Robinhood), 2163/2161/2160/2154 (Ethereum) and 2152 (Sepolia). Pass `initCode` or `initCodeHash`.
export function create2TokenAddress({ factory, launchNumber, initCode, initCodeHash }) {
  const salt = pad(toHex(BigInt(launchNumber)), { size: 32 });
  const bytecodeHash = initCodeHash ?? keccak256(initCode);
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecodeHash: bytecodeHash.startsWith("0x") ? bytecodeHash : `0x${bytecodeHash}` });
}

/// [A9-5] The token-repo build's init code as IMD deploys it: creation bytecode plus encoded constructor arguments.
export function tokenInitCode(artifact, ctorArgs = "0x") {
  return `${artifact.bytecode.object}${String(ctorArgs).replace(/^0x/, "")}`;
}

/// [A9-5] Problems unless `token` is CREATE2(factory, launchNumber, keccak256(the build's init code)): the chain's own
/// proof that IMD deployed exactly this creation code (constructor, its arguments and LAUNCH_TIME = deploy time
/// included), with no API.
export function create2Problems({ token, factory, launchNumber, artifact, ctorArgs = "0x" }) {
  const expected = create2TokenAddress({ factory, launchNumber, initCode: tokenInitCode(artifact, ctorArgs) });
  if (sameAddr(expected, token)) return [];
  return [`TOKEN ${token} isn't CREATE2(factory ${factory}, salt ${launchNumber}, keccak256(token-repo's creation code)) = ${expected}: IMD's factory deployed different creation code (a changed constructor or build settings), or TOKEN/LAUNCH_NUMBER is wrong`];
}

/// [A8-1] Checks the token IMD deployed against the local token-repo build. Returns a list of problems.
///   artifact   token-repo/out/TombolaToken.sol/TombolaToken.json (built locally from the generated repo)
///   code       the deployed runtime code
///   getters    { POOL_MANAGER, VAULT, FACTORY, LAUNCH_TIME } as the token reports them
///   expected   { poolManager, vault, factory, now, team: [5 addresses], name, symbol }
///   token      { teamWallets: [5], name, symbol } read from the token
///   record     IMD's launch record (optional): its token artifact's creationCodeHash and attested toolchain
///   toolchain  the token-repo's foundry.toml settings (optional), compared with the record's attestation
export function tokenCodeProblems({ artifact, code, getters, expected, token = {}, record, toolchain }) {
  const out = [];
  if (!code || code === "0x") return ["no contract at TOKEN"];
  // 1. the runtime is the build's, byte for byte outside the four immutables
  const cm = codeMatchesBuild(artifact, code);
  if (!cm.ok) out.push(`the token's runtime code isn't the token-repo build (${cm.reason}): IMD deployed different code than the repository the kit generated`);
  // 2. the immutables: each reference of one immutable holds one value, and the values are what the getters report
  const vals = immutableValues(artifact, code);
  const ids = Object.keys(vals);
  if (ids.length !== 4) out.push(`the token-repo build has ${ids.length} immutables, not the reference token's 4 (POOL_MANAGER, VAULT, FACTORY, LAUNCH_TIME): rebuild token-repo with make-token.mjs`);
  const found = [];
  for (const id of ids) {
    const set = [...new Set(vals[id])];
    if (set.length !== 1) out.push(`immutable ${id} holds ${set.length} different values in the deployed code`);
    found.push(set[0]);
  }
  const want = [addrWord(getters.POOL_MANAGER), addrWord(getters.VAULT), addrWord(getters.FACTORY), word(getters.LAUNCH_TIME)];
  if (cm.ok && [...found].sort().join() !== [...want].sort().join()) out.push("the immutables in the deployed code aren't the values its getters report");
  // 3. the values are this launch's
  if (!sameAddr(getters.POOL_MANAGER, expected.poolManager)) out.push(`token.POOL_MANAGER() is ${getters.POOL_MANAGER}, not vault.poolManager() ${expected.poolManager}`);
  if (!sameAddr(getters.VAULT, expected.vault)) out.push(`token.VAULT() is ${getters.VAULT}, not ${expected.vault}`);
  if (!sameAddr(getters.FACTORY, expected.factory)) out.push(`token.FACTORY() is ${getters.FACTORY}, not ${expected.factory}`);
  if (expected.now !== undefined && BigInt(getters.LAUNCH_TIME) > BigInt(expected.now)) out.push(`token.LAUNCH_TIME() ${getters.LAUNCH_TIME} is in the future (chain time ${expected.now})`);
  if (BigInt(getters.LAUNCH_TIME) === 0n) out.push("token.LAUNCH_TIME() is 0");
  if (expected.deployTime !== undefined && BigInt(getters.LAUNCH_TIME) !== BigInt(expected.deployTime)) out.push(`token.LAUNCH_TIME() ${getters.LAUNCH_TIME} isn't the deploy block's time ${expected.deployTime}`);
  // 4. what the constructor wrote: the team wallets (the vault's), name and symbol
  if (expected.team) {
    const names = ["team0", "team1", "team2", "team3", "teamFeeWallet"];
    expected.team.forEach((w, i) => {
      if (!sameAddr(token.teamWallets?.[i], w)) out.push(`token.teamWallets(${i}) is ${token.teamWallets?.[i]}, not vault.${names[i]}() ${w}`);
    });
  }
  if (expected.name !== undefined && token.name !== expected.name) out.push(`token.name() is ${JSON.stringify(token.name)}, not ${JSON.stringify(expected.name)}`);
  if (expected.symbol !== undefined && token.symbol !== expected.symbol) out.push(`token.symbol() is ${JSON.stringify(token.symbol)}, not ${JSON.stringify(expected.symbol)}`);
  // 5. IMD's attestation, when its record has one: the creation code (constructor included) and the toolchain
  const art = (record?.artifacts ?? []).find((a) => a.role === "token");
  if (art?.creationCodeHash) {
    const mine = creationCodeHash(artifact).slice(2).toLowerCase();
    if (String(art.creationCodeHash).replace(/^0x/, "").toLowerCase() !== mine) out.push(`IMD's record attests creation code ${art.creationCodeHash}, the token-repo build's is ${mine}: the constructor or the build settings differ`);
  }
  const att = record?.attestation?.toolchain;
  if (att && toolchain) {
    for (const [k, v] of Object.entries(toolchain)) if (att[k] !== undefined && String(att[k]) !== String(v)) out.push(`IMD built with ${k}=${att[k]}, token-repo's foundry.toml has ${v}`);
  }
  return out;
}

/// Reads the settings tokenCodeProblems compares with IMD's attestation from a token-repo foundry.toml.
export function foundryToolchain(toml) {
  const get = (k) => toml.match(new RegExp(`^\\s*${k}\\s*=\\s*"?([^"\\r\\n]+?)"?\\s*$`, "m"))?.[1];
  const bool = (v) => (v === undefined ? undefined : v === "true");
  const t = { solc: get("solc"), viaIR: bool(get("via_ir")), optimizer: bool(get("optimizer")), optimizerRuns: get("optimizer_runs") === undefined ? undefined : Number(get("optimizer_runs")), evmVersion: get("evm_version"), bytecodeHash: get("bytecode_hash") };
  return Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined));
}

// ------------------------------------------------------------------ IMD's plan must not write code [A8-1]
/// The request steps the kit sends: an audit of the repository as it arrived, then IMD's review panel. No step that
/// adapts (writes) the token: IMD's own plan describes adapt-contract-project as "fixing what the audit found".
export const REQUEST_STEPS = ["audit-imported-code", "adversarial-review"];
/// Plan skills that only read the code (audit, judge), and the plan's fixed non-skill steps.
const READ_ONLY_SKILLS = new Set(["audit-imported-code", "audit-specialist", "audit-judge", "adversarial-review"]);
const CODE_WRITING = /adapt|fix|implement|modif|rewrite|patch|refactor|change the code|edit/i;

/// [A8-1] Problems with a launch request's steps and with IMD's plan for it (POST /requests/check): any step that may
/// write code is refused. "Write what to deploy" (IMD's manifest step) and "Deploy on ..." are allowed; bind.mjs's
/// token code check catches anything they change.
export function planCodeProblems(check, requestSteps) {
  const out = [];
  const req = (requestSteps ?? []).map((s) => s?.skill ?? s);
  if (req.join() !== REQUEST_STEPS.join()) out.push(`the request's steps are [${req.join(", ")}], not [${REQUEST_STEPS.join(", ")}]: no step may adapt or write the token's code`);
  for (const p of check?.plan ?? []) {
    const title = typeof p === "string" ? p : p.title ?? "";
    const skill = typeof p === "string" ? undefined : p.skill;
    if (skill) {
      if (!READ_ONLY_SKILLS.has(skill)) out.push(`IMD's plan has a step "${title}" (${skill}) that isn't an audit or review step: it may write code`);
      else if (CODE_WRITING.test(title) && !/^audit|^judge/i.test(title)) out.push(`IMD's plan step "${title}" (${skill}) reads as writing code`);
    } else if (!/^Write what to deploy$/i.test(title) && !/^Deploy on /i.test(title)) {
      out.push(`IMD's plan has an unrecognised step "${title}": check it doesn't write code before paying`);
    }
  }
  return out;
}

// ------------------------------------------------------------------ alerts and the tax backlog [A7-4][A7-14c]
/// Whether an alert keyed `key` is due: never sent, or (with `every` seconds) last sent at least `every` ago.
/// `alerts` maps key -> last sent time (chain seconds, as a string or bigint).
export function alertDue(alerts, key, now, every) {
  const last = alerts[key];
  if (last === undefined) return true;
  if (every === undefined || every === null) return false;
  return BigInt(now) - BigInt(last) >= BigInt(every);
}

/// Drops alert keys last sent more than `keep` seconds ago, so the state file stays small.
export function pruneAlerts(alerts, now, keep = 8n * 86400n) {
  for (const [k, v] of Object.entries(alerts)) if (BigInt(now) - BigInt(v) > keep) delete alerts[k];
  return alerts;
}

export const TAX_COLLECTED_EVENT = parseAbiItem("event TaxCollected(uint256 tokens, bool isBuy)");

/// [A7-4] Whether the vault's loose tokens exceed `multiple` x the tax that came in over the trailing 24 hours.
/// `multiple` is a decimal (2 = twice); nothing below `minTokens` alerts.
export function backlogCheck({ loose, inflow, multiple, minTokens = 0n }) {
  loose = BigInt(loose);
  inflow = BigInt(inflow);
  const m = BigInt(Math.round(Number(multiple) * 1000));
  const over = loose >= BigInt(minTokens) && loose * 1000n > m * inflow;
  const ratio = inflow === 0n ? Infinity : Number((loose * 1000n) / inflow) / 1000;
  return { alert: over, ratio };
}

/// [A9-10] Whether the backlog check should run now. It compares the loose balance with the tax over the trailing
/// 24 h, both at `sumTo` (head - CONFIRMATIONS, the block taxInflow's sum ends at), so:
///   - no check while the chain is shorter than the confirmation margin past the deploy block (no sum yet)
///   - with no tax counted yet, no "no TaxCollected logs" alert on a fresh vault: the vault must have been bound for
///     more than 24 h, or a TaxCollected must have been seen at some point, before an empty window means anything
/// Returns { run, reason }.
export function backlogGate({ sumTo, deployBlock = 0n, inflow, everTaxed = false, boundTime, now, day = 86400n }) {
  if (sumTo === undefined || sumTo === null || BigInt(sumTo) < BigInt(deployBlock)) return { run: false, reason: "the chain is shorter than the confirmation margin past the deploy block" };
  if (BigInt(inflow) === 0n && !everTaxed) {
    if (boundTime === undefined || boundTime === null) return { run: false, reason: "no TaxCollected seen yet and the bind time is unknown" };
    if (BigInt(now) - BigInt(boundTime) <= BigInt(day)) return { run: false, reason: "no TaxCollected seen yet and the vault was bound less than 24 h ago" };
  }
  return { run: true, reason: "" };
}

/// Keeps a running 24-hour sum of TaxCollected over `state` = { cursor, entries: [[block, logIndex, tokens]] }.
/// [A8-10c] Like the credit scan, it stops `confirmations` blocks below head and restarts `rescan` blocks before the
/// cursor (a lagging logs node can answer short without an error), deduplicating by (block, logIndex); entries
/// before `windowFrom` are dropped. Returns the sum over [windowFrom, head - confirmations].
export async function taxInflow({ state, fetchRange, windowFrom, head, chunk = DEFAULT_LOG_CHUNK, confirmations = 20n, rescan = 1000n }) {
  windowFrom = BigInt(windowFrom);
  head = BigInt(head);
  state.entries ??= [];
  if (state.cursor !== undefined && BigInt(state.cursor) > head + 1n) {
    // a cursor past head (a reset local chain): start over
    state.entries = [];
    state.cursor = undefined;
  }
  const w = creditScanWindow(state.cursor === undefined ? windowFrom : BigInt(state.cursor), head, { deployBlock: windowFrom, confirmations: BigInt(confirmations), rescan: state.cursor === undefined ? 0n : BigInt(rescan) });
  if (w) {
    const logs = await getLogsChunked(fetchRange, w.from, w.to, { chunk });
    const seen = new Set(state.entries.map(([b, i]) => `${b}:${i}`));
    for (const l of logs) {
      const k = `${BigInt(l.blockNumber)}:${Number(l.logIndex ?? 0)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      state.entries.push([BigInt(l.blockNumber), Number(l.logIndex ?? 0), BigInt(l.args.tokens)]);
    }
    if (state.cursor === undefined || w.to + 1n > BigInt(state.cursor)) state.cursor = w.to + 1n;
    // [A9-10] the block the sum covers up to: the backlog check reads the loose balance at this same block
    state.to = w.to;
    if (state.entries.length) state.everTaxed = true;
  } else state.to = undefined;
  state.entries = state.entries.filter(([b]) => b >= windowFrom);
  return state.entries.reduce((s, [, , t]) => s + t, 0n);
}

// ------------------------------------------------------------------ Uniswap v4 pool state
const POOLS_SLOT = 6n; // PoolManager's `pools` mapping (v4-core StateLibrary.POOLS_SLOT)

export function poolId(key) {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [key.currency0, key.currency1, Number(key.fee), Number(key.tickSpacing), key.hooks],
    ),
  );
}

export function poolStateSlot(key) {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(key), POOLS_SLOT]));
}

/// Slot0's packed word: sqrtPriceX96 (bits 0-159), tick (160-183, signed), protocolFee (184-207), lpFee (208-231).
export function decodeSlot0(word) {
  const w = BigInt(word);
  const sqrtPriceX96 = w & ((1n << 160n) - 1n);
  let tick = Number((w >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  return { sqrtPriceX96, tick, protocolFee: Number((w >> 184n) & 0xffffffn), lpFee: Number((w >> 208n) & 0xffffffn) };
}

export async function readSlot0(pub, poolManager, key) {
  const word = await pub.readContract({
    address: poolManager,
    abi: parseAbi(["function extsload(bytes32 slot) view returns (bytes32)"]),
    functionName: "extsload",
    args: [poolStateSlot(key)],
  });
  return decodeSlot0(word);
}

// ------------------------------------------------------------------ vault build checks
/// The bindToken signatures the launch kit can drive. [A6-4] the vault reads the claim contract and pool key from
/// IMD's factory, so the binder passes only the token and the launch number. [A8-4] the later build adds a slippage
/// bound, bindToken(token, launchNumber, minTick), reverting PriceMoved when the pool's tick is below minTick (a
/// dearer token than bind.mjs last read); bind.mjs passes it whenever the build has it.
export const SUPPORTED_BIND = "bindToken(address,uint64)";
export const SUPPORTED_BIND_MIN_TICK = "bindToken(address,uint64,int24)";
export const SUPPORTED_BINDS = [SUPPORTED_BIND, SUPPORTED_BIND_MIN_TICK];

const sigOf = (f) => `${f.name}(${f.inputs.map((i) => typeAbiString(i)).join(",")})`;
function typeAbiString(i) {
  if (!i.type.startsWith("tuple")) return i.type;
  return `(${i.components.map(typeAbiString).join(",")})${i.type.slice(5)}`;
}

/// Finds bindToken in a vault ABI and says whether the launch kit supports it, and whether it takes minTick.
export function findBind(abiJson) {
  const binds = abiJson.filter((x) => x.type === "function" && x.name === "bindToken");
  const sigs = binds.map(sigOf);
  if (binds.length !== 1) return { ok: false, sigs, reason: binds.length ? "more than one bindToken" : "no bindToken in the ABI" };
  if (!SUPPORTED_BINDS.includes(sigs[0])) return { ok: false, sigs, reason: `bindToken is ${sigs[0]}; the launch kit supports ${SUPPORTED_BINDS.join(" and ")}` };
  return { ok: true, sigs, fn: binds[0], hasMinTick: sigs[0] === SUPPORTED_BIND_MIN_TICK };
}

/// bindToken's arguments for the build's signature: minTick only when the build takes it.
export function bindArgs(bind, { token, launchNumber, minTick }) {
  if (!bind.hasMinTick) return [token, launchNumber];
  if (minTick === undefined) throw new Error("this vault build's bindToken takes minTick: pass the last read's tick minus one spacing");
  return [token, launchNumber, Number(minTick)];
}

/// [A6-18] Function selectors of `abiJson` whose dispatcher entry is missing from `code` (a deployed runtime).
/// Solidity's dispatcher pushes each selector with PUSHn (n = its length without leading zero bytes).
export function missingSelectors(abiJson, code) {
  const hex = code.toLowerCase().replace(/^0x/, "");
  const missing = [];
  for (const f of abiJson.filter((x) => x.type === "function")) {
    const sel = toFunctionSelector(sigOf(f)).slice(2);
    let s = sel;
    while (s.startsWith("00") && s.length > 2) s = s.slice(2);
    const push = (0x5f + s.length / 2).toString(16);
    if (!hex.includes(push + s)) missing.push(sigOf(f));
  }
  return missing;
}

// ------------------------------------------------------------------ credit scan
/// [A6-8] The block window a credit scan covers: from `rescan` blocks before the saved cursor (logs nodes behind a
/// load balancer can answer short without an error), to `confirmations` blocks below head. Null if nothing is due.
export function creditScanWindow(cursor, head, { deployBlock = 0n, confirmations = 20n, rescan = 1000n } = {}) {
  const to = head - confirmations;
  if (to < 0n) return null;
  let from = cursor - rescan;
  if (from < deployBlock) from = deployBlock;
  if (from > to) return null;
  return { from, to };
}

/// Runs one credit scan over `creditScanWindow`, adding every credited wallet to state.creditHolders. The cursor only
/// moves forward and never past the last block of a window that answered.
export async function scanCreditLogs({ getBlockNumber, fetchRange, state, deployBlock = 0n, chunk = DEFAULT_LOG_CHUNK, confirmations = 20n, rescan = 1000n, save = () => {}, logFn = () => {} }) {
  const head = await getBlockNumber();
  if (state.creditCursor > head + 1n) {
    // the saved cursor is past the chain head (a reset local chain, or a state file from another chain): start over
    logFn(`credit scan cursor ${state.creditCursor} is past head ${head}; rescanning from ${deployBlock}`);
    state.creditCursor = deployBlock;
    state.creditHolders.clear();
  }
  const w = creditScanWindow(state.creditCursor, head, { deployBlock, confirmations, rescan });
  if (!w) return null;
  await getLogsChunked(fetchRange, w.from, w.to, {
    chunk,
    onChunk: (to, logs) => {
      for (const l of logs) state.creditHolders.add(l.args.to);
      if (to + 1n > state.creditCursor) state.creditCursor = to + 1n;
      save();
    },
  });
  return w;
}

// ------------------------------------------------------------------ chunked log scans
// Public RPCs cap eth_getLogs ranges (Robinhood's at 10,000,000 blocks), so every scan from the deploy block goes
// through this helper: fixed-size windows, halved on error and grown back after a success.

export const DEFAULT_LOG_CHUNK = 5_000_000n;

/// Orders logs by (blockNumber, logIndex), the order the chain emitted them in.
export function sortLogs(logs) {
  return [...logs].sort((x, y) =>
    x.blockNumber === y.blockNumber ? Number(x.logIndex) - Number(y.logIndex) : x.blockNumber < y.blockNumber ? -1 : 1,
  );
}

/// Calls `fetchRange(from, to)` over [fromBlock, toBlock] in windows of at most `chunk` blocks and returns every
/// log, merge-sorted by (blockNumber, logIndex). A failing window is halved and retried, down to `minChunk`.
/// By default (no `minChunk`) a range or size error ("logs matched by query exceeds limit of 10000") halves down
/// to one block, which no Robinhood block can overflow, while any other error stops at 1,000 blocks so an outage
/// fails fast [R8 finding 2]. An explicit `minChunk` is the floor for every error.
/// `onChunk(to, logs)` runs after each window (to persist a cursor); if it returns true the scan stops early.
export async function getLogsChunked(fetchRange, fromBlock, toBlock, { chunk = DEFAULT_LOG_CHUNK, minChunk, onChunk } = {}) {
  fromBlock = BigInt(fromBlock);
  toBlock = BigInt(toBlock);
  chunk = BigInt(chunk);
  if (chunk < 1n) throw new Error("chunk must be at least 1 block");
  const sizeFloor = minChunk === undefined ? 1n : BigInt(minChunk);
  const otherFloor = minChunk === undefined ? 1_000n : BigInt(minChunk);
  const sizeErr = (e) => {
    const m = `${e?.shortMessage ?? ""} ${e?.details ?? ""} ${e?.message ?? ""}`;
    return !/\b429\b|rate.?limit|too many requests|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|fetch failed/i.test(m)
      && /range|too many|too big|more than|exceed|limit|too large|response size|results|block span|10000|are allowed/i.test(m);
  };
  const out = [];
  let size = chunk;
  let from = fromBlock;
  while (from <= toBlock) {
    const to = from + size - 1n < toBlock ? from + size - 1n : toBlock;
    let logs;
    try {
      logs = await fetchRange(from, to);
    } catch (e) {
      let floor = sizeErr(e) ? sizeFloor : otherFloor;
      if (floor > chunk) floor = chunk;
      if (size <= floor) throw e;
      size = size / 2n > floor ? size / 2n : floor;
      continue;
    }
    out.push(...logs);
    from = to + 1n;
    if (size < chunk) size = size * 2n < chunk ? size * 2n : chunk;
    if (onChunk && (await onChunk(to, logs))) break;
  }
  return sortLogs(out);
}

/// Rebuilds a token's draw list by replaying its Listed and Delisted logs (already sorted). Throws on any log
/// that doesn't fit the list as rebuilt so far, including a Delisted whose `moved` isn't the entry it popped.
export function replayList(logs) {
  const list = [];
  for (const l of logs) {
    const i = Number(l.args.index);
    if (l.eventName === "Listed") {
      if (i !== list.length) throw new Error(`Listed at index ${i} but the list has ${list.length}`);
      list.push(l.args.account);
    } else if (l.eventName === "Delisted") {
      if (list[i]?.toLowerCase() !== l.args.account.toLowerCase()) throw new Error(`Delisted ${l.args.account} not at index ${i}`);
      const last = list.pop();
      if (last.toLowerCase() !== String(l.args.moved).toLowerCase()) {
        throw new Error(`Delisted at index ${i} says ${l.args.moved} moved, but the last entry was ${last}`);
      }
      if (i < list.length) list[i] = last;
    } else {
      throw new Error(`unexpected log ${l.eventName}`);
    }
  }
  return list;
}

/// Logs strictly before `at` (a log with blockNumber and logIndex).
export function before(logs, at) {
  return logs.filter((l) => l.blockNumber < at.blockNumber || (l.blockNumber === at.blockNumber && l.logIndex < at.logIndex));
}

export const log = (...a) => console.log(new Date().toISOString(), ...a);
