// The night fair. Builds the backdrop scene (sky, rides, tents, searchlights) and every strip of chasing bulbs on
// the page as SVG, in code, because the CSP forbids inline style attributes and each bulb needs its own delay.
// Pure decoration: nothing here touches the live data. Animations live in fair.css; this file only sets delays.
const NS = "http://www.w3.org/2000/svg";
const BULB_COLORS = ["#ff4b3e", "#ffd34d", "#4fd1c5", "#ff5fb2", "#7ee081", "#ffa72b"];
const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
}
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr, i) => arr[i % arr.length];

/** A bulb: a soft glow and a bright core. `phase` sets its place in the 3-step chase; `delay` overrides it. */
function bulb(parent, x, y, { r = 4, phase = 0, color, cls = "bulb", delay } = {}) {
  const g = el("g", { class: `${cls} ${color ? "" : "bulb-warm"}`.trim(), transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})` }, parent);
  el("circle", { class: "glow", r: r * 2.4, fill: color || "#ffcf5a" }, g);
  el("circle", { class: "core", r, fill: color || "#fff1b8" }, g);
  g.style.animationDelay = delay ?? `${(-phase * 0.34).toFixed(2)}s`;
  if (color) { g.style.setProperty("--c", color); }
  return g;
}

// ---------------------------------------------------------------------------------------------- backdrop scene
export function buildScene(host) {
  host.replaceChildren();
  const W = 1600, H = 800;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMax slice", class: "fair-svg" }, host);
  const defs = el("defs", {}, svg);
  const sky = el("linearGradient", { id: "f-sky", x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  for (const [o, c] of [[0, "#070b24"], [0.45, "#141444"], [0.8, "#33205a"], [1, "#4a2a5e"]]) el("stop", { offset: o, "stop-color": c }, sky);
  const beam = el("linearGradient", { id: "f-beam", x1: 0, y1: 1, x2: 0, y2: 0 }, defs);
  el("stop", { offset: 0, "stop-color": "#fff6d0", "stop-opacity": 0.55 }, beam);
  el("stop", { offset: 1, "stop-color": "#fff6d0", "stop-opacity": 0 }, beam);
  const pool = el("radialGradient", { id: "f-pool" }, defs);
  el("stop", { offset: 0, "stop-color": "#ffcf5a", "stop-opacity": 0.35 }, pool);
  el("stop", { offset: 1, "stop-color": "#ffcf5a", "stop-opacity": 0 }, pool);

  el("rect", { width: W, height: H, fill: "url(#f-sky)" }, svg);

  // ---- far: stars, moon, Ferris wheel, drop tower
  const far = el("g", { class: "layer layer-far" }, svg);
  const stars = el("g", { class: "stars" }, far);
  for (let i = 0; i < 90; i++) {
    const s = el("circle", { cx: rnd(0, W).toFixed(0), cy: rnd(0, H * 0.55).toFixed(0), r: rnd(0.8, 2.2).toFixed(1), fill: "#fff8e1", class: "star" }, stars);
    s.style.animationDelay = `${rnd(-6, 0).toFixed(2)}s`;
    s.style.animationDuration = `${rnd(2.5, 6).toFixed(2)}s`;
  }
  el("circle", { cx: 250, cy: 120, r: 34, fill: "#fff3c4", opacity: 0.9 }, far);
  el("circle", { cx: 266, cy: 108, r: 30, fill: "#0b0f30" }, far);

  // searchlights (behind the rides)
  for (const [x, dur, from, to] of [[700, 11, -28, 22], [1240, 14, 24, -30]]) {
    const g = el("g", { class: "beam" }, far);
    g.style.transformOrigin = `${x}px ${H}px`;
    g.style.animationDuration = `${dur}s`;
    g.style.setProperty("--from", `${from}deg`); g.style.setProperty("--to", `${to}deg`);
    el("polygon", { points: `${x - 10},${H} ${x + 10},${H} ${x + 90},-80 ${x - 150},-80`, fill: "url(#f-beam)" }, g);
  }

  ferris(far, 1080, 400, 205);
  tower(far, 1330, 780);

  // ---- mid: tents, carousel
  const mid = el("g", { class: "layer layer-mid" }, svg);
  bigTop(mid, 820, 765, 1.0, 0);
  bigTop(mid, 190, 775, 0.9, 7);
  bigTop(mid, 1500, 775, 0.75, 3);
  carousel(mid, 560, 740);

  // ---- near: ground, fence, light pools
  const near = el("g", { class: "layer layer-near" }, svg);
  el("path", { d: `M0,${H} L0,730 Q200,700 420,728 T820,735 T1200,728 T1600,732 L${W},${H} Z`, fill: "#0c1230" }, near);
  for (const [x, w] of [[560, 420], [820, 520], [1080, 480], [190, 300], [1500, 300]]) el("ellipse", { cx: x, cy: 760, rx: w / 2, ry: 40, fill: "url(#f-pool)" }, near);
  const fence = el("g", { class: "fence" }, near);
  for (let x = 20; x < W; x += 56) { el("rect", { x, y: 736, width: 6, height: 44, rx: 2, fill: "#1a1f4a" }, fence); }
  el("rect", { x: 0, y: 748, width: W, height: 4, fill: "#1a1f4a" }, fence);
  el("rect", { x: 0, y: 766, width: W, height: 4, fill: "#1a1f4a" }, fence);
  return svg;
}

function ferris(parent, cx, cy, r) {
  const g = el("g", { class: "ferris" }, parent);
  // legs and base
  el("path", { d: `M${cx - 120},780 L${cx},${cy} L${cx + 120},780 Z`, fill: "none", stroke: "#2a2459", "stroke-width": 14, "stroke-linejoin": "round" }, g);
  el("path", { d: `M${cx - 120},780 L${cx},${cy} L${cx + 120},780 Z`, fill: "none", stroke: "#5a4a9a", "stroke-width": 6, "stroke-linejoin": "round" }, g);
  el("rect", { x: cx - 150, y: 772, width: 300, height: 10, rx: 4, fill: "#2a2459" }, g);
  // the wheel turns
  const rot = el("g", { class: "ferris-rot" }, g);
  rot.style.transformOrigin = `${cx}px ${cy}px`;
  el("circle", { cx, cy, r, fill: "none", stroke: "#6a56b8", "stroke-width": 7 }, rot);
  el("circle", { cx, cy, r: r * 0.62, fill: "none", stroke: "#6a56b8", "stroke-width": 4 }, rot);
  const N = 16;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    el("line", { x1: cx, y1: cy, x2: cx + r * Math.cos(a), y2: cy + r * Math.sin(a), stroke: "#8a74d8", "stroke-width": 3 }, rot);
  }
  el("circle", { cx, cy, r: 18, fill: "#ffd34d", stroke: "#2c140d", "stroke-width": 3 }, rot);
  // rim lights, chasing in colour
  for (let i = 0; i < 48; i++) {
    const a = (i / 48) * Math.PI * 2;
    bulb(rot, cx + r * Math.cos(a), cy + r * Math.sin(a), { r: 4.5, cls: "bulb bulb-color", color: pick(BULB_COLORS, i), delay: `${(-(i % 6) * 0.3).toFixed(2)}s` });
  }
  // cabins hang from the rim and stay upright
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
    const c = el("g", { class: "cabin" }, rot);
    c.style.transformOrigin = `${px}px ${py}px`;
    el("line", { x1: px, y1: py, x2: px, y2: py + 14, stroke: "#2c140d", "stroke-width": 3 }, c);
    el("rect", { x: px - 15, y: py + 14, width: 30, height: 24, rx: 8, fill: pick(BULB_COLORS, i), stroke: "#2c140d", "stroke-width": 3 }, c);
    el("rect", { x: px - 9, y: py + 19, width: 18, height: 9, rx: 3, fill: "#fff6c8", opacity: 0.85 }, c);
  }
}

function tower(parent, x, base) {
  const g = el("g", { class: "tower" }, parent);
  const top = base - 600;
  el("rect", { x: x - 8, y: top, width: 16, height: base - top, fill: "#2a2459" }, g);
  el("rect", { x: x - 3, y: top, width: 6, height: base - top, fill: "#6a56b8" }, g);
  for (let y = top; y < base; y += 40) el("rect", { x: x - 22, y, width: 44, height: 4, fill: "#3b3270" }, g);
  el("rect", { x: x - 30, y: top - 18, width: 60, height: 18, rx: 4, fill: "#c8271c", stroke: "#2c140d", "stroke-width": 3 }, g);
  const n = 20;
  for (let i = 0; i < n; i++) {
    const y = top + 20 + (i * (base - top - 60)) / n;
    bulb(g, x - 18, y, { r: 3.2, cls: "bulb bulb-color", color: pick(BULB_COLORS, i), delay: `${(-(i % 6) * 0.25).toFixed(2)}s` });
    bulb(g, x + 18, y, { r: 3.2, cls: "bulb bulb-color", color: pick(BULB_COLORS, i + 3), delay: `${(-(i % 6) * 0.25).toFixed(2)}s` });
  }
  const car = el("g", { class: "gondola" }, g);
  car.style.setProperty("--rise", `${-(base - top - 120)}px`);
  el("rect", { x: x - 40, y: base - 60, width: 80, height: 28, rx: 8, fill: "#ffd34d", stroke: "#2c140d", "stroke-width": 3 }, car);
  for (let i = 0; i < 5; i++) bulb(car, x - 28 + i * 14, base - 46, { r: 3, phase: i % 3 });
}

function bigTop(parent, x, base, s, seed) {
  const g = el("g", { class: "tent" }, parent);
  const peakY = base - 300 * s, roofY = base - 125 * s, hw = 210 * s, ww = 180 * s;
  // striped roof: wedges from the peak
  const wedges = 10;
  for (let i = 0; i < wedges; i++) {
    const x0 = x - hw + (i * 2 * hw) / wedges, x1 = x - hw + ((i + 1) * 2 * hw) / wedges;
    el("polygon", { points: `${x},${peakY} ${x0.toFixed(1)},${roofY} ${x1.toFixed(1)},${roofY}`, fill: i % 2 ? "#fff2d6" : "#c8271c" }, g);
  }
  el("polygon", { points: `${x - hw},${roofY} ${x + hw},${roofY} ${x + ww},${base} ${x - ww},${base}`, fill: "#8f1a14" }, g);
  // scalloped valance along the roof edge
  for (let sx = x - hw; sx < x + hw; sx += 24 * s) el("circle", { cx: sx + 12 * s, cy: roofY, r: 12 * s, fill: "#8f1a14" }, g);
  // glowing entrance
  el("path", { d: `M${x - 34 * s},${base} L${x - 34 * s},${base - 70 * s} Q${x},${base - 120 * s} ${x + 34 * s},${base - 70 * s} L${x + 34 * s},${base} Z`, fill: "#ffd98a", class: "tent-door" }, g);
  // flag
  el("line", { x1: x, y1: peakY, x2: x, y2: peakY - 40 * s, stroke: "#2c140d", "stroke-width": 3 }, g);
  el("polygon", { points: `${x},${peakY - 40 * s} ${x + 34 * s},${peakY - 30 * s} ${x},${peakY - 20 * s}`, fill: "#ffd34d", class: "flag" }, g);
  // bulbs along the roof edge
  const n = Math.round(14 * s);
  for (let i = 0; i <= n; i++) bulb(g, x - hw + (i * 2 * hw) / n, roofY + 2, { r: 3.6 * s, phase: (i + seed) % 3 });
  // bulbs up the roof seams
  for (let i = 1; i < 5; i++) { const t = i / 5; bulb(g, x - hw + (hw * t), peakY + (roofY - peakY) * (1 - t), { r: 3 * s, phase: (i + seed) % 3 }); bulb(g, x + hw - (hw * t), peakY + (roofY - peakY) * (1 - t), { r: 3 * s, phase: (i + 1 + seed) % 3 }); }
}

function carousel(parent, x, base) {
  const g = el("g", { class: "carousel" }, parent);
  const apex = base - 290, roofY = base - 175, rw = 165;
  el("ellipse", { cx: x, cy: base, rx: rw + 15, ry: 24, fill: "#2a2459" }, g);
  el("rect", { x: x - rw - 15, y: base - 26, width: (rw + 15) * 2, height: 26, rx: 6, fill: "#3b3270" }, g);
  el("ellipse", { cx: x, cy: base - 26, rx: rw + 15, ry: 22, fill: "#5a4a9a" }, g);
  // centre column
  el("rect", { x: x - 22, y: roofY, width: 44, height: base - 26 - roofY, fill: "#8f1a14", stroke: "#2c140d", "stroke-width": 2 }, g);
  // horses on poles, bobbing in turn
  const H = 6;
  for (let i = 0; i < H; i++) {
    const a = (i / H) * Math.PI * 2 + 0.3;
    const hx = x + Math.cos(a) * (rw - 20), hy = base - 30 + Math.sin(a) * 12;
    const depth = (Math.sin(a) + 1) / 2; // 0 back, 1 front
    const h = el("g", { class: "horse" }, g);
    h.style.animationDelay = `${(-i * 0.55).toFixed(2)}s`;
    h.style.opacity = (0.55 + depth * 0.45).toFixed(2);
    el("line", { x1: hx, y1: roofY + 6, x2: hx, y2: hy, stroke: "#ffd34d", "stroke-width": 3 }, h);
    const sc = 0.7 + depth * 0.35;
    const body = el("g", { transform: `translate(${hx.toFixed(1)} ${(hy - 58 * sc).toFixed(1)}) scale(${sc.toFixed(2)})` }, h);
    el("path", { d: "M-26,0 Q-30,-22 -10,-24 L14,-24 Q26,-26 30,-44 L38,-40 Q36,-18 22,-10 L22,18 L14,18 L14,-4 L-10,-4 L-10,18 L-18,18 L-18,-2 Q-30,4 -26,0 Z", fill: pick(["#fff2d6", "#4fd1c5", "#ff5fb2", "#ffd34d"], i), stroke: "#2c140d", "stroke-width": 2.5, "stroke-linejoin": "round" }, body);
    el("circle", { cx: 32, cy: -38, r: 2, fill: "#2c140d" }, body);
  }
  // striped roof
  const wedges = 12;
  for (let i = 0; i < wedges; i++) {
    const x0 = x - rw + (i * 2 * rw) / wedges, x1 = x - rw + ((i + 1) * 2 * rw) / wedges;
    el("polygon", { points: `${x},${apex} ${x0.toFixed(1)},${roofY} ${x1.toFixed(1)},${roofY}`, fill: i % 2 ? "#fff2d6" : "#c8271c" }, g);
  }
  el("ellipse", { cx: x, cy: roofY, rx: rw, ry: 26, fill: "#8f1a14", stroke: "#2c140d", "stroke-width": 3 }, g);
  el("circle", { cx: x, cy: apex - 6, r: 10, fill: "#ffd34d", stroke: "#2c140d", "stroke-width": 3 }, g);
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    bulb(g, x + Math.cos(a) * rw, roofY + Math.sin(a) * 26, { r: 4, cls: "bulb bulb-color", color: pick(BULB_COLORS, i), delay: `${(-(i % 6) * 0.3).toFixed(2)}s` });
  }
}

// ---------------------------------------------------------------------------------------------- bulb strips
/** Points along the edge of a rounded rectangle, `step` apart. */
function roundedRectPoints(w, h, r, step) {
  const pts = [];
  const rr = Math.min(r, w / 2, h / 2);
  const arc = (cx, cy, a0, a1) => { const L = rr * (a1 - a0); const n = Math.max(1, Math.round(L / step)); for (let i = 0; i < n; i++) { const a = a0 + ((a1 - a0) * i) / n; pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]); } };
  const line = (x0, y0, x1, y1) => { const L = Math.hypot(x1 - x0, y1 - y0); const n = Math.max(1, Math.round(L / step)); for (let i = 0; i < n; i++) pts.push([x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]); };
  line(rr, 0, w - rr, 0); arc(w - rr, rr, -Math.PI / 2, 0);
  line(w, rr, w, h - rr); arc(w - rr, h - rr, 0, Math.PI / 2);
  line(w - rr, h, rr, h); arc(rr, h - rr, Math.PI / 2, Math.PI);
  line(0, h - rr, 0, rr); arc(rr, rr, Math.PI, 1.5 * Math.PI);
  return pts;
}

/** Draws chasing bulbs on every [data-bulbs] element and keeps them sized to it. */
export function initBulbs(root = document) {
  const hosts = [...root.querySelectorAll("[data-bulbs]")];
  const draw = (host) => {
    host.querySelector(":scope > .bulbs")?.remove();
    const kind = host.dataset.bulbs;
    const pad = Number(host.dataset.bulbPad ?? 12);
    const step = Number(host.dataset.bulbStep ?? 26);
    const r = Number(host.dataset.bulbR ?? 4.5);
    const offset = Number(host.dataset.bulbOffset ?? 0); // "row": how far below the element's bottom edge the bulbs hang
    const w = host.offsetWidth + pad * 2, h = host.offsetHeight + pad * 2 + offset;
    if (!w || !h) return;
    const svg = el("svg", { class: "bulbs", width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    svg.style.left = `${-pad}px`; svg.style.top = `${-pad}px`;
    let pts = [];
    if (kind === "ring") pts = roundedRectPoints(w - r * 2, h - r * 2, Number(host.dataset.bulbRadius ?? 26), step).map(([x, y]) => [x + r, y + r]);
    else if (kind === "row") { const n = Math.max(2, Math.round(w / step)); for (let i = 0; i <= n; i++) pts.push([(i * w) / n, h - pad - r]); }
    else if (kind === "top") { const n = Math.max(2, Math.round(w / step)); for (let i = 0; i <= n; i++) pts.push([(i * w) / n, pad]); }
    pts.forEach(([x, y], i) => bulb(svg, x, y, { r, phase: i % 3 }));
    host.prepend(svg);
  };
  const ro = new ResizeObserver((entries) => { for (const e of entries) draw(e.target); });
  for (const h of hosts) { draw(h); ro.observe(h); }
}

/** Sagging string lights across the top of the page, bulbs twinkling. */
export function initStrings(host) {
  const draw = () => {
    host.replaceChildren();
    const W = host.clientWidth, H = host.clientHeight || 110;
    if (!W) return;
    const svg = el("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "strings-svg" }, host);
    const spans = W < 700 ? [[0, 14, 56], [W * 0.5, 10, 46]] : [[0, 12, 64], [W * 0.33, 8, 50], [W * 0.66, 12, 64]];
    const segW = W < 700 ? W * 0.5 : W * 0.34;
    spans.forEach(([x0, y0, sag], k) => {
      const x1 = Math.min(W, x0 + segW + 8);
      const p = el("path", { d: `M${x0},${y0} Q${(x0 + x1) / 2},${y0 + sag * 2} ${x1},${y0}`, fill: "none", stroke: "#1b1b2b", "stroke-width": 2 }, svg);
      const L = p.getTotalLength();
      const n = Math.max(4, Math.round(L / 42));
      for (let i = 0; i <= n; i++) {
        const pt = p.getPointAtLength((L * i) / n);
        el("rect", { x: pt.x - 2.5, y: pt.y, width: 5, height: 6, fill: "#1b1b2b" }, svg);
        bulb(svg, pt.x, pt.y + 10, { r: 4.5, cls: "bulb bulb-tw bulb-color", color: pick(BULB_COLORS, i + k * 2), delay: `${rnd(-3, 0).toFixed(2)}s` });
      }
    });
  };
  draw();
  new ResizeObserver(draw).observe(host);
}

/** Parallax: the backdrop's layers drift at different rates as the page scrolls. */
export function initParallax(host) {
  if (reduced) return;
  const layers = [...host.querySelectorAll(".layer")];
  const rates = { "layer-far": 0.04, "layer-mid": 0.08, "layer-near": 0.12 };
  let ticking = false;
  const apply = () => {
    ticking = false;
    const y = window.scrollY || 0;
    for (const l of layers) { const rate = rates[[...l.classList].find((c) => rates[c])] ?? 0; l.style.transform = `translateY(${(-y * rate).toFixed(1)}px)`; }
  };
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(apply); } }, { passive: true });
  apply();
}

/** Flashing arrow signs: an outlined arrow with bulbs running along it toward the point. */
export function initArrows(root = document) {
  for (const host of root.querySelectorAll("[data-arrow]")) {
    host.replaceChildren();
    const flip = host.dataset.arrow === "left";
    const W = 160, H = 90;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "arrow-svg" }, host);
    const g = el("g", { transform: flip ? `translate(${W} 0) scale(-1 1)` : "" }, svg);
    const pts = "4,26 92,26 92,6 156,45 92,84 92,64 4,64";
    el("polygon", { points: pts, fill: "#2c140d", transform: "translate(4 5)" }, g);
    el("polygon", { points: pts, fill: "#c8271c", stroke: "#2c140d", "stroke-width": 4, "stroke-linejoin": "round" }, g);
    el("polygon", { points: "14,34 90,34 90,18 140,45 90,72 90,56 14,56", fill: "none", stroke: "#e5a92b", "stroke-width": 3, "stroke-linejoin": "round" }, g);
    for (let i = 0; i < 7; i++) bulb(g, 24 + i * 16, 45, { r: 4, phase: (6 - i) % 3 });
    bulb(g, 128, 45, { r: 4.5, phase: 2 });
  }
}

export function initFair() {
  const bg = document.getElementById("fair-bg");
  if (bg) { buildScene(bg); initParallax(bg); }
  const strings = document.getElementById("strings");
  if (strings) initStrings(strings);
  initBulbs();
  initArrows();
}
