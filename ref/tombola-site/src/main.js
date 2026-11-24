// Tombola site (Pons launch). Reads TombolaDraw, the splitter, Pons' fee escrow and the token's Transfer logs over
// a public RPC, plus the bot's optional snapshot.json; no backend, no tracking.
import { createPublicClient, http, formatEther, isAddress, getAddress } from "viem";
import { drawAbi, splitterAbi, tokenAbi, escrowAbi } from "./generated/abis.js";
import {
  verifyDraw, boughtFromPool, chunkedLogs, transferLogs, blockTimes, listAtTime, sortLogs, roundTimeOf, weightFor, multiplierWad,
  MIN_BALANCE, ELIGIBLE_AFTER, verifySummary, fmtDur, poolFlagOf, strongerFlag, tokensText, WAD, ZERO, TX_RE,
} from "./draw.js";
import { createCage } from "./cage.js";
import { initMusic } from "./music.js";
import { initFair } from "./fair.js";
import { initCurtain } from "./curtain.js";
import { initAnnouncer } from "./announcer.js";

const C = Object.assign(
  {
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com", chainId: 4663, draw: "", splitter: "", token: "", curve: "", beacon: "", escrow: "",
    poolManager: "", startBlock: 0, launchTime: 0, exclude: [], buyUrl: "https://pons.fun", botBase: "", ticker: "TOMBOLA",
    explorer: "https://robinhoodchain.blockscout.com", priceUrl: "", imdApi: "https://api.imd.fun",
  },
  window.TOMBOLA_CONFIG || {},
);
const botBase = (C.botBase || "").replace(/\/+$/, "");
const makeClient = (url) => createPublicClient({ transport: http(url, { batch: { batchSize: 40 }, retryCount: 2, timeout: 20_000 }) });
const pub = makeClient(C.rpcUrl);
const LIVE = !!C.draw; // the "launching soon" state until the draw contract is configured

const $ = (id) => document.getElementById(id);
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// Chain time: the browser clock offset by the last block's timestamp, so countdowns and "due now" follow the chain
// even when the visitor's clock is wrong [R6 finding 16].
let clockSkew = 0;
const now = () => Math.floor(Date.now() / 1000 + clockSkew);
// The origins this build's CSP connect-src allows (scripts/build.mjs defines it); null when run unbundled.
const CSP_ORIGINS = typeof __TOMBOLA_CONNECT__ !== "undefined" ? __TOMBOLA_CONNECT__ : null;
const HOUR = 3600, DAY = 86400;
const MIN_DRAW = 10n ** 15n; // the keeper's MIN_DRAW_WEI default: below it a due slot waits for the pot
const POT_BPS = 7018n, MEGA_BPS = 1754n, BPS = 10_000n; // TombolaSplitter's shares

const S = { chain: null, snap: null, snapNote: "", usd: null, chainAt: 0, chainErr: "", launchTime: Number(C.launchTime) || 0 };

// Infra addresses that never hold tickets, as the keeper's EXCLUDE: the config list plus the contracts themselves.
const excludeAll = () => [...new Set([...(C.exclude ?? []), C.draw, C.splitter, C.curve, C.poolManager, S.chain?.splitter, ZERO].filter(Boolean).map((a) => a.toLowerCase()))];
// Where a buy can come from: Pons' bonding curve before graduation, the Uniswap v4 PoolManager after.
const pools = () => [C.curve, C.poolManager].filter(Boolean);

