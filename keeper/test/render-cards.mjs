// Renders the three cards to scratch/cards/*.png so they can be looked at. Not a unit test.
//   node test/render-cards.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { renderPng, openedSvg, countdownSvg, jackpotSvg, fmtSol, shortAddr, fmtDuration } from "../src/cards/cards.mjs";

const out = new URL("../../scratch/cards/", import.meta.url);
mkdirSync(out, { recursive: true });
const cards = {
  opened: openedSvg({ door: 3, sol: fmtSol(2_612_000_000n), grandSol: fmtSol(1_044_800_000n), winners: 5, grandWallet: shortAddr("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"), eligible: 412 }),
  countdown: countdownSvg({ door: 4, sol: fmtSol(1_307_500_000n), eligible: 455, opensIn: fmtDuration(3 * 3600 + 14 * 60 + 9) }),
  jackpot: jackpotSvg({ sol: fmtSol(9_120_000_000n), daysLeft: 21 }),
};
for (const [name, svg] of Object.entries(cards)) {
  const t = Date.now();
  const png = await renderPng(svg);
  writeFileSync(new URL(`${name}.png`, out), png);
  console.log(`${name}.png ${png.length} bytes in ${Date.now() - t} ms`);
}
