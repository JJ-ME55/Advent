// Decides what to post this tick, words it, renders its card, and sends it (or logs it in dry-run).
import { pick, fill, NO_BUY_FLAG, SMALL_BUY_FLAG, ROOT_FLAG } from "./lines.js";
import { fmtEth, shortAddr, fmtDuration, fmtUtc, fmtInt, hash32 } from "./format.js";
import { claimPost, finishPost, skipPost, postDone, lastPostAt, getState, setState, pinPostText } from "./db.js";
import { winnerSvg, potSvg, countdownSvg, renderPng } from "./cards.js";
import { uploadImage, postTweet } from "./x.js";

const HOUR = 3600;
const PAID_MILESTONES = [1, 10, 100, 1000];
const HOLDER_MILESTONES = [100, 1000, 10000];

/**
 * Builds the list of posts due now, highest priority first.
 * ctx: { env, now, info, live, totals, holders, caughtUp, swarmResult }
 */
export async function duePosts(ctx) {
  const { env, now, info, live, totals, holders } = ctx;
  const maxAge = Number(env.POST_MAX_AGE_MINUTES ?? 180) * 60;
  const out = [];
  const ticker = env.TICKER || "$TICKER";
  const base = { ticker, eligible: fmtInt(holders?.eligibleCount ?? 0), holders: fmtInt(holders?.holders ?? 0) };

  // 1. winners and rollovers, right after each drop (a draw the keeper settled or rolled over)
  const recent = (await env.DB.prepare("SELECT * FROM drops WHERE status IN ('paid', 'rolled') AND at >= ? ORDER BY id").bind(now - maxAge).all()).results;
  for (const d of recent) {
    if (d.status === "paid") {
      const v = { ...base, round: d.id + 1, eth: fmtEth(d.amount_wei), wallet: shortAddr(d.winner), held: fmtDuration(d.held_seconds), tx: d.tx };
      out.push({
        key: `win:${d.id}`, kind: d.track === "mega" ? "winnerMega" : "winner", vars: v,
        // tx is null only for a drop rebuilt from getDrop because no node served its log (round-6 finding 6)
        suffix: [d.tx ? `Tx ${d.tx}` : null, d.root_ok === 0 ? ROOT_FLAG : buyFlag(d)].filter(Boolean).join("\n"),
        card: () => winnerSvg({ ...v, mega: d.track === "mega" }),
      });
    } else {
      out.push({ key: `roll:${d.id}`, kind: "rollover", vars: { ...base, round: d.id + 1, eth: fmtEth(d.amount_wei) }, suffix: d.tx ? `Tx ${d.tx}` : "" });
    }
  }

  // 2. the swarm check's result
  if (ctx.swarmResult) {
    const s = ctx.swarmResult.s;
    const kind = { fair: "swarmFair", unfair: "swarmUnfair", noanswer: "swarmNoAnswer", incomplete: "swarmIncomplete" }[ctx.swarmResult.kind];
    // draws = Settled rows inside the absolute block window that was paid for (never rollovers)
    if (kind) out.push({ key: `swarm:${s.lastAt}`, kind, vars: { ...base, draws: fmtInt(s.draws ?? 0), reason: ctx.swarmResult.reason ?? "the check failed" } });
  }

  if (!info.launchTime || !live) return out;

  // 3. milestones, only once the scan has caught up so a backfill doesn't post history
  if (ctx.caughtUp) {
    const ms = [];
    const paidEth = Number(BigInt(totals.paidWei) / 10n ** 15n) / 1000;
    const first = await env.DB.prepare("SELECT * FROM drops WHERE status = 'paid' ORDER BY id LIMIT 1").first();
    if (first) ms.push({ key: "ms:first-drop", kind: "milestoneFirst", vars: { ...base, round: first.id + 1, eth: fmtEth(first.amount_wei), wallet: shortAddr(first.winner) } });
    for (const n of PAID_MILESTONES) if (paidEth >= n) ms.push({ key: `ms:paid-${n}`, kind: "milestonePaid", vars: { ...base, n: fmtInt(n) } });
    for (const n of HOLDER_MILESTONES) if ((holders?.holders ?? 0) >= n) ms.push({ key: `ms:holders-${n}`, kind: "milestoneHolders", vars: { ...base, n: fmtInt(n) } });
    const init = await getState(env, "milestonesInit");
    if (!init) {
      // first run: anything already true happened before the bot existed
      for (const m of ms) await skipPost(env, m.key, m.kind, now);
      await setState(env, "milestonesInit", now);
    } else out.push(...ms);
  }

  const pot = fmtEth(live.potRegular), mega = fmtEth(live.potMega);

  // 4. countdowns, 1 hour before a drop (not during the hourly launch ramp, slots 1-6)
  if (live.activeR === 0 && live.nextR >= 7 && live.potRegular > 0n && within(now, live.regularAt - HOUR, 20 * 60)) {
    out.push({ key: `cd:r:${live.nextR}`, kind: "countdown", vars: { ...base, pot }, card: () => countdownSvg({ pot, eligible: base.eligible, ticker }) });
  }
  if (live.activeM === 0 && live.potMega > 0n && within(now, live.megaAt - HOUR, 20 * 60)) {
    out.push({ key: `cd:m:${live.nextM}`, kind: "countdownMega", vars: { ...base, mega }, card: () => countdownSvg({ pot: mega, eligible: base.eligible, mega: true, ticker }) });
  }

  // 5. pot building, 1 hour after a regular drop from slot 6 on (no pot posts between the hourly drops)
  const lastReg = await env.DB.prepare("SELECT * FROM drops WHERE track = 'regular' AND status IN ('paid', 'rolled') ORDER BY id DESC LIMIT 1").first();
  if (lastReg && lastReg.slot >= 6 && within(now, lastReg.at + HOUR, 30 * 60) && live.regularAt > now + 30 * 60) {
    const next = fmtUtc(live.regularAt);
    out.push({ key: `pot:${lastReg.id}`, kind: "pot", vars: { ...base, pot, next }, card: () => potSvg({ pot, eligible: base.eligible, next, ticker }) });
  }

  // 6. about STATS_PER_DAY random stat posts, at seeded times that differ every day
  const stat = await statDue(ctx, base, { pot, mega });
  if (stat) out.push(stat);
  return out;
}