// ------------------------------------------------------------------ formatting

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k instanceof Node ? k : String(k));
  return el;
}
function eth(wei, dp) {
  const n = Number(formatEther(BigInt(wei ?? 0)));
  const d = dp ?? (n === 0 ? 4 : n < 0.01 ? 6 : n < 100 ? 4 : 2);
  return n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function usd(wei) {
  if (!S.usd) return "";
  const v = Number(formatEther(BigInt(wei ?? 0))) * S.usd;
  return `about $${v.toLocaleString("en-US", { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
}
function tokens(wei) {
  const n = Number(BigInt(wei) / WAD);
  return n.toLocaleString("en-US");
}
const big = (x) => { try { return BigInt(x ?? 0); } catch { return 0n; } }; // snapshot numbers: never throw mid-render
const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
const pad = (n) => String(n).padStart(2, "0");
const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function ago(ts) {
  const s = now() - ts;
  return s < 60 ? "just now" : `${fmtDur(s)} ago`;
}
// Explorer paths are built only from a checked address or tx hash, never from a raw snapshot string. [finding 23]
const validFor = (kind, value) => (kind === "tx" ? typeof value === "string" && TX_RE.test(value) : typeof value === "string" && isAddress(value, { strict: false }));
function explorerHref(kind, value) {
  if (!C.explorer || !validFor(kind, value)) return null;
  return `${C.explorer.replace(/\/+$/, "")}/${kind}/${kind === "tx" ? value : getAddress(value)}`;
}
function explorerLink(kind, value, text) {
  const href = explorerHref(kind, value);
  if (!href) return h("span", { text: text ?? value });
  return h("a", { href, target: "_blank", rel: "noopener", text: text ?? value });
}
// Attestation links: https only, and only on IMD's API origin.
const ATTEST_ORIGINS = [C.imdApi].filter(Boolean).map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean);
function safeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && ATTEST_ORIGINS.includes(x.origin) ? x.href : null;
  } catch { return null; }
}

// ------------------------------------------------------------------ cadence (bot/pons/keeper.mjs dueTime)

// hourly for the first 6 hours after launch, then every 4 hours; mega weekly
const dueTime = (track, i) => (track === 1 ? S.launchTime + i * 7 * DAY : i <= 6 ? S.launchTime + i * HOUR : S.launchTime + 10 * HOUR + (i - 7) * 4 * HOUR);
/** The next slot strictly after `t`: { index, at }. */
function nextSlot(track, t) {
  let i = 1;
  while (dueTime(track, i) <= t) i++;
  return { index: i, at: dueTime(track, i) };
}

// ------------------------------------------------------------------ data

async function loadChain() {
  const draw = C.draw;
  const v = (functionName, args = []) => pub.readContract({ address: draw, abi: drawAbi, functionName, args });
  const chainId = await pub.getChainId();
  if (C.chainId && chainId !== Number(C.chainId)) throw new Error(`RPC is on chain ${chainId}, expected ${C.chainId}`);
  const [potRegular, potMega, reserved, unclaimedTotal, a0, a1, drawCount, solvent, held, block, splitter, beacon] = await Promise.all([
    v("potRegular"), v("potMega"), v("reserved"), v("unclaimedTotal"), v("activeDraw", [0]), v("activeDraw", [1]), v("drawCount"), v("solvent"),
    pub.getBalance({ address: draw }), pub.getBlock(), C.splitter || v("splitter"), C.beacon || v("beacon"),
  ]);
  const blockTs = block.timestamp;
  clockSkew = Number(blockTs) - Date.now() / 1000;
  // what Pons' escrow holds for the splitter, plus any ETH already on the splitter: harvest() moves it into the pots
  // by the splitter's fixed shares, and the keeper harvests before every commit, so it is counted into the pots
  let pending = 0n, escrow = C.escrow;
  try {
    if (!escrow) escrow = await pub.readContract({ address: splitter, abi: splitterAbi, functionName: "escrow" });
    const [inEscrow, loose] = await Promise.all([
      escrow && !same(escrow, ZERO) ? pub.readContract({ address: escrow, abi: escrowAbi, functionName: "balanceOf", args: [splitter] }) : 0n,
      pub.getBalance({ address: splitter }),
    ]);
    pending = inEscrow + loose;
  } catch (e) { console.warn("escrow read failed", e); }
  const active = async (a) => {
    if (a === 0n) return null;
    const id = a - 1n;
    const d = await v("getDraw", [id]);
    return { id: Number(id), amount: d.amount, round: d.drandRound, roundAt: Number(roundTimeOf(d.drandRound)), snapshotTime: Number(d.snapshotTime) };
  };
  const [act0, act1] = await Promise.all([active(a0), active(a1)]);
  return {
    draw, splitter, beacon, escrow, token: C.token, potRegular, potMega, reserved, unclaimedTotal, solvent, held,
    pending, pendingRegular: (pending * POT_BPS) / BPS, pendingMega: (pending * MEGA_BPS) / BPS,
    active: [act0, act1], drawCount: Number(drawCount), blockTs: Number(blockTs), blockNumber: block.number,
  };
}

async function loadSnapshot() {
  if (!botBase) return null;
  const r = await fetch(`${botBase}/snapshot.json`, { cache: "no-store" });
  if (!r.ok) throw new Error(`snapshot.json: HTTP ${r.status}`);
  const s = await r.json();
  if (C.draw && s.draw && !same(s.draw, C.draw)) throw new Error("snapshot is for a different draw contract; ignored");
  if (C.chainId && s.chainId && Number(s.chainId) !== Number(C.chainId)) throw new Error("snapshot is for a different chain; ignored");
  return s;
}

async function loadPrice() {
  if (!C.priceUrl) return;
  try {
    const j = await (await fetch(C.priceUrl, { cache: "no-store", referrerPolicy: "no-referrer" })).json();
    const p = j?.ethereum?.usd;
    if (typeof p === "number" && p > 0) S.usd = p;
  } catch { /* optional */ }
}

// ------------------------------------------------------------------ the draw list (src/snapshot.js over Transfer logs)

// Every Transfer of the token since startBlock, with its block's timestamp, kept and extended as the chain grows, so
// the eligibility checker, the drum's ball count and the winners' hold clocks all replay the same canonical list.
const tracker = { logs: [], times: blockTimes(pub), next: BigInt(C.startBlock || 0), list: null, at: 0, busy: null, firstTime: 0 };
function refreshList() {
  if (!LIVE || !C.token) return Promise.resolve(null);
  if (tracker.busy) return tracker.busy;
  tracker.busy = (async () => {
    const head = await pub.getBlockNumber();
    if (head >= tracker.next) {
      const logs = await transferLogs({ pub, token: C.token, fromBlock: tracker.next, toBlock: head });
      await tracker.times.prefetch(logs.map((l) => l.blockNumber));
      tracker.logs = sortLogs([...tracker.logs, ...logs]);
      tracker.next = head + 1n;
    }
    if (!tracker.firstTime && tracker.logs.length) tracker.firstTime = Number(await tracker.times.timeOf(tracker.logs[0].blockNumber));
    if (!S.launchTime && tracker.firstTime) S.launchTime = tracker.firstTime; // the token's first block: the cadence anchor
    const t = S.chain?.blockTs ?? now();
    tracker.list = await listAtTime({ logs: tracker.logs, timeOf: tracker.times.timeOf, snapshotTime: t, exclude: excludeAll() });
    tracker.at = now();
    return tracker.list;
  })().finally(() => { tracker.busy = null; });
  return tracker.busy;
}

// Winners from the chain: Settled and RolledOver events, newest first, scanned back from the head in chunks so the
// public RPC's range limit never refuses it [finding 8].
async function winnersFromChain(c) {
  const names = ["Settled", "RolledOver"];
  const logs = await chunkedLogs(pub, async (a, b) => (await Promise.all(names.map((eventName) =>
    pub.getContractEvents({ address: c.draw, abi: drawAbi, eventName, fromBlock: a, toBlock: b })))).flat(), {
    fromBlock: BigInt(C.startBlock || 0), toBlock: c.blockNumber, backward: true, until: (all) => all.length >= 20,
  });
  const last = logs.slice(-20).reverse();
  const list = tracker.list ? tracker : null;
  const one = async (l) => {
    const id = l.args.id;
    const [d, blk] = await Promise.all([
      pub.readContract({ address: c.draw, abi: drawAbi, functionName: "getDraw", args: [id] }),
      pub.getBlock({ blockNumber: l.blockNumber }),
    ]);
    const rolled = l.eventName === "RolledOver";
    const row = {
      id: Number(id), kind: rolled ? "rolled" : "paid", track: Number(d.track) === 1 ? "mega" : "regular",
      winner: rolled ? null : l.args.winner, amountWei: (rolled ? d.amount : l.args.amount).toString(), tx: l.transactionHash, at: Number(blk.timestamp),
    };
    if (rolled) return row;
    // the winner's hold clock and balance at the snapshot, replayed from the same Transfer logs the keeper used
    let bal = null;
    if (list) {
      try {
        const at = await listAtTime({ logs: tracker.logs, timeOf: tracker.times.timeOf, snapshotTime: d.snapshotTime, exclude: excludeAll() });
        const ws = at.state.get(l.args.winner.toLowerCase());
        if (ws) { row.heldSeconds = Number(BigInt(d.snapshotTime) - ws.holdStart); bal = ws.balance; }
      } catch (e) { console.warn("hold clock replay failed", e); }
    }
    const b = await boughtFromPool({ pub, token: c.token, pools: pools(), skip: excludeAll(), wallet: l.args.winner, beforeTs: Number(d.snapshotTime), balance: bal, fromBlock: BigInt(C.startBlock || 0), toBlock: l.blockNumber });
    row.firstBuyAt = b.boughtWei > 0n ? b.at : null;
    row.firstBuyTx = b.boughtWei > 0n ? b.tx : null;
    row.unknownBuy = b.bought === null || !pools().length;
    row.poolFlag = pools().length ? poolFlagOf(b) : "unknown";
    row.boughtWei = b.boughtWei.toString();
    return row;
  };
  // a few winners at a time: each runs its own Transfer scan, so 20 at once would hammer the public RPC [R6 finding 11]
  const out = [];
  for (let i = 0; i < last.length; i += 4) out.push(...(await Promise.all(last.slice(i, i + 4).map(one))));
  return out;
}

// ------------------------------------------------------------------ hero

let ticks = { reg: 0, mega: 0, regMode: "", megaMode: "" };

function setCountdown(el, secs) {
  const s = Math.max(0, secs);
  el.querySelector("[data-h]").textContent = pad(Math.floor(s / 3600));
  el.querySelector("[data-m]").textContent = pad(Math.floor((s % 3600) / 60));
  el.querySelector("[data-s]").textContent = pad(s % 60);
}

function renderHero() {
  const c = S.chain, snap = S.snap;
  const soon = !LIVE;
  $("soon").hidden = !soon;
  $("pot-board").hidden = soon;
  $("mega-card").hidden = soon;
  if (soon) { $("in-drum").textContent = ""; return; }

  const t = now();
  let pot, kind, note = "", target, mode = "count";
  const hero = $("hero");
  hero.classList.remove("drawing");

  if (c) {
    const a = c.active[0];
    if (a) {
      pot = a.amount;
      kind = `Drop #${Number(a.id) + 1} locked in`;
      hero.classList.add("drawing");
      target = a.roundAt;
      note = t < a.roundAt ? `The drum is locked and the prize is reserved. drand's random number lands when the clock hits zero and the winner is paid on the spot.` : `drand round ${a.round} is out. Paying the winner...`;
      if (t >= a.roundAt) mode = "zero";
    } else {
      pot = c.potRegular + c.pendingRegular;
      if (!S.launchTime) { target = t; kind = "Next drop"; note = "Reading the launch time from the chain..."; }
      else {
        const n = nextSlot(0, t);
        const last = dueTime(0, n.index - 1);
        target = n.at;
        // a slot that just passed stays "due" for two minutes: the keeper commits within its tick [finding 24]
        if (n.index > 1 && t - last < 120) {
          mode = "zero"; target = last;
          if (pot >= MIN_DRAW) { kind = "Drop due now"; note = "The keeper takes the snapshot and commits the draw any moment."; }
          else { kind = "Drop due"; note = `Due once the pot reaches ${eth(MIN_DRAW)} ETH. The slot waits for it.`; }
        } else kind = n.index <= 6 ? "Hourly drop" : "4-hour drop"; // short: it sits in the narrow top of the round plate
      }
      if (!note) note = t < S.launchTime + 6 * HOUR ? "Launch hours: a drop every hour for the first 6 hours." : `Then every 4 hours. Draws settled so far: ${c.drawCount - (c.active[0] ? 1 : 0) - (c.active[1] ? 1 : 0)}.`;
      if (c.pendingRegular > 0n) note += ` Includes ${eth(c.pendingRegular)} ETH of fees waiting to be harvested.`;
    }
  } else if (snap) {
    pot = big(snap.pot?.regularWei);
    target = Number(snap.next?.regularAt) || t;
    kind = "Next drop";
    note = "Live chain read failed; showing the bot's snapshot.";
  } else {
    pot = 0n; target = t; kind = "Next drop"; note = S.chainErr ? "Can't reach the chain right now. Retrying..." : "Loading...";
  }

  $("regular-kind").textContent = kind;
  const potText = eth(pot, BigInt(pot) > 0n && BigInt(pot) < 10n ** 15n ? 6 : 4);
  // the plate leads with dollars when a price is known (ETH underneath); ETH alone otherwise
  const potUsd = S.usd ? Number(formatEther(BigInt(pot ?? 0))) * S.usd : null;
  const big = potUsd === null ? potText : "$" + `${potUsd.toLocaleString("en-US", { minimumFractionDigits: potUsd < 1000 ? 2 : 0, maximumFractionDigits: potUsd < 1000 ? 2 : 0 })}`;
  $("pot-eth").textContent = big;
  $("pot-eth").dataset.eth = potText; // the tannoy quotes the pot in ETH
  $("pot-eth").style.setProperty("--chars", String(Math.max(5, big.length)));
  $("pot-unit").hidden = potUsd !== null;
  $("pot-usd").textContent = potUsd === null ? " " : `${potText} ETH`;
  $("regular-note").textContent = note;
  ticks.reg = target;
  ticks.regMode = mode;

  // mega
  let mpot, mtarget, mnote = "";
  if (c) {
    const a = c.active[1];
    if (a) { mpot = a.amount; mtarget = a.roundAt; mnote = `Drawing mega, draw #${Number(a.id) + 1}`; }
    else {
      mpot = c.potMega + c.pendingMega;
      const n = S.launchTime ? nextSlot(1, t) : { index: 1, at: t };
      mtarget = n.at;
      if (S.launchTime && n.index > 1 && t - dueTime(1, n.index - 1) < 120) mnote = mpot >= MIN_DRAW ? "Mega drop due now" : `Mega due once its pot reaches ${eth(MIN_DRAW)} ETH`;
    }
  } else if (snap) { mpot = big(snap.pot?.megaWei); mtarget = Number(snap.next?.megaAt) || t; }
  else { mpot = 0n; mtarget = t; }
  $("mega-eth").textContent = eth(mpot);
  $("mega-usd").textContent = usd(mpot) || " ";
  $("mega-when").textContent = mnote || when(mtarget);
  ticks.mega = mtarget;

  const parts = [];
  const list = tracker.list;
  if (list) parts.push(`${list.rows.length.toLocaleString()} wallets in the drum right now`);
  else if (snap && typeof snap.eligibleCount === "number") parts.push(`${snap.eligibleCount.toLocaleString()} wallets in the drum right now`);
  if (list) {
    let holders = 0;
    for (const s of list.state.values()) if (s.balance > 0n) holders++;
    parts.push(`${holders.toLocaleString()} holders`);
  } else if (snap && typeof snap.holders === "number") parts.push(`${snap.holders.toLocaleString()} holders`);
  $("in-drum").textContent = parts.join(" · ");
  tick();
}

