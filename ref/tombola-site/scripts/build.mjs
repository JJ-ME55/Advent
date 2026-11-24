// Builds the static site into dist/ in one step: regenerates src/generated/abis.js from contracts/out (and fails
// if the ABI is stale), bundles, copies the assets, and writes dist/_headers with a CSP whose connect-src lists
// exactly the origins in the config.
//   node scripts/build.mjs              production (config.js)
//   node scripts/build.mjs --local      config.local.js plus mock/snapshot.json
//   node scripts/build.mjs --no-abis    keep the existing src/generated/abis.js (contracts/out mid-change)
// Extra connect-src origins: config `extraConnect: [...]`, or CSP_CONNECT="https://a.example https://b.example".
import { build } from "esbuild";
import { cpSync, rmSync, mkdirSync, copyFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { writeAbis } from "./abis.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "dist");
const local = process.argv.includes("--local");
const noAbis = process.argv.includes("--no-abis");
const configFile = local ? "config.local.js" : "config.js";

/** Reads window.TOMBOLA_CONFIG from a config file without a browser. */
export function readConfig(file) {
  const window = {};
  runInNewContext(readFileSync(file, "utf8"), { window });
  if (!window.TOMBOLA_CONFIG) throw new Error(`${file} doesn't set window.TOMBOLA_CONFIG`);
  return window.TOMBOLA_CONFIG;
}

/** The CSP connect-src for a config: 'self' plus the origin of every URL the page may fetch. */
export function connectSrc(cfg, extra = []) {
  const origins = new Set(["'self'"]);
  const add = (u) => {
    if (!u) return;
    let x;
    try { x = new URL(u); } catch { return; } // relative (same origin) or empty
    if (x.protocol !== "https:" && !(x.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(x.hostname))) {
      throw new Error(`connect-src: ${u} must be https (http only on localhost)`);
    }
    origins.add(x.origin);
  };
  add(cfg.rpcUrl);
  add(cfg.botBase);
  // Verify's drand fallbacks, the same relays as bot/lib.mjs DRAND_URLS [R6 finding 10]
  for (const u of ["https://api.drand.sh", "https://api2.drand.sh", "https://api3.drand.sh", "https://drand.cloudflare.com"]) add(u);
  add(cfg.imdApi);
  add(cfg.priceUrl); // only when the operator opted in
  for (const u of cfg.extraConnect ?? []) add(u);
  for (const u of extra) add(u);
  // "verify with your own RPC" on the visitor's own machine: named ports only, not every local port [R6 finding 16]
  for (const p of localRpcPorts(cfg)) for (const host of ["localhost", "127.0.0.1"]) origins.add(`http://${host}:${p}`);
  return [...origins].join(" ");
}

/** Local ports "verify with your own RPC" may use: config `localRpcPorts`, default [8545]; [] turns it off. */
export function localRpcPorts(cfg) {
  const ports = cfg.localRpcPorts ?? [8545];
  if (!Array.isArray(ports)) throw new Error("localRpcPorts must be an array of port numbers");
  for (const p of ports) if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`localRpcPorts: bad port ${p}`);
  return ports;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (noAbis) console.log("ABIs: keeping src/generated/abis.js (--no-abis)");
  else console.log("ABIs", writeAbis());
  const cfg = readConfig(join(root, configFile));
  const csp = connectSrc(cfg, (process.env.CSP_CONNECT ?? "").split(/\s+/).filter(Boolean));
  if (cfg.draw && !Number(cfg.startBlock)) {
    console.warn("WARNING config startBlock is 0: set it to the token's deploy block, or every log scan starts at block 0 [R6 finding 11]");
  }
  if (cfg.draw && !Number(cfg.launchTime) && !local) {
    console.warn("WARNING config launchTime is 0: the countdown reads it from the token's first Transfer instead; set it to the token's first block time");
  }

  rmSync(dist, { recursive: true, force: true });
  mkdirSync(join(dist, "fonts"), { recursive: true });

  await build({
    entryPoints: [join(root, "src", "main.js")],
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2020",
    outfile: join(dist, "app.js"),
    // the page checks "verify with your own RPC" URLs against the same origins the CSP allows [R6 finding 16]
    define: { __TOMBOLA_CONNECT__: JSON.stringify(csp.split(" ")) },
    logLevel: "info",
  });

  for (const f of ["index.html", "styles.css", "fair.css"]) copyFileSync(join(root, f), join(dist, f));
  // the local demo's launchTime comes from the deploy script's json (copied to mock/pons-local.json), not the config
  let configText = readFileSync(join(root, configFile), "utf8");
  if (local && !Number(cfg.launchTime)) {
    const dep = JSON.parse(readFileSync(join(root, "mock", "pons-local.json"), "utf8"));
    configText = configText.replace(/launchTime:\s*0/, `launchTime: ${Number(dep.launchTime)}`);
    for (const k of ["draw", "splitter", "token", "beacon", "escrow"]) {
      if (dep[k] && cfg[k] && dep[k].toLowerCase() !== String(cfg[k]).toLowerCase()) console.warn(`WARNING config.local.js ${k} ${cfg[k]} isn't mock/pons-local.json's ${dep[k]}`);
    }
  }
  writeFileSync(join(dist, "config.js"), configText);
  cpSync(join(root, "public"), dist, { recursive: true });
  const headers = readFileSync(join(root, "public", "_headers"), "utf8");
  if (!headers.includes("connect-src __CONNECT_SRC__")) throw new Error("public/_headers has no connect-src __CONNECT_SRC__ placeholder");
  writeFileSync(join(dist, "_headers"), headers.replace("connect-src __CONNECT_SRC__", `connect-src ${csp}`));
  console.log("connect-src", csp);

  // Self-hosted fonts: no third-party requests.
  const fonts = [
    ["rye", "rye-latin-400-normal.woff2"],
    ["lora", "lora-latin-400-normal.woff2"],
    ["lora", "lora-latin-600-normal.woff2"],
    ["lora", "lora-latin-400-italic.woff2"],
  ];
  for (const [pkg, file] of fonts) copyFileSync(join(root, "node_modules", "@fontsource", pkg, "files", file), join(dist, "fonts", file));

  if (local) cpSync(join(root, "mock"), join(dist, "mock"), { recursive: true });
  console.log(`Built ${local ? "LOCAL" : "production"} site in dist/:`, readdirSync(dist).join(", "));

  // On Vercel (or with --vercel), also emit the Build Output API layout, so the same headers as dist/_headers
  // (which only Cloudflare Pages reads) apply: dist/ as static files plus a config.json carrying the headers.
  if (process.env.VERCEL || process.argv.includes("--vercel")) {
    const out = join(root, ".vercel", "output");
    rmSync(out, { recursive: true, force: true });
    cpSync(dist, join(out, "static"), { recursive: true });
    rmSync(join(out, "static", "_headers"), { force: true });
    writeFileSync(join(out, "config.json"), JSON.stringify(vercelConfig(readFileSync(join(dist, "_headers"), "utf8")), null, 2));
    console.log("Vercel build output written to .vercel/output");
  }
}

/** Turns a Cloudflare _headers file into a Vercel Build Output API config with the same headers per path. */
export function vercelConfig(headersFile) {
  const routes = [];
  let cur = null;
  for (const line of headersFile.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      cur = { path: line.trim(), headers: {} };
      routes.push(cur);
    } else if (cur) {
      const i = line.indexOf(":");
      cur.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const src = (p) => "^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$";
  return {
    version: 3,
    routes: [...routes.map((r) => ({ src: src(r.path), headers: r.headers, continue: true })), { handle: "filesystem" }],
  };
}
