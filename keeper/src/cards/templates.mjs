// Card templates: fixed SVG with live numbers, 1200x675 (X's 16:9). Pure functions, no imports, so they also run
// in tests. Christmas skin of Tombola's fairground cards: night sky, snow, a door with a brass number.
export const W = 1200, H = 675;
const C = { red: "#b3122b", green: "#1f5e3a", cream: "#f7ead0", night: "#0f1a33", gold: "#f4b63f", ink: "#2a1a0e", snow: "#ffffff" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function frame(inner, { accent = C.gold } = {}) {
  const flakes = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 90; i++) flakes.push(`<circle cx="${(rnd() * W).toFixed(0)}" cy="${(rnd() * H).toFixed(0)}" r="${(1 + rnd() * 3).toFixed(1)}" fill="${C.snow}" opacity="${(0.25 + rnd() * 0.6).toFixed(2)}"/>`);
  const bulbs = [];
  for (let i = 0; i < 24; i++) bulbs.push(`<circle cx="${25 + i * 50}" cy="${H - 34}" r="9" fill="${i % 3 === 0 ? C.red : i % 3 === 1 ? accent : C.green}" opacity="0.95"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs><radialGradient id="sky" cx="50%" cy="40%" r="70%"><stop offset="0%" stop-color="#22345e"/><stop offset="100%" stop-color="${C.night}"/></radialGradient></defs>
  <rect width="${W}" height="${H}" fill="url(#sky)"/>
  ${flakes.join("")}
  <path d="M0 ${H - 120} Q 300 ${H - 190} 600 ${H - 130} T ${W} ${H - 150} L ${W} ${H} L 0 ${H} Z" fill="#e9f1fb"/>
  <rect x="70" y="60" width="${W - 140}" height="${H - 200}" rx="28" fill="none" stroke="${accent}" stroke-width="5" stroke-dasharray="18 12"/>
  ${inner}
  <line x1="0" y1="${H - 34}" x2="${W}" y2="${H - 34}" stroke="#5b3b7a" stroke-width="3"/>
  ${bulbs.join("")}
</svg>`;
}

const TX = 720; // text column centre: the door sits on the left
const title = (t, y = 150, size = 64, fill = C.cream) => `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Rye" font-size="${size}" fill="${fill}">${esc(t)}</text>`;
const big = (t, y, size = 120, fill = C.gold) => `<text x="${TX}" y="${y}" text-anchor="middle" font-family="Rye" font-size="${size}" fill="${fill}" stroke="${C.ink}" stroke-width="3">${esc(t)}</text>`;
const line = (t, y, size = 34, fill = C.cream) => `<text x="${TX}" y="${y}" text-anchor="middle" font-family="Space Mono" font-size="${size}" fill="${fill}">${esc(t)}</text>`;

/** The door: a red door with a brass number, left of centre. */
function doorArt(n, x = 170, y = 200, open = false) {
  const w = 170, h = 270;
  const leaf = open
    ? `<path d="M${x} ${y} L${x + w * 0.55} ${y - 30} L${x + w * 0.55} ${y + h + 30} L${x} ${y + h} Z" fill="${C.red}" stroke="${C.ink}" stroke-width="5"/>`
    : `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.red}" stroke="${C.ink}" stroke-width="5"/>`;
  return `<rect x="${x - 14}" y="${y - 14}" width="${w + 28}" height="${h + 28}" rx="20" fill="${C.green}" stroke="${C.ink}" stroke-width="4"/>
  ${open ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#fff3c4"/>` : ""}
  ${leaf}
  <circle cx="${x + w / 2}" cy="${y + h / 2 - 20}" r="42" fill="${C.gold}" stroke="${C.ink}" stroke-width="4"/>
  <text x="${x + w / 2}" y="${y + h / 2 - 4}" text-anchor="middle" font-family="Rye" font-size="48" fill="${C.ink}">${esc(n)}</text>
  <circle cx="${x + w - 30}" cy="${y + h / 2 + 50}" r="8" fill="${C.gold}"/>`;
}

/** After a door opens: the grand winner, the count, the prize. */
export function openedSvg({ door, sol, winners, eligible, ticker = "$ADVENT", site = "adventcoin.lol" }) {
  const inner = `${title(`Door ${door} is open`, 140)}
  ${doorArt(door, 120, 200, true)}
  ${big(`${sol} SOL`, 300, 110)}
  ${line(`${winners} ${winners === 1 ? "winner" : "winners"} among ${eligible} on the Nice List`, 360)}
  ${line(`Open yours at ${site}`, 410, 30, C.gold)}
  ${line(`${ticker} · nobody knows who until they open · draw is public`, 470, 22)}`;
  return frame(inner, { accent: C.gold });
}

/** Someone opened their door and claimed: the wallet shortened, never more. */
export function claimSvg({ door, sol, wallet, kind = "door", ticker = "$ADVENT" }) {
  const inner = `${title(kind === "bonus" ? `Bonus Box ${door} claimed` : `Door ${door} claimed`, 140)}
  ${doorArt(door, 120, 200, true)}
  ${big(`${sol} SOL`, 300, 110)}
  ${line(`to ${wallet}`, 360, 30, C.gold)}
  ${line(kind === "bonus" ? "found all 20 coins in the village and won the draw" : "opened their door and found a prize", 410)}
  ${line(`${ticker} · paid on claim · every payout is a public transaction`, 470, 22)}`;
  return frame(inner, { accent: C.gold });
}

/** Before a door: the pot so far and the countdown. */
export function countdownSvg({ door, sol, eligible, opensIn, ticker = "$ADVENT" }) {
  const inner = `${title(`Door ${door} opens in ${opensIn}`, 140)}
  ${doorArt(door, 120, 200, false)}
  ${big(`${sol} SOL`, 300, 110)}
  ${line(`${eligible} wallets on Santa's Nice List right now`, 360)}
  ${line(`Hold ${ticker} 30 min before the snapshot. More time, more tickets.`, 420, 22)}`;
  return frame(inner, { accent: C.red });
}

/** The jackpot door. */
export function jackpotSvg({ sol, daysLeft, ticker = "$ADVENT" }) {
  const inner = `${title("Christmas Day door", 140)}
  ${doorArt(25, 120, 200, false)}
  ${big(`${sol} SOL`, 300, 110)}
  ${line(`${daysLeft} days to go · 10% of every door goes in here`, 360)}
  ${line(`${ticker}`, 420, 28)}`;
  return frame(inner, { accent: C.green });
}