// Chain re-reads: every 20 s, but every 60 s while a countdown target is in the past (waiting on the keeper or
// drand), so a stalled slot doesn't have every visitor polling the RPC. [finding 24]
let chainTimer = 0;
const crossed = new Set();
const anyPast = (t = now()) => (ticks.reg && ticks.reg <= t) || (ticks.mega && ticks.mega <= t);
function scheduleChain(ms) {
  clearTimeout(chainTimer);
  chainTimer = setTimeout(refreshChain, ms ?? (anyPast() ? 60_000 : 20_000));
}

function tick() {
  const t = now();
  setCountdown($("regular-cd"), ticks.regMode === "zero" ? 0 : ticks.reg - t);
  const m = Math.max(0, ticks.mega - t);
  $("mega-cd").textContent = m >= DAY ? `${Math.floor(m / DAY)}d ${pad(Math.floor((m % DAY) / 3600))}h ${pad(Math.floor((m % 3600) / 60))}m` : `${pad(Math.floor(m / 3600))}:${pad(Math.floor((m % 3600) / 60))}:${pad(m % 60)}`;
  // a countdown just ran out: re-read the chain once, soon; after that the slower cadence applies
  for (const [k, target] of [["r", ticks.reg], ["m", ticks.mega]]) {
    const key = `${k}${target}`;
    if (LIVE && target && target <= t && !crossed.has(key)) { crossed.add(key); scheduleChain(5_000); }
  }
  renderSwarmCooldown();
}

