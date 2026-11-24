// The drum: a 2D tombola cage drawn on a canvas, with Matter.js running the balls inside it.
// One ball per wallet in the draw (capped at `cap` visible balls). A buy rolls a ball down the chute into the
// cage, a sell drops one out of the hatch at the bottom, a draw spins the rotor up and spits the winner into
// the tray. Pure presentation: nothing here reads the chain. main.js feeds it through the returned API.
import Matter from "matter-js";

const { Engine, Bodies, Body, Composite } = Matter;

const COLORS = [
  { fill: "#c8271c", text: "#fff7e6" }, // red
  { fill: "#e5a92b", text: "#2c140d" }, // gold
  { fill: "#1f7a74", text: "#fff7e6" }, // teal
  { fill: "#1f7a3c", text: "#fff7e6" }, // green
  { fill: "#fff7e6", text: "#2c140d" }, // paper
  { fill: "#2c140d", text: "#fff7e6" }, // ink
];
const INK = "#2c140d", RED = "#c8271c", RED_DEEP = "#8f1a14", GOLD = "#e5a92b", PAPER = "#fff7e6", PAPER_DEEP = "#fbefd5";
const ENTRY_GROUP = -2, EXIT_GROUP = -3;
const ENTRY_WIDE = -Math.PI / 4, ENTRY_NARROW = -Math.PI * 0.39; // top-right; nearer the top on phones so the chute has room
const EXIT_ANGLE = Math.PI / 2; // bottom
const STEP = 1000 / 60;
const VANES = 4;
const IDLE_OMEGA = 0.35; // rad/s, one turn every 18 s
const DRAW_OMEGA = 3.2;
const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Mounts the drum into `host` (a positioned element holding the canvas and the plate overlay).
 * Returns { setLive, setCount, buy, sell, draw, count, destroy }.
 */
