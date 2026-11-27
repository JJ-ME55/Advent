// What the bot says. Watches DRAWS_DIR for new results and pot changes and posts cards to X:
//   - a door opened: how much is waiting for how many winners, "open yours", within a minute of settlement. No names:
//     nobody knows they've won until they open their door on the site;
//   - a claim: when a winner opens and claims, a card with the wallet shortened and the tx link;
//   - a countdown every COUNTDOWN_EVERY (default 4 h): the pot so far and the time to the door;
//   - the jackpot once a day.
// DRY_RUN=1 (default) writes the text and PNG to POSTS_DIR instead of posting. State in STATE_FILE so nothing posts
// twice. Needs X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET when DRY_RUN=0.
//   node src/poster.mjs
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { renderPng, openedSvg, claimSvg, countdownSvg, jackpotSvg, fmtSol, shortAddr, fmtDuration } from "./cards/cards.mjs";
import { uploadImage, postTweet } from "./x.mjs";
import { doorTime, nextDoor, LAST_DOOR } from "./doors.mjs";

const DRAWS_DIR = process.env.DRAWS_DIR ?? "draws";
const POSTS_DIR = process.env.POSTS_DIR ?? "posts";
const STATE_FILE = process.env.POSTER_STATE_FILE ?? "state/poster-state.json";
const DRY = process.env.DRY_RUN !== "0";
const TICK = Number(process.env.POSTER_TICK_SECONDS ?? 20);
const COUNTDOWN_EVERY = Number(process.env.COUNTDOWN_EVERY_SECONDS ?? 4 * 3600);
const SITE = process.env.SITE_URL ?? "https://advent.lol";
const TICKER = process.env.TICKER ?? "$ADVENT";
const EXPLORER = process.env.EXPLORER ?? "https://solscan.io/tx/";
mkdirSync(POSTS_DIR, { recursive: true }); mkdirSync(join(STATE_FILE, ".."), { recursive: true });
const log = (...a) => console.log(new Date().toISOString(), ...a);
const now = () => Math.floor(Date.now() / 1000);

let state = { posted: {}, lastCountdown: 0, lastJackpot: 0 };
try { state = { ...state, ...JSON.parse(readFileSync(STATE_FILE, "utf8")) }; } catch { /* first run */ }
const save = () => { writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(state, null, 1)); renameSync(`${STATE_FILE}.tmp`, STATE_FILE); };
const readJson = (f, d = null) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return d; } };

/** The text for each post. Short, one link, no hashtag soup. */
export const lines = {
  opened: ({ door, sol, winners, eligible }) => `Door ${door} is open: ${sol} SOL waiting for ${winners} ${winners === 1 ? "winner" : "winners"}. Open yours!\n\n${eligible} wallets were on Santa's Nice List. Nobody knows who won until they open their door. Drawn with drand, list and maths public.\n\n${SITE}/door/${door}`,
  claim: ({ door, sol, wallet, signature, kind }) => `${kind === "bonus" ? `Bonus Box ${door}` : `Door ${door}`}: ${shortAddr(wallet)} opened ${kind === "bonus" ? "the box" : "their door"} and claimed ${sol} SOL.\n\n${EXPLORER}${signature}`,
  countdown: ({ door, sol, eligible, opensIn }) => `Door ${door} opens in ${opensIn}.\n\n${sol} SOL in it so far, ${eligible} wallets on Santa's Nice List. Hold ${TICKER} for 30 minutes before the snapshot and you're on it; hold longer, more tickets.\n\n${SITE}`,
  jackpot: ({ sol, daysLeft }) => `The Christmas Day door is holding ${sol} SOL. ${daysLeft} days to go; 10% of every door goes in.\n\n${SITE}/door/25`,
};

async function publish(key, text, svg) {
  const png = await renderPng(svg);
  if (DRY) {
    writeFileSync(join(POSTS_DIR, `${key}.txt`), text); writeFileSync(join(POSTS_DIR, `${key}.png`), png);
    log(`dry-run: wrote ${key}.txt and ${key}.png`);
  } else {
    const mediaId = await uploadImage(process.env, png);
    const id = await postTweet(process.env, text, mediaId);
    log(`posted ${key}: ${id}`);
  }
  state.posted[key] = now(); save();
}

async function tick() {
  const snap = readJson(join(DRAWS_DIR, "snapshot.json"));
  if (!snap) return;
  // 1. doors that opened since the last tick, and claims since then
  for (const [d, info] of Object.entries(snap.doors ?? {})) {
    if (!info.settled) continue;
    const doc = readJson(join(DRAWS_DIR, `door-${d}.json`));
    if (!doc?.result?.winners?.length) continue;
    if (!state.posted[`opened-${d}`]) {
      const args = { door: Number(d), sol: fmtSol(doc.pot), winners: doc.result.winners.length, eligible: doc.rows.length };
      await publish(`opened-${d}`, lines.opened(args), openedSvg({ ...args, ticker: TICKER, site: SITE.replace(/^https?:\/\//, "") }));
    }
    for (const kind of ["door", "bonus"]) {
      for (const w of (kind === "door" ? doc.result.winners : doc.result.bonus) ?? []) {
        if (!w.claimed || !w.account || state.posted[`claim-${d}-${kind}-${w.k}`]) continue;
        const a = { door: Number(d), sol: fmtSol(w.lamports), wallet: w.account, signature: w.claimSignature, kind };
        await publish(`claim-${d}-${kind}-${w.k}`, lines.claim(a), claimSvg({ door: a.door, sol: a.sol, wallet: shortAddr(w.account), kind, ticker: TICKER }));
      }
    }
  }
  // 2. the countdown
  const t = now(), next = snap.nextDoor;
  if (next && next <= LAST_DOOR && t - state.lastCountdown >= COUNTDOWN_EVERY && doorTime(next) - t > 600) {
    const eligible = snap.eligibleNow ?? null;
    await publish(`countdown-${next}-${t}`, lines.countdown({ door: next, sol: fmtSol(snap.pots.door), eligible: eligible ?? "the", opensIn: fmtDuration(doorTime(next) - t) }), countdownSvg({ door: next, sol: fmtSol(snap.pots.door), eligible: eligible ?? "?", opensIn: fmtDuration(doorTime(next) - t), ticker: TICKER }));
    state.lastCountdown = t; save();
  }
  // 3. the jackpot, daily
  if (t - state.lastJackpot >= 86400 && BigInt(snap.pots.xmas ?? 0) > 0n) {
    const daysLeft = Math.max(0, Math.ceil((doorTime(25) - t) / 86400));
    await publish(`jackpot-${t}`, lines.jackpot({ sol: fmtSol(snap.pots.xmas), daysLeft }), jackpotSvg({ sol: fmtSol(snap.pots.xmas), daysLeft, ticker: TICKER }));
    state.lastJackpot = t; save();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  log(`poster ${DRY ? "DRY-RUN" : "LIVE"} on ${DRAWS_DIR}`);
  if (process.env.ONCE === "1") { await tick(); process.exit(0); }
  for (;;) { try { await tick(); } catch (e) { log(`poster: ${e.message}`); } await new Promise((r) => setTimeout(r, TICK * 1000)); }
}