// ------------------------------------------------------------------ eligibility

async function checkWallet(raw) {
  const out = $("elig-out"), verdict = $("verdict");
  out.hidden = false;
  const set = (id, v) => ($(id).textContent = v);
  const ids = ["e-bal", "e-held", "e-mult", "e-weight", "e-wait", "e-odds"];
  ids.forEach((id) => set(id, "..."));
  set("e-note", "");
  verdict.className = "verdict";
  if (!isAddress(raw.trim(), { strict: false })) { verdict.className = "verdict no"; verdict.textContent = "That doesn't look like a wallet address."; ids.forEach((id) => set(id, "-")); return; }
  const a = getAddress(raw.trim());
  if (!LIVE || !S.chain) { verdict.className = "verdict wait"; verdict.textContent = LIVE ? "Still reading the chain. Try again in a moment." : "Not launched yet. Check back after launch."; return; }
  verdict.textContent = "Replaying the token's transfers...";
  const c = S.chain;
  try {
    // the same rules as the keeper's list (src/snapshot.js), from the same Transfer logs, at the chain's clock
    const list = await refreshList();
    const tSec = BigInt(S.chain?.blockTs ?? now());
    const key = a.toLowerCase();
    const excluded = excludeAll().includes(key);
    const s = list.state.get(key) ?? { balance: 0n, holdStart: 0n };
    const bal = s.balance, start = s.holdStart;
    const weight = excluded ? 0n : weightFor(bal, start, tSec);
    const held = bal > 0n && start <= tSec ? tSec - start : 0n;
    const mult = Number(multiplierWad(held)) / 1e18;

    set("e-bal", excluded ? "-" : `${tokens(bal)} ${C.ticker}`);
    set("e-held", bal > 0n ? fmtDur(Number(held)) : "-");
    set("e-mult", bal > 0n ? `${mult.toFixed(2)}x` : "-");
    set("e-weight", weight > 0n ? tokens(weight) : "0");

    const notes = [];
    if (excluded) {
      verdict.className = "verdict no";
      verdict.textContent = "This address can never win: it's the curve, the pool, the locker or one of Tombola's own contracts.";
      set("e-wait", "never"); set("e-odds", "0");
    } else if (bal < MIN_BALANCE) {
      verdict.className = "verdict no";
      verdict.textContent = bal === 0n ? "Not in the drum: this wallet holds none." : "Not in the drum yet: below the minimum.";
      set("e-wait", `needs ${tokens(MIN_BALANCE - bal)} more`); set("e-odds", "0");
    } else if (weight === 0n) {
      const wait = Number(ELIGIBLE_AFTER - held);
      verdict.className = "verdict wait"; verdict.textContent = `Almost: in the drum in ${fmtDur(wait)}.`;
      set("e-wait", fmtDur(wait)); set("e-odds", "0 until then");
    } else {
      verdict.className = "verdict yes"; verdict.textContent = "Yes! You're in the drum.";
      set("e-wait", "now");
    }

    // projection for the next draw
    if (S.launchTime && bal >= MIN_BALANCE && !excluded && start <= tSec) {
      const nextAt = BigInt(c.active[0] ? c.active[0].snapshotTime : nextSlot(0, Number(tSec)).at);
      const heldNext = nextAt > start ? nextAt - start : 0n;
      const multNext = Number(multiplierWad(heldNext)) / 1e18;
      if (c.active[0]) notes.push(`A draw is running on a snapshot taken at ${when(Number(nextAt))}; the list for it is already fixed.`);
      else if (heldNext >= ELIGIBLE_AFTER) notes.push(`If you keep holding, you'll be at ${multNext.toFixed(2)}x for the next drop (${when(Number(nextAt))}). Selling or sending resets the clock.`);
      else notes.push(`You won't have held 30 minutes by the next drop (${when(Number(nextAt))}), but you will for the one after.`);
    }
    notes.push(`Recomputed from ${list.transfers.toLocaleString()} transfers at block ${c.blockNumber}, with the keeper's rules.`);
    set("e-note", notes.join(" "));

    if (weight > 0n) {
      const total = list.totalWeight;
      if (total > 0n) {
        const p = Number((weight * 1_000_000n) / total) / 10_000;
        const oneIn = Number(total) / Number(weight);
        set("e-odds", `${p < 0.01 ? "<0.01" : p.toFixed(2)}% (1 in ${oneIn < 10 ? oneIn.toFixed(1) : Math.round(oneIn).toLocaleString()}) of ${list.rows.length.toLocaleString()} wallets`);
      } else set("e-odds", "-");
    }
  } catch (e) {
    verdict.className = "verdict no"; verdict.textContent = `Couldn't read the chain: ${e.shortMessage ?? e.message}`;
  }
}