export function createCage(host, { canvas, plate, onCount, onEvent } = {}) {
  const cv = canvas ?? host.querySelector("canvas");
  const ctx = cv.getContext("2d");
  const engine = Engine.create({ enableSleeping: false });
  engine.gravity.y = 1;
  const world = engine.world;

  const S = {
    live: false,
    W: 0, H: 0, cx: 0, cy: 0, R: 0, plateR: 0, ballR: 10, cap: 300, gapHalf: 0,
    balls: [], // { body, color, n, state, since, label }
    target: 0, // wanted ball count (after cap)
    pour: 0, // balls still to spawn directly inside
    buyQueue: 0, lastBuyAt: 0,
    sellQueue: 0, exiting: null,
    rotor: null, rotorAngle: 0, omega: IDLE_OMEGA, spinUntil: 0,
    drawPending: null, winner: null, winnerUntil: 0,
    statics: [], tray: null,
    seq: 0, frame: 0, last: 0, acc: 0, raf: 0,
    confetti: [],
  };

  // ---------- geometry and the static world ----------
  function layout() {
    const W = Math.max(280, Math.round(host.clientWidth));
    const narrow = W < 700;
    const R = narrow ? Math.round((W - 40) / 2) : Math.min(260, Math.round(W * 0.27));
    const ballR = Math.max(6, Math.min(11, Math.round(R / 26)));
    const plateR = Math.round(R * (W < 380 ? 0.5 : 0.44)); // a touch bigger on the narrowest phones so the plate text fits
    const cx = Math.round(W / 2);
    const cy = R + (narrow ? 56 : 70);
    const H = cy + R + 96;
    const annulus = Math.PI * ((R - ballR) ** 2 - (plateR + ballR) ** 2);
    const cap = Math.max(100, Math.min(300, Math.floor((annulus * 0.5) / (Math.PI * ballR * ballR))));
    Object.assign(S, { W, H, cx, cy, R, plateR, ballR, cap, gapHalf: Math.asin((1.7 * ballR) / R), entry: narrow ? ENTRY_NARROW : ENTRY_WIDE });
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    host.style.setProperty("--cx", `${cx}px`);
    host.style.setProperty("--cy", `${cy}px`);
    host.style.setProperty("--plate", `${plateR * 2}px`);
    host.style.height = `${H}px`;
  }

  function buildStatics() {
    for (const b of S.statics) Composite.remove(world, b);
    S.statics = [];
    const { cx, cy, R, ballR, gapHalf, plateR } = S;
    const add = (b) => { S.statics.push(b); Composite.add(world, b); return b; };
    const inGap = (a, g) => Math.abs(Math.atan2(Math.sin(a - g), Math.cos(a - g))) < gapHalf;

    // rim: chord segments with a gap for the entry and the exit
    const N = 72, rr = R + 4;
    const chord = (2 * Math.PI * rr) / N + 2;
    for (let i = 0; i < N; i++) {
      const a = ((i + 0.5) / N) * 2 * Math.PI;
      if (inGap(a, S.entry) || inGap(a, EXIT_ANGLE)) continue;
      add(Bodies.rectangle(cx + rr * Math.cos(a), cy + rr * Math.sin(a), chord, 8, { isStatic: true, angle: a + Math.PI / 2, friction: 0.05 }));
    }
    // lids over the gaps: a ball passes only while it carries the lid's group
    const lidLen = 2 * rr * Math.sin(gapHalf) + 6;
    for (const [a, group] of [[S.entry, ENTRY_GROUP], [EXIT_ANGLE, EXIT_GROUP]]) {
      add(Bodies.rectangle(cx + rr * Math.cos(a), cy + rr * Math.sin(a), lidLen, 8, { isStatic: true, angle: a + Math.PI / 2, collisionFilter: { group } }));
    }
    // the chute: a ramp from the top-right corner to just inside the entry gap
    const ex = cx + (R - ballR * 0.6) * Math.cos(S.entry), ey = cy + (R - ballR * 0.6) * Math.sin(S.entry);
    const sx = S.W - (S.W < 700 ? 34 : 26), sy = S.W < 700 ? 40 : 18;
    const len = Math.hypot(ex - sx, ey - sy), ang = Math.atan2(ey - sy, ex - sx);
    S.ramp = { sx, sy, ex, ey, len, ang };
    add(Bodies.rectangle((sx + ex) / 2, (sy + ey) / 2, len, 10, { isStatic: true, angle: ang, friction: 0.01 }));
    // backstop across the top of the ramp
    const bx = sx - Math.sin(ang) * 14, by = sy + Math.cos(ang) * 14;
    add(Bodies.rectangle(bx, by, 10, 36, { isStatic: true, angle: ang }));
    // the rotor: hub plus three vanes, rotated by hand every frame
    // vanes reach to just over a ball-radius short of the rim: balls can't slip under, so the pile is lifted and dumped
    const vaneLen = R - 1.25 * ballR - plateR;
    const parts = [Bodies.circle(cx, cy, plateR + 2, { isStatic: true })];
    for (let k = 0; k < VANES; k++) {
      const a = (k * 2 * Math.PI) / VANES;
      const m = plateR + vaneLen / 2;
      parts.push(Bodies.rectangle(cx + m * Math.cos(a), cy + m * Math.sin(a), vaneLen, 8, { isStatic: true, angle: a }));
    }
    S.rotor = add(Body.create({ parts, isStatic: true, friction: 0.3 }));
    S.vaneLen = vaneLen;
    // the tray under the exit
    const ty = cy + R + 62, tw = Math.max(76, ballR * 7);
    S.tray = { x: cx, y: ty, w: tw, h: 22 };
    add(Bodies.rectangle(cx, ty + 4, tw, 8, { isStatic: true }));
    add(Bodies.rectangle(cx - tw / 2, ty - 10, 8, 30, { isStatic: true }));
    add(Bodies.rectangle(cx + tw / 2, ty - 10, 8, 30, { isStatic: true }));
  }

  // ---------- balls ----------
  function makeBall(x, y, state) {
    const { ballR } = S;
    const body = Bodies.circle(x, y, ballR, { restitution: 0.25, friction: 0.04, frictionAir: 0.012, density: 0.002 });
    const ball = { body, color: COLORS[Math.floor(Math.random() * COLORS.length)], n: 1 + (S.seq++ % 999), state, since: S.frame, label: null };
    if (state === "entering") body.collisionFilter.group = ENTRY_GROUP;
    S.balls.push(ball);
    Composite.add(world, body);
    return ball;
  }
  function spawnInside() {
    const { cx, cy, R, plateR, ballR } = S;
    const a = -Math.PI * Math.random(); // upper half, so they fall and settle
    const r = plateR + ballR + 4 + Math.random() * (R - plateR - 2 * ballR - 8);
    makeBall(cx + r * Math.cos(a), cy + r * Math.sin(a), "normal");
  }
  function spawnOnChute() {
    const { sx, sy, ang } = S.ramp;
    const nx = -Math.sin(ang), ny = Math.cos(ang); // normal pointing up off the ramp (ramp runs right-to-left, ang ~ 160 deg)
    const dx = Math.cos(ang) * (S.ballR + 10), dy = Math.sin(ang) * (S.ballR + 10);
    const b = makeBall(sx + dx + nx * (S.ballR + 4), sy + dy + ny * (S.ballR + 4), "entering");
    Body.setVelocity(b.body, { x: Math.cos(ang) * 2.5, y: Math.sin(ang) * 2.5 });
    onEvent?.("buy");
  }
  function removeBall(ball) {
    const i = S.balls.indexOf(ball);
    if (i >= 0) S.balls.splice(i, 1);
    Composite.remove(world, ball.body);
    if (S.exiting === ball) S.exiting = null;
    if (S.winner === ball) S.winner = null;
  }
  const normals = () => S.balls.filter((b) => b.state === "normal");
  function cullOne() {
    const ns = normals();
    if (ns.length) removeBall(ns[Math.floor(Math.random() * ns.length)]);
  }
  function startExit(ball, asWinner) {
    ball.state = asWinner ? "winning" : "exiting";
    ball.since = S.frame;
    ball.body.collisionFilter.group = EXIT_GROUP;
    S.exiting = ball;
    if (!asWinner) onEvent?.("sell");
  }
  function lowestNormal() {
    let best = null;
    for (const b of normals()) if (!best || b.body.position.y > best.body.position.y) best = b;
    return best;
  }

  // ---------- per-frame bookkeeping ----------
  function housekeeping() {
    const { cx, cy, R, ballR, tray } = S;
    const t = S.frame;
    // pour: balls spawned directly inside, a few per frame
    if (S.pour > 0) { const n = Math.min(S.pour, 6); for (let i = 0; i < n; i++) spawnInside(); S.pour -= n; }
    // buys: one down the chute every 24 frames
    if (S.buyQueue > 0 && t - S.lastBuyAt >= 24) { S.buyQueue--; S.lastBuyAt = t; spawnOnChute(); }
    // sells: one at a time
    if (S.sellQueue > 0 && !S.exiting && !S.drawPending) {
      const b = lowestNormal();
      S.sellQueue--;
      if (b) startExit(b, false);
    }
    // a draw: spin, then spit one ball into the tray
    if (S.drawPending && !S.exiting && t >= S.spinUntil) {
      const b = lowestNormal();
      if (b) { b.label = S.drawPending; startExit(b, true); }
      S.drawPending = null;
      S.omega = IDLE_OMEGA;
    }
    if (S.spinUntil && t >= S.spinUntil && !S.drawPending) { S.spinUntil = 0; S.omega = IDLE_OMEGA; }
    // the winner leaves the tray after a while and a ball goes back in
    if (S.winner && t >= S.winnerUntil) { removeBall(S.winner); S.pour += 1; }

    for (const b of [...S.balls]) {
      const p = b.body.position;
      const d = Math.hypot(p.x - cx, p.y - cy);
      if (b.state === "entering") {
        if (d < R - 1.6 * ballR) { b.state = "normal"; b.body.collisionFilter.group = 0; if (S.balls.length > S.cap) cullOne(); }
        else if (t - b.since > 60 * 6 || p.y > cy + R) { removeBall(b); S.pour += 1; } // lost off the chute: put it in anyway
      } else if (b.state === "exiting" || b.state === "winning") {
        if (p.y > cy + R + ballR) {
          if (b.state === "exiting") { b.state = "out"; b.since = t; }
          else { b.state = "winner"; b.since = t; S.winner = b; S.winnerUntil = t + 60 * 20; burst(); onEvent?.("winner", b.label); }
          S.exiting = null;
        } else {
          // pull it toward the hatch
          const gx = cx + R * Math.cos(EXIT_ANGLE), gy = cy + R * Math.sin(EXIT_ANGLE);
          const dx = gx - p.x, dy = gy - p.y, L = Math.hypot(dx, dy) || 1;
          Body.applyForce(b.body, p, { x: (dx / L) * 0.0012 * b.body.mass, y: (dy / L) * 0.0012 * b.body.mass });
          if (t - b.since > 60 * 6) { // stuck: give up, remove it quietly
            if (b.state === "winning") { b.state = "winner"; S.winner = b; S.winnerUntil = t + 60 * 20; Body.setPosition(b.body, { x: tray.x, y: tray.y - ballR - 4 }); Body.setVelocity(b.body, { x: 0, y: 0 }); }
            else removeBall(b);
            S.exiting = null;
          }
        }
      } else if (b.state === "out") {
        if (t - b.since > 60 * 1.2 || p.y > S.H + ballR) removeBall(b);
      } else if (b.state === "normal") {
        // escaped through a seam: put it back in
        if (d > R - 0.2 * ballR && (t % 10 === 0)) {
          const a = Math.atan2(p.y - cy, p.x - cx), r = R - 2.2 * ballR;
          Body.setPosition(b.body, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
          Body.setVelocity(b.body, { x: 0, y: 0 });
        }
      }
    }
    onCount?.(count());
  }

  // confetti from the tray when a winner lands
  function burst() {
    const { tray } = S;
    for (let i = 0; i < 140; i++) {
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6, v = 6 + Math.random() * 9;
      S.confetti.push({ x: tray.x + (Math.random() - 0.5) * tray.w, y: tray.y - 10, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.4, c: COLORS[i % COLORS.length].fill, w: 6 + Math.random() * 6, h: 3 + Math.random() * 4, life: 150 + Math.random() * 60 });
    }
  }
  function stepConfetti() {
    for (const p of S.confetti) { p.vy += 0.25; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life--; }
    S.confetti = S.confetti.filter((p) => p.life > 0 && p.y < S.H + 20);
  }
  function drawConfetti() {
    for (const p of S.confetti) {
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.min(1, p.life / 40);
      ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
    }
  }

  // ---------- drawing ----------
  function circle(x, y, r, fill, stroke, lw) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); }
  }
  function stripedBar(x1, y1, x2, y2, thick, stripe = 18) {
    const len = Math.hypot(x2 - x1, y2 - y1), ang = Math.atan2(y2 - y1, x2 - x1);
    ctx.save(); ctx.translate(x1, y1); ctx.rotate(ang);
    ctx.beginPath(); ctx.rect(0, -thick / 2, len, thick); ctx.clip();
    ctx.fillStyle = PAPER; ctx.fillRect(0, -thick / 2, len, thick);
    ctx.fillStyle = RED;
    for (let s = 0; s < len; s += stripe * 2) ctx.fillRect(s, -thick / 2, stripe, thick);
    ctx.restore();
    ctx.save(); ctx.translate(x1, y1); ctx.rotate(ang);
    ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.strokeRect(0, -thick / 2, len, thick);
    ctx.restore();
  }
  function draw() {
    const { W, H, cx, cy, R, plateR, ballR, ramp, tray, rotorAngle } = S;
    ctx.clearRect(0, 0, W, H);

    // chute
    ctx.save();
    ctx.translate(5, 6); ctx.strokeStyle = INK; ctx.lineWidth = 3; ctx.fillStyle = INK;
    ctx.beginPath(); ctx.moveTo(ramp.sx, ramp.sy); ctx.lineTo(ramp.ex, ramp.ey); ctx.lineWidth = 16; ctx.stroke();
    ctx.restore();
    stripedBar(ramp.sx, ramp.sy, ramp.ex, ramp.ey, 14);
    // chute legs
    ctx.strokeStyle = INK; ctx.lineWidth = 3;
    for (const f of [0.25, 0.6]) {
      const x = ramp.sx + (ramp.ex - ramp.sx) * f, y = ramp.sy + (ramp.ey - ramp.sy) * f + 7;
      const floor = cy + R + 40;
      if (floor - y > 30) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, floor); ctx.stroke(); }
    }

    // drum: hard shadow, disc, rim
    circle(cx + 8, cy + 10, R + 12, INK);
    circle(cx, cy, R + 12, "#fff", INK, 4);
    // striped outer band, rotating with the drum
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rotorAngle);
    const segs = 28;
    for (let i = 0; i < segs; i++) {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, R + 10, (i / segs) * 2 * Math.PI, ((i + 1) / segs) * 2 * Math.PI); ctx.closePath();
      ctx.fillStyle = i % 2 ? RED : PAPER; ctx.fill();
    }
    ctx.restore();
    circle(cx, cy, R + 1, "#fff", INK, 3);
    circle(cx, cy, R + 12, null, INK, 4);
    // back wires (faint)
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rotorAngle + Math.PI / 6);
    ctx.strokeStyle = "rgba(44,20,13,.12)"; ctx.lineWidth = 2;
    for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(R * Math.cos((k * Math.PI) / 3), R * Math.sin((k * Math.PI) / 3)); ctx.stroke(); }
    ctx.restore();
    // vanes
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rotorAngle);
    for (let k = 0; k < VANES; k++) {
      ctx.save(); ctx.rotate((k * 2 * Math.PI) / VANES);
      ctx.fillStyle = RED; ctx.strokeStyle = INK; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(plateR, -5, S.vaneLen, 10, 5); ctx.fill(); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();

    // tray
    ctx.fillStyle = INK; ctx.fillRect(tray.x - tray.w / 2 + 4, tray.y - 16 + 5, tray.w, 26);
    ctx.fillStyle = PAPER_DEEP; ctx.strokeStyle = INK; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.rect(tray.x - tray.w / 2, tray.y - 16, tray.w, 26); ctx.fill(); ctx.stroke();
    ctx.fillStyle = RED;
    for (let s = tray.x - tray.w / 2 + 3; s < tray.x + tray.w / 2 - 3; s += 20) ctx.fillRect(s, tray.y - 13, 10, 20);
    ctx.fillStyle = INK; ctx.fillRect(tray.x - tray.w / 2, tray.y - 16, tray.w, 3);

    // balls
    const numbers = ballR >= 9;
    ctx.font = `${Math.round(ballR * 1.15)}px Rye, Georgia, serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const b of S.balls) {
      const { x, y } = b.body.position;
      const r = b.state === "winner" ? ballR * 1.6 : ballR;
      circle(x + 1.5, y + 2, r, INK);
      circle(x, y, r, b.color.fill, INK, 2);
      ctx.fillStyle = "rgba(255,255,255,.55)"; ctx.beginPath(); ctx.arc(x - r * 0.35, y - r * 0.35, r * 0.22, 0, Math.PI * 2); ctx.fill();
      if (numbers || b.state === "winner") {
        ctx.fillStyle = b.color.text;
        if (b.state === "winner") ctx.font = `${Math.round(r * 1.1)}px Rye, Georgia, serif`;
        ctx.fillText(String(b.n), x, y + 1);
        if (b.state === "winner") ctx.font = `${Math.round(ballR * 1.15)}px Rye, Georgia, serif`;
      }
    }

    // front wires: spokes and two rings over the balls, rotating with the drum
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rotorAngle + Math.PI / 6);
    ctx.strokeStyle = "rgba(44,20,13,.32)"; ctx.lineWidth = 2.5;
    for (let k = 0; k < 6; k++) { ctx.beginPath(); ctx.moveTo((plateR + 10) * Math.cos((k * Math.PI) / 3), (plateR + 10) * Math.sin((k * Math.PI) / 3)); ctx.lineTo(R * Math.cos((k * Math.PI) / 3), R * Math.sin((k * Math.PI) / 3)); ctx.stroke(); }
    ctx.lineWidth = 2;
    for (const f of [0.66, 0.86]) { ctx.beginPath(); ctx.arc(0, 0, R * f, 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();

    // hub ring behind the HTML plate
    circle(cx + 4, cy + 5, plateR + 10, INK);
    circle(cx, cy, plateR + 10, GOLD, INK, 3);

    // hatches
    for (const [a, label] of [[S.entry, null], [EXIT_ANGLE, null]]) {
      const hx = cx + (R + 6) * Math.cos(a), hy = cy + (R + 6) * Math.sin(a);
      ctx.save(); ctx.translate(hx, hy); ctx.rotate(a + Math.PI / 2);
      const w = 2 * (R + 6) * Math.sin(S.gapHalf) + 10;
      ctx.fillStyle = INK; ctx.fillRect(-w / 2, -9, w, 18);
      ctx.fillStyle = GOLD; ctx.fillRect(-w / 2 + 3, -6, w - 6, 12);
      ctx.restore();
      void label;
    }

    // the winner's label pill beside the tray
    if (S.winner?.label) {
      const { who, amount } = S.winner.label;
      ctx.font = `16px Rye, Georgia, serif`;
      const text = `${who}   ${amount}`;
      const tw = ctx.measureText(text).width + 28;
      const px = Math.min(W - tw - 8, tray.x + tray.w / 2 + 16), py = tray.y - 30;
      ctx.fillStyle = INK; ctx.fillRect(px + 3, py + 4, tw, 36);
      ctx.fillStyle = PAPER; ctx.strokeStyle = INK; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.roundRect(px, py, tw, 36, 10); ctx.fill(); ctx.stroke();
      ctx.fillStyle = RED_DEEP; ctx.textAlign = "left"; ctx.fillText(text, px + 14, py + 19); ctx.textAlign = "center";
    }

    drawConfetti();

    // labels
    ctx.font = `13px Rye, Georgia, serif`; ctx.fillStyle = RED_DEEP; ctx.textAlign = "center";
    { const f = S.W < 700 ? 0.5 : 0.3; const lx = ramp.sx + (ramp.ex - ramp.sx) * f, ly = ramp.sy + (ramp.ey - ramp.sy) * f;
      ctx.save(); ctx.translate(lx, ly); ctx.rotate(ramp.ang + Math.PI); ctx.fillText("BUYS IN", 0, 24); ctx.restore(); }
    ctx.fillText("SELLS OUT", tray.x, tray.y + 30);
  }

  // ---------- loop ----------
  function frame(ts) {
    S.raf = requestAnimationFrame(frame);
    if (!S.last) S.last = ts;
    let dt = Math.min(100, ts - S.last);
    S.last = ts;
    if (S.live) {
      S.acc += dt;
      let steps = 0;
      while (S.acc >= STEP && steps < 3) {
        S.frame++;
        if (!reduced || S.spinUntil) S.rotorAngle += (S.omega * STEP) / 1000;
        Body.setAngle(S.rotor, S.rotorAngle);
        housekeeping();
        stepConfetti();
        Engine.update(engine, STEP);
        S.acc -= STEP; steps++;
      }
      if (steps === 3) S.acc = 0;
    }
    draw();
  }

  // ---------- public API ----------
  function count() { return S.balls.filter((b) => b.state !== "out").length; }
  function setLive(on) {
    if (S.live === on) return;
    S.live = on;
    host.classList.toggle("drum-live", on);
    if (!on) { for (const b of [...S.balls]) removeBall(b); S.pour = 0; S.buyQueue = 0; S.sellQueue = 0; S.drawPending = null; S.target = 0; }
  }
  /** Wanted number of balls, from the wallet count. Big jumps pour straight in; small ones use the chute/hatch. */
  function setCount(n) {
    const want = Math.max(0, Math.min(S.cap, Math.floor(n || 0)));
    S.target = want;
    if (!S.live) return;
    const have = count() + S.pour + S.buyQueue - S.sellQueue;
    const diff = want - have;
    if (diff > 5 || (diff > 0 && have === 0)) S.pour += diff;
    else if (diff > 0) S.buyQueue += diff;
    else if (diff < -5) { for (let i = 0; i < -diff; i++) cullOne(); }
    else if (diff < 0) S.sellQueue += -diff;
  }
  function buy(k = 1) { if (S.live) S.buyQueue += k; }
  function sell(k = 1) { if (S.live) S.sellQueue += k; }
  /** Spin up, then spit a ball into the tray with the winner's label. */
  function drawWinner({ who, amount }) {
    if (!S.live) return;
    if (S.winner) { removeBall(S.winner); S.pour += 1; }
    S.drawPending = { who, amount };
    S.omega = DRAW_OMEGA;
    S.spinUntil = S.frame + 60 * 3.5;
  }
  function rebuild() {
    const n = count();
    for (const b of [...S.balls]) removeBall(b);
    layout(); buildStatics();
    if (S.live) S.pour = n;
  }
  function destroy() { cancelAnimationFrame(S.raf); ro.disconnect(); Composite.clear(world, false); }

  layout(); buildStatics();
  let lastW = S.W;
  const ro = new ResizeObserver(() => { if (Math.abs(host.clientWidth - lastW) > 2) { lastW = host.clientWidth; rebuild(); } });
  ro.observe(host);
  S.raf = requestAnimationFrame(frame);

  return { setLive, setCount, buy, sell, draw: drawWinner, count, destroy, get cap() { return S.cap; } };
}