const within = (now, start, len) => now >= start && now < start + len;

/** The heuristic provenance note for a winner post, or null (finding 15). */
function buyFlag(d) {
  if (d.pool_flag === "small") return SMALL_BUY_FLAG;
  if (d.pool_flag === "none") return NO_BUY_FLAG;
  if (d.pool_flag == null && !d.first_buy_tx) return NO_BUY_FLAG;
  return null;
}

async function statDue(ctx, base, { mega }) {
  const { env, now, info, live, totals } = ctx;
  if (!ctx.caughtUp) return null;
  const per = Number(env.STATS_PER_DAY ?? 4);
  const day = Math.floor(now / 86400);
  const slotLen = 86400 / per;
  for (let n = 0; n < per; n++) {
    const h = hash32(`${env.STATS_SEED ?? "tombola"}:${day}:${n}`);
    const at = day * 86400 + n * slotLen + (h % (slotLen - 2 * HOUR)) + HOUR / 2;
    if (!within(now, at, 30 * 60)) continue;
    // keep clear of drop-time posts
    if (Math.abs(live.regularAt - now) < 20 * 60 || now - (await lastPostAt(env)) < 15 * 60) return null;
    const options = ["statContract", "statMega", "statHolders"];
    if (totals.draws > 0) options.push("statTotalPaid", "statBiggest");
    const last = await getState(env, "lastStat");
    const pool = options.filter((o) => o !== last);
    const kind = pool[h % pool.length];
    return {
      key: `stat:${day}:${n}`, kind, onSent: () => setState(env, "lastStat", kind),
      vars: { ...base, total: fmtEth(totals.paidWei), draws: fmtInt(totals.draws), biggest: fmtEth(totals.biggestWei), mega, megaIn: fmtDuration(live.megaAt - now), ca: info.token },
    };
  }
  return null;
}

/** Words, renders and sends (or logs) up to MAX_POSTS_PER_TICK posts. */
export async function sendPosts(env, now, posts, log) {
  const max = Number(env.MAX_POSTS_PER_TICK ?? 3);
  const sent = [];
  const rotation = await getState(env, "lineRotation", {});
  for (const p of posts) {
    if (sent.length >= max) break;
    if (await postDone(env, p.key)) continue;
    if (!(await claimPost(env, p.key, p.kind, now))) continue;
    const { index, line } = pick(p.kind, rotation[p.kind]);
    let fresh = fill(line, p.vars);
    if (p.suffix) fresh += `\n\n${p.suffix}`;
    if (fresh.length > 280) fresh = fresh.slice(0, 279) + "…";
    // a retry reuses the first attempt's words, so X's duplicate check can catch a double post
    const text = await pinPostText(env, p.key, fresh);
    if (text === fresh) rotation[p.kind] = index;
    let png = null;
    try {
      if (p.card) png = await renderPng(p.card());
    } catch (e) {
      log(`card render failed for ${p.key}: ${e.message}`);
    }
    if (env.DRY_RUN === "1") {
      log(`DRY RUN post [${p.key}] (${text.length} chars)${png ? ` + card ${png.length} bytes` : ""}:\n${text}`);
      if (png && env.PUBLIC) await env.PUBLIC.put(`dry:img:${p.key}`, png, { expirationTtl: 7 * 86400 });
      await finishPost(env, p.key, "dry", { text });
      sent.push({ key: p.key, text, card: !!png });
      if (p.onSent) await p.onSent();
      continue;
    }
    try {
      let mediaId = null;
      if (png) {
        try {
          mediaId = await uploadImage(env, png);
        } catch (e) {
          log(`image upload failed for ${p.key}, posting text only: ${e.message}`);
        }
      }
      const id = await postTweet(env, text, mediaId);
      await finishPost(env, p.key, "sent", { text, tweetId: id });
      log(`posted [${p.key}] tweet ${id}`);
      sent.push({ key: p.key, text, tweetId: id });
      if (p.onSent) await p.onSent();
    } catch (e) {
      if (e.ambiguous) {
        // X may have created the tweet (timeout, network error, 5xx): leave it "sending", which is
        // never retried. Missing one post is better than posting it twice.
        await finishPost(env, p.key, "sending", { text, error: `ambiguous: ${e.message}`.slice(0, 500) });
        log(`post outcome unknown [${p.key}], not retrying: ${e.message}`);
      } else {
        await finishPost(env, p.key, "failed", { text, error: e.message.slice(0, 500) });
        log(`post failed [${p.key}]: ${e.message}`);
      }
    }
  }
  if (sent.length) await setState(env, "lineRotation", rotation);
  return sent;
}