// ------------------------------------------------------------------ winners

let shownWinners = "";

// The pool flag a row carries: the bot's poolFlag ("none" | "small"), the site's own ("unknown" too), or, for a row
// without one, "none" when no first buy is recorded (as the bot's posts read it). null means a buy was found.
function cardFlag(r) {
  if (["none", "small", "unknown"].includes(r.poolFlag)) return r.poolFlag;
  if (r.unknownBuy) return "unknown";
  return r.firstBuyAt == null && r.firstBuyTx == null ? "none" : null;
}
const FLAG_NOTE = {
  none: "Heuristic: no pool buy was found for this wallet before the draw, so its tokens may all have come by transfer. Check where they came from before trusting this win.",
  small: "Heuristic: this wallet bought under 10% of its balance from the pool before the draw; the rest came by transfer. Check where it came from before trusting this win.",
};

// Fills a ticket from a row. Snapshot rows are hints; after Verify the ticket is refilled from chain values. [finding 9]
function fillCard(li, r) {
  const id = Number(r.id);
  if (!Number.isSafeInteger(id) || id < 0) throw new Error(`bad draw id ${r.id}`);
  const rolled = r.kind === "rolled";
  const amount = BigInt(r.amountWei ?? 0); // throws on a malformed amount; the caller skips the row
  const winnerOk = typeof r.winner === "string" && isAddress(r.winner, { strict: false });
  if (!rolled && !winnerOk) throw new Error(`bad winner ${r.winner}`);
  // pool-buy tags are heuristics: "none" and "small" flag the card, "unknown" only notes it [R5 finding 15, R6 finding 9]
  const flag = rolled ? null : cardFlag(r);
  const noBuy = flag === "none";
  li.classList.toggle("flag", flag === "none" || flag === "small");
  li.classList.toggle("mega-t", r.track === "mega");
  li.querySelector(".t-round").textContent = `Draw #${id + 1}`;
  li.querySelector(".t-track").textContent = r.track === "mega" ? "Mega" : "Drop";
  li.querySelector(".t-amt").textContent = rolled ? `${eth(amount)} ETH rolled over` : `${eth(amount)} ETH`;
  const wa = li.querySelector(".t-wallet");
  wa.textContent = rolled ? "nobody eligible" : short(getAddress(r.winner));
  wa.title = rolled ? "" : getAddress(r.winner);
  const wHref = rolled ? null : explorerHref("address", r.winner);
  if (wHref) wa.href = wHref; else wa.removeAttribute("href");
  const tags = li.querySelector(".t-tags");
  tags.replaceChildren();
  if (r.verified) tags.append(h("span", { class: "tag", text: "from chain" }));
  if (noBuy) tags.append(h("span", { class: "tag tag-warn", text: "no pool buy found" }));
  else if (flag === "small") tags.append(h("span", { class: "tag tag-warn", text: "small pool buy" }));
  else if (flag === "unknown") tags.append(h("span", { class: "tag tag-warn", text: "buy unknown" }));
  const meta = [];
  if (Number.isFinite(Number(r.at)) && Number(r.at) > 0) meta.push(`${rolled ? "Rolled" : "Won"} ${when(Number(r.at))}`);
  if (!rolled) {
    if (r.heldSeconds !== undefined && r.heldSeconds !== null) meta.push(`held ${fmtDur(Number(r.heldSeconds) || 0)}`);
    meta.push(r.firstBuyAt ? `first bought ${when(Number(r.firstBuyAt))}` : noBuy ? "no pool buy found" : "first buy not found");
    let bw = null;
    try { bw = r.boughtWei === undefined || r.boughtWei === null ? null : BigInt(r.boughtWei); } catch { /* malformed: not shown */ }
    if (bw !== null && bw > 0n) meta.push(`${tokensText(bw)} bought from the pool`);
  }
  li.querySelector(".t-meta").textContent = meta.join(" · ");
  li.querySelector(".flag-note")?.remove();
  if (FLAG_NOTE[flag]) li.querySelector(".t-meta").after(h("p", { class: "flag-note", text: FLAG_NOTE[flag] }));
  const tx = li.querySelector(".t-tx");
  const validTx = typeof r.tx === "string" && TX_RE.test(r.tx);
  const tHref = validTx ? explorerHref("tx", r.tx) : null;
  if (tHref) { tx.href = tHref; tx.textContent = "Payout tx"; tx.removeAttribute("title"); }
  else { tx.removeAttribute("href"); tx.textContent = validTx ? `tx ${short(r.tx)}` : ""; tx.title = validTx ? r.tx : ""; }
}

