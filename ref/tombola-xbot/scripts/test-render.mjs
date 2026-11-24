// Renders all three cards in Node with the same templates and resvg build the Worker uses,
// and checks every line in the bank: placeholders filled, at most 280 characters, no banned words.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import { winnerSvg, potSvg, countdownSvg } from "../src/templates.js";
import { LINES, fill, TRANSFER_FLAG } from "../src/lines.js";

const vars = { ticker: "$TICKER", round: 123, eth: "12,345.6789", wallet: "0x7099…79C8", held: "2d 23h", pot: "1,234.5678", eligible: "12,345",
  next: "14:00 UTC", mins: 60, total: "12,345.6789", biggest: "1,234.5678", liq: "1,234.5678", holders: "12,345", mega: "1,234.5678",
  megaIn: "6d 23h", ca: "0x61c36a8d610163660E21a8b7359e1Cac0C9133e1", n: "1,000", draws: "1,234", reason: "its signed answer didn't verify" };
const tx = "Tx 0x81cc7ac3f8f9d76243218aedefc67d04f03cd834bd01de6bb4228dd76c67ae67";
let bad = 0, total = 0, longest = 0;
for (const [kind, lines] of Object.entries(LINES)) {
  for (const l of lines) {
    total++;
    let t = fill(l, vars);
    if (kind.startsWith("winner")) t += `\n\n${tx}\n${TRANSFER_FLAG}`;
    if (kind === "rollover") t += `\n\n${tx}`;
    longest = Math.max(longest, t.length);
    const problems = [];
    if (/\{\w+\}/.test(t)) problems.push("unfilled placeholder");
    if (t.length > 280) problems.push(`${t.length} chars`);
    if (/guarantee|moon|100x|price will|https?:\/\//i.test(t)) problems.push("banned wording");
    if (kind.startsWith("winner") && !["{round}", "{eth}", "{wallet}", "{held}"].every((p) => l.includes(p))) problems.push("winner line missing a fact");
    if (problems.length) { bad++; console.log(`FAIL ${kind}: ${problems.join(", ")}: ${l}`); }
  }
}
console.log(`${total} lines checked, worst case ${longest} chars with the tx hash and transfer note, ${bad} problems`);

await initWasm(readFileSync(new URL("../node_modules/@resvg/resvg-wasm/index_bg.wasm", import.meta.url)));
const fonts = ["Rye-Regular.ttf", "SpaceMono-Bold.ttf"].map((f) => readFileSync(new URL(`../fonts/${f}`, import.meta.url)));
const out = process.argv[2] ?? "dry-run-out";
mkdirSync(out, { recursive: true });
const cards = {
  winner: winnerSvg({ round: 1, eth: "0.992", wallet: "0x7099…79C8", held: "1h 44m", ticker: "$TICKER" }),
  winnerMega: winnerSvg({ round: 42, eth: "12.3456", wallet: "0x3C44…93BC", held: "3d 2h", mega: true, ticker: "$TICKER" }),
  pot: potSvg({ pot: "0.0019", eligible: "4", next: "08:44 UTC", ticker: "$TICKER" }),
  countdown: countdownSvg({ pot: "1.2345", eligible: "4", ticker: "$TICKER" }),
};
for (const [k, svg] of Object.entries(cards)) {
  const t0 = performance.now();
  const r = new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: "Space Mono" } });
  const png = r.render().asPng();
  writeFileSync(`${out}/${k}.png`, png);
  console.log(`card ${k}: ${png.length} bytes in ${Math.round(performance.now() - t0)} ms`);
}
process.exitCode = bad ? 1 : 0;
