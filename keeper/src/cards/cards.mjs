// Renders the SVG templates to PNG with resvg (WebAssembly). ~100-300 ms of CPU per card.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { W } from "./templates.mjs";
export { openedSvg, claimSvg, countdownSvg, jackpotSvg } from "./templates.mjs";

const require = createRequire(import.meta.url);
const wasmPath = require.resolve("@resvg/resvg-wasm/index_bg.wasm");
const fontsDir = new URL("../../fonts/", import.meta.url);
let ready;
const init = () => (ready ??= initWasm(readFileSync(wasmPath)));

export async function renderPng(svg) {
  await init();
  const fonts = ["Rye-Regular.ttf", "SpaceMono-Bold.ttf"].map((f) => new Uint8Array(readFileSync(new URL(f, fontsDir))));
  const r = new Resvg(svg, { fitTo: { mode: "width", value: W }, font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Space Mono" } });
  const png = r.render().asPng();
  r.free();
  return png;
}

/** SOL from lamports, at most 4 decimals. */
export function fmtSol(lamports) {
  const l = BigInt(lamports ?? 0);
  if (l === 0n) return "0";
  if (l < 100_000n) return "<0.0001";
  const whole = l / 1_000_000_000n, frac = ((l % 1_000_000_000n) / 100_000n).toString().padStart(4, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
export const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
export function fmtDuration(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`;
}