function renderWinners(rows, source) {
  const key = JSON.stringify(rows.map((r) => [r?.id, r?.tx, r?.firstBuyTx, r?.amountWei, r?.winner, r?.track, r?.kind, r?.poolFlag, r?.boughtWei, r?.heldSeconds])) + source;
  if (key === shownWinners) return;
  shownWinners = key;
  const list = $("win-list");
  list.replaceChildren();
  if (!rows.length) { list.append(h("li", { class: "empty", text: LIVE ? "No drops yet. The first one's on the countdown." : "No drops yet." })); return; }
  const tpl = $("win-tpl");
  for (const r of rows.slice(0, 20)) {
    // one malformed row is skipped, not the whole list [finding 23]
    try {
      const li = tpl.content.firstElementChild.cloneNode(true);
      fillCard(li, r);
      li.querySelector(".t-verify").addEventListener("click", (ev) => runVerify(ev.currentTarget, li.querySelector(".checks"), r, li, source === "snapshot"));
      list.append(li);
    } catch (e) {
      console.warn("skipped a winner row", r, e);
      list.append(h("li", { class: "empty", text: `Skipped a malformed entry (${e.message}).` }));
    }
  }
}

// "Verify with your own RPC": an optional RPC URL used only for Verify. It must be on the same chain.
async function verifyClient() {
  const raw = ($("verify-rpc")?.value ?? "").trim();
  if (!raw) {
    let host = "";
    try { host = new URL(C.rpcUrl, location.href).host; } catch { /* keep the generic label */ }
    return { client: pub, label: host ? `the site's RPC (${host})` : "the site's RPC" };
  }
  let u;
  try { u = new URL(raw); } catch { throw new Error("that RPC URL isn't valid"); }
  // only origins this build's CSP lets the page reach; anything else would fail as a blocked fetch [R6 finding 16]
  if (CSP_ORIGINS) {
    const allowed = CSP_ORIGINS.filter((o) => o !== "'self'");
    if (!(allowed.includes(u.origin) || u.origin === location.origin)) throw new Error(`this site's security policy doesn't allow ${u.origin} (allowed: ${allowed.join(", ")}). Add it to extraConnect in config.js and rebuild, or run bot/pons/verify-draw.mjs`);
  } else if (u.protocol !== "https:" && !(u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) throw new Error("use an https RPC URL (or http on localhost)");
  const client = makeClient(u.href);
  const id = await client.getChainId();
  if (C.chainId && id !== Number(C.chainId)) throw new Error(`your RPC is on chain ${id}, expected ${C.chainId}`);
  return { client, label: u.host };
}

// [R10 Info 13] the verdict goes at the top of the checks, right under the Verify button, above the PASS lines (on a
// phone the list is thousands of pixels long), and is scrolled into view if it isn't on screen
function showSummary(box, el) {
  box.prepend(el);
  try { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch { /* old browsers: it is already at the top */ }
}

async function runVerify(btn, box, row, li, fromBot = false) {
  if (!LIVE || !S.chain) return;
  btn.disabled = true;
  btn.textContent = "Verifying...";
  box.hidden = false;
  box.replaceChildren();
  const progress = h("li", {}, h("span", { class: "badge b-run", text: "..." }), h("span", { text: "Fetching the draw" }));
  box.append(progress);
  const label = { pass: "PASS", fail: "FAIL", warn: "LOOK", info: "INFO" };
  const cls = { pass: "b-pass", fail: "b-fail", warn: "b-warn", info: "b-run" };
  const line = (c) => progress.before(h("li", { "data-status": c.status }, h("span", { class: `badge ${cls[c.status]}`, text: label[c.status] }), h("span", { text: c.text })));
  let via = "the RPC";
  try {
    const vc = await verifyClient();
    const client = vc.client;
    via = vc.label;
    line({ status: "info", text: `Reading the chain through ${via}` });
    const res = await verifyDraw({
      pub: client, draw: S.chain.draw, token: C.token, id: row.id, row, startBlock: C.startBlock || 0, exclude: excludeAll(), pools: pools(),
      onCheck: line,
      onProgress: (text) => (progress.lastChild.textContent = text),
    });
    progress.remove();
    if (res.chain && li) {
      // show what the chain says, whatever the snapshot said
      // the stronger of the bot's flag and this check's: a refill never clears a "none" or "small" the bot set
      const b = res.bought;
      const found = b && b.boughtWei > 0n;
      const poolFlag = strongerFlag(fromBot ? cardFlag(row) : null, b ? poolFlagOf(b) : "unknown");
      const shown = { ...res.chain, verified: true, firstBuyAt: found ? b.at : null, firstBuyTx: found ? b.tx : null, unknownBuy: poolFlag === "unknown", poolFlag, boughtWei: b ? b.boughtWei.toString() : null };
      try { fillCard(li, shown); } catch (e) { console.warn("couldn't refill the card", e); }
    }
    // a check that couldn't run (drand unreachable, junk calldata, an isValid error) is neither a pass nor a FAIL [R6 finding 10, R7 Info 12b]
    // an RPC refusal (such as eth_getLogs' 10,000-result cap) is "couldn't check", never FAILED [R8 finding 2]; the
    // summary names the RPC host, since everything but drand's relays came through it [R8 finding 9]
    // a relay/RPC conflict leads the summary and is never "try again later" [R9 finding 8]
    const [scls, text] = verifySummary(res, via);
    showSummary(box, h("li", { class: `summary ${scls}`, text }));
  } catch (e) {
    // the RPC couldn't be reached or refused a read: not evidence about the draw [R8 finding 2]
    progress.remove();
    showSummary(box, h("li", { class: "summary unsure", text: `Couldn't check this draw through ${via}: ${e.shortMessage ?? e.message}. This is not a FAIL. Try again, or verify with your own RPC or bot/pons/verify-draw.mjs.` }));
  }
  btn.disabled = false;
  btn.textContent = "Verify again";
}

// ------------------------------------------------------------------ swarm

function swarmBlock(sc) {
  if (!sc) return [];
  const status = sc.status ?? "none";
  const kids = [];
  const label = { none: "never run", pending: "checking", attested: "attested", failed: "failed" }[status] ?? status;
  kids.push(h("p", {}, h("span", { class: `status st-${status}`, text: label }), " ", sc.lastAt ? `Last asked ${ago(sc.lastAt)} (${when(sc.lastAt)})` : "No swarm check yet."));
  if (sc.question) kids.push(h("p", { class: "fine", text: `Question: ${sc.question}` }));
  if (sc.answer !== undefined && sc.answer !== null && status !== "pending") {
    let a = typeof sc.answer === "string" ? sc.answer : JSON.stringify(sc.answer);
    if (a.length > 500) a = `${a.slice(0, 500)}...`;
    kids.push(h("p", { text: `Answer: ${a}` }));
  }
  const url = sc.attestationUrl && safeUrl(sc.attestationUrl);
  if (url) kids.push(h("p", {}, h("a", { href: url, target: "_blank", rel: "noopener", text: "See the attestation" })));
  return kids;
}

function renderSwarm() {
  const sc = S.snap?.swarmCheck;
  $("swarm-last").replaceChildren(...swarmBlock(sc));
  $("proof-swarm").replaceChildren(...(sc ? [h("p", {}, h("strong", { text: "Latest swarm check" })), ...swarmBlock(sc)] : []));
  renderSwarmCooldown();
}

let swarmBusy = false;
function renderSwarmCooldown() {
  const btn = $("swarm-btn"), cd = $("swarm-cd");
  const sc = S.snap?.swarmCheck;
  if (!botBase || !LIVE) { btn.disabled = true; cd.textContent = LIVE ? "Swarm checks open once the bot is live." : "Opens after launch."; return; }
  if (!sc) { btn.disabled = true; cd.textContent = "Waiting for the bot's snapshot..."; return; }
  const left = (sc.nextAllowedAt ?? 0) - now();
  if (swarmBusy) { btn.disabled = true; return; }
  if (left > 0) { btn.disabled = true; cd.textContent = `Next check allowed in ${pad(Math.floor(left / 3600))}:${pad(Math.floor((left % 3600) / 60))}:${pad(left % 60)}`; }
  else { btn.disabled = false; cd.textContent = "Ready. One press checks for everyone."; }
}

async function askSwarm() {
  swarmBusy = true;
  const btn = $("swarm-btn"), cd = $("swarm-cd");
  btn.disabled = true;
  cd.textContent = "Asking the swarm...";
  try {
    // A simple POST with no body or custom headers, so no CORS preflight is needed.
    const r = await fetch(`${botBase}/swarm-check`, { method: "POST" });
    let j = null;
    try { j = await r.json(); } catch { /* not JSON */ }
    const sc = j?.swarmCheck ?? (j && "status" in j && "nextAllowedAt" in j ? j : null);
    if (S.snap) {
      if (sc) S.snap.swarmCheck = { ...S.snap.swarmCheck, ...sc };
      else if (j?.nextAllowedAt) S.snap.swarmCheck = { ...S.snap.swarmCheck, nextAllowedAt: j.nextAllowedAt };
    }
    if (r.status === 429) cd.textContent = "Someone just asked. Cooldown running.";
    else if (!r.ok) cd.textContent = `The bot said no (HTTP ${r.status}${j?.error ? `: ${j.error}` : ""}).`;
    else cd.textContent = "Asked. The answer shows up here once the swarm attests.";
  } catch (e) {
    cd.textContent = `Couldn't reach the bot: ${e.message}`;
  }
  swarmBusy = false;
  renderSwarm();
  setTimeout(refreshSnapshot, 4000);
}

// ------------------------------------------------------------------ proofs and address

function renderProofs() {
  const c = S.chain;
  const b = $("backed"), bt = $("backed-text");
  b.classList.remove("ok", "bad");
  if (!LIVE) { bt.textContent = "The draw contract goes live at launch."; }
  else if (c) {
    const owed = c.potRegular + c.potMega + c.reserved + c.unclaimedTotal;
    b.classList.add(c.solvent ? "ok" : "bad");
    bt.replaceChildren(c.solvent ? "Pots fully backed" : "The draw contract holds less than it owes", h("small", { text: `TombolaDraw.solvent(): holds ${eth(c.held)} ETH, owes ${eth(owed)} ETH (both pots, committed prizes and unclaimed payouts)${c.pending > 0n ? `; ${eth(c.pending)} ETH of fees waiting in Pons' escrow for harvest()` : ""}` }));
  } else bt.textContent = "Can't read the draw contract right now.";

  const rows = [];
  const add = (k, a, note) => a && !same(a, ZERO) && rows.push(h("li", {}, h("span", { class: "k", text: k }), h("span", { class: "v" }, explorerLink("address", a)), note ? h("span", { class: "fine", text: note }) : null));
  add("Draw (TombolaDraw)", C.draw, "Holds the pots and the draw ledger, pays winners. No owner, no upgrade, no withdraw.");
  add("Splitter (TombolaSplitter)", c?.splitter || C.splitter, "Pons pays the creator tax here; harvest() splits it 70.18% / 17.54% / 12.28% into the pots and the team wallet: 4% / 1% / 0.7% of every trade.");
  add("Token", C.token, "Pons' plain ERC-20. The draw list is rebuilt from its Transfer logs.");
  add("Pons bonding curve", C.curve, "Where the token trades before graduation. Never in the drum.");
  add("Randomness beacon (DrandBeacon)", c?.beacon || C.beacon, "Checks drand's signature on-chain.");
  if (!rows.length) rows.push(h("li", {}, h("span", { class: "k", text: "Contracts" }), h("span", { class: "v", text: "Published at launch." })));
  $("addr-list").replaceChildren(...rows);

  const live = LIVE && C.token && !same(C.token, ZERO);
  $("ca-addr").textContent = live ? getAddress(C.token) : "Not launched yet";
  $("ca-copy").disabled = !live;
}

async function copyCA() {
  const text = $("ca-addr").textContent;
  const btn = $("ca-copy");
  try { await navigator.clipboard.writeText(text); }
  catch {
    const r = document.createRange(); r.selectNodeContents($("ca-addr"));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    document.execCommand("copy");
  }
  btn.textContent = "Copied!";
  setTimeout(() => (btn.textContent = "Copy"), 1600);
}

// ------------------------------------------------------------------ loop

function renderFresh() {
  const parts = [];
  if (S.chainAt) parts.push(`Chain read ${ago(S.chainAt)}`);
  else if (S.chainErr) parts.push(`Chain: ${S.chainErr}`);
  if (tracker.at) parts.push(`draw list replayed ${ago(tracker.at)} from ${tracker.logs.length.toLocaleString()} transfers`);
  if (S.snap?.updatedAt) parts.push(`bot snapshot updated ${ago(S.snap.updatedAt)}`);
  else if (S.snapNote && botBase) parts.push(`bot snapshot unavailable (${S.snapNote}), using the chain only`);
  $("freshness").textContent = parts.join(" · ");
}

async function refreshChain() {
  if (!LIVE) { renderAll(); return; }
  scheduleChain(); // the next read, even if this one throws
  try {
    S.chain = await loadChain();
    S.chainAt = now();
    S.chainErr = "";
  } catch (e) {
    S.chainErr = e.shortMessage ?? e.message;
    console.warn("chain read failed", e);
  }
  renderAll();
  // the draw list: replayed on the first read, then every 2 minutes or when a draw settles
  if (S.chain && (!tracker.at || now() - tracker.at >= 120 || S.listFor !== S.chain.drawCount)) {
    try { await refreshList(); S.listFor = S.chain.drawCount; renderAll(); } catch (e) { console.warn("draw list replay failed", e); }
  }
  // winners from the chain only when there is no snapshot
  if (!S.snap && S.chain && S.chainWinnersFor !== S.chain.drawCount) {
    try { renderWinners(await winnersFromChain(S.chain), "chain"); S.chainWinnersFor = S.chain.drawCount; } catch (e) { console.warn("Settled scan failed", e); }
  }
}

async function refreshSnapshot() {
  try { S.snap = await loadSnapshot(); S.snapNote = S.snap ? "" : "no bot configured"; }
  catch (e) { S.snap = null; S.snapNote = e.message; }
  try {
    if (S.snap) renderWinners((Array.isArray(S.snap.winners) ? [...S.snap.winners] : []).filter((r) => r && typeof r === "object").sort((a, b) => Number(b.id) - Number(a.id)), "snapshot");
  } catch (e) { console.warn("winners render failed", e); }
  renderAll();
}

function renderAll() {
  renderHero();
  feedCage();
  renderSwarm();
  renderProofs();
  renderFresh();
}

// The drum (src/cage.js). `?demo=1` forces it live with test buttons, whatever the config says.
let cage = null, tannoy = null;
const DEMO = new URLSearchParams(location.search).get("demo") === "1";
function initCage() {
  const host = $("drum");
  if (!host || typeof host.querySelector("canvas")?.getContext !== "function") return;
  cage = createCage(host, {
    onEvent: (kind, label) => tannoy?.event(kind, label ? { who: label.who, amount: label.amount } : {}),
  });
  if (!DEMO) return;
  $("drum-demo").hidden = false;
  $("demo-buy").addEventListener("click", () => cage.buy(1));
  $("demo-buy10").addEventListener("click", () => cage.buy(10));
  $("demo-sell").addEventListener("click", () => cage.sell(1));
  $("demo-draw").addEventListener("click", () => cage.draw({ who: "0x15d3...6A65", amount: "0.9920 ETH" }));
  cage.setLive(true);
  cage.setCount(60);
  $("plate-wallets").textContent = "demo: 60 wallets";
}
function feedCage() {
  if (!cage || DEMO) return;
  cage.setLive(LIVE);
  // one ball per holder (Fish, 21 Oct): every wallet with a balance, infra excluded. Eligibility (the 30-minute gate)
  // stays in the line under the ribbon; the bot's holder count until the Transfer replay is in
  let n = null;
  if (tracker.list) { n = 0; for (const s of tracker.list.state.values()) if (s.balance > 0n) n++; }
  else if (S.snap && typeof S.snap.holders === "number") n = S.snap.holders;
  if (LIVE && n !== null) { cage.setCount(n); $("plate-wallets").textContent = `${n.toLocaleString()} holder${n === 1 ? "" : "s"}`; }
}

function init() {
  document.querySelectorAll("[data-ticker]").forEach((el) => (el.textContent = C.ticker));
  document.querySelectorAll("[data-buy]").forEach((el) => { if (C.buyUrl) el.href = C.buyUrl; });
  $("min-bal").textContent = tokens(MIN_BALANCE);
  initFair();
  initCage();
  const music = initMusic($("music-btn"));
  tannoy = initAnnouncer($("tannoy"), { voice: C.voice || "crude", ticker: C.ticker, music, isLive: () => DEMO || LIVE });
  const curtain = initCurtain($("curtain"), { voice: C.voice || "crude", onOpen: (greeting) => { music?.start?.(); if (greeting) tannoy?.speak(greeting); tannoy?.start(); } });
  if (!curtain) tannoy?.start();
  $("elig-form").addEventListener("submit", (e) => { e.preventDefault(); checkWallet($("wallet").value); });
  $("swarm-btn").addEventListener("click", askSwarm);
  $("ca-copy").addEventListener("click", copyCA);
  renderAll();
  refreshSnapshot().finally(refreshChain); // a bad snapshot never skips the first chain read [finding 23]
  loadPrice().then(renderHero);
  setInterval(tick, 1000);
  setInterval(refreshSnapshot, 60_000);
  setInterval(() => loadPrice().then(renderHero), 300_000);
  setInterval(renderFresh, 5_000);
}

init();
