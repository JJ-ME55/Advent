// Card templates: fixed SVG with live numbers. Pure functions, no imports, so they also run in Node tests.
export const W = 1200, H = 675;
const C = { red: "#b3122b", cream: "#f7ead0", night: "#1d1033", gold: "#f4b63f", ink: "#2a1a0e", teal: "#1f8a8a" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

function frame(inner, { ticker, accent = C.gold }) {
  const stripes = [];
  const n = 16, sw = W / n;
  for (let i = 0; i < n; i++) {
    stripes.push(`<rect x="${i * sw}" y="0" width="${sw}" height="96" fill="${i % 2 ? C.cream : C.red}"/>`);
    // scalloped tent edge
    stripes.push(`<path d="M${i * sw} 96 Q ${i * sw + sw / 2} 140 ${(i + 1) * sw} 96 Z" fill="${i % 2 ? C.cream : C.red}"/>`);
  }
  const bulbs = [];
  for (let i = 0; i < 24; i++) {
    const x = 25 + i * 50;
    bulbs.push(`<circle cx="${x}" cy="${H - 34}" r="9" fill="${i % 2 ? accent : C.cream}" opacity="0.95"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="glow" cx="50%" cy="55%" r="65%">
      <stop offset="0%" stop-color="#3a1d5c"/><stop offset="100%" stop-color="${C.night}"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#glow)"/>
  ${stripes.join("")}
  <rect x="70" y="165" width="${W - 140}" height="${H - 262}" rx="28" fill="none" stroke="${accent}" stroke-width="5" stroke-dasharray="18 12"/>
  ${inner}
  <line x1="0" y1="${H - 34}" x2="${W}" y2="${H - 34}" stroke="#5b3b7a" stroke-width="3"/>
  ${bulbs.join("")}
  <text x="${W / 2}" y="${H - 64}" text-anchor="middle" font-family="Space Mono" font-size="22" fill="${C.cream}" opacity="0.8">TOMBOLA · ${esc(ticker)} · drand-verified draws on Robinhood Chain</text>
</svg>`;
}

const title = (t, y = 250, size = 92, fill = C.gold) =>
  `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Rye" font-size="${size}" fill="${fill}" stroke="${C.ink}" stroke-width="3" paint-order="stroke">${esc(t)}</text>`;
const big = (t, y, size = 112, fill = C.cream) =>
  `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Space Mono" font-size="${size}" fill="${fill}">${esc(t)}</text>`;
const line = (t, y, size = 38, fill = C.cream) =>
  `<text x="${W / 2}" y="${y}" text-anchor="middle" font-family="Space Mono" font-size="${size}" fill="${fill}">${esc(t)}</text>`;

export function winnerSvg({ round, eth, wallet, held, mega, ticker }) {
  return frame(
    title(mega ? "MEGA WINNER" : "WINNER", 255) +
      line(`DRAW #${round}`, 305, 30, C.gold) +
      big(`${eth} ETH`, 425) +
      line(wallet, 492, 44) +
      line(`held ${held} before the draw`, 545, 30, "#d9c7ff"),
    { ticker },
  );
}

export function potSvg({ pot, eligible, next, ticker }) {
  return frame(
    title("THE POT IS BUILDING", 250, 72) +
      big(`${pot} ETH`, 390) +
      line(`${eligible} wallets in the draw`, 465, 40) +
      line(`next drop ${next}`, 530, 34, C.gold),
    { ticker, accent: C.teal },
  );
}

export function countdownSvg({ pot, eligible, mega, ticker }) {
  return frame(
    title(mega ? "MEGA DROP IN" : "NEXT DROP IN", 245, 74) +
      big("60:00", 395, 150, C.gold) +
      line(`${pot} ETH in the drum`, 470, 44) +
      line(`${eligible} wallets in the draw`, 530, 34, "#d9c7ff"),
    { ticker, accent: C.red },
  );
}

