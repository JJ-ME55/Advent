// The bank of lines, in a fairground host's voice. One is picked at random per post, never the same
// one twice in a row for a kind, and live numbers are filled in, so no two posts read the same.
// Rules: facts and hype only. No price talk, no promises, no "guaranteed", no links.
//
// Placeholders: {ticker} {round} {eth} {wallet} {held} {pot} {eligible} {next} {mins} {total}
// {biggest} {holders} {mega} {megaIn} {ca} {n} {draws}

export const LINES = {
  // Right after a regular drop. Every line names the round, the ETH, the wallet and the hold time.
  winner: [
    "Roll up, roll up! The drum has spoken. Draw {round} goes to {wallet}: {eth} ETH, after holding {held}.",
    "Ding ding ding! {wallet} takes draw {round} and walks off with {eth} ETH. Held for {held}.",
    "And the ticket out of the drum reads... {wallet}! Draw {round}, {eth} ETH, held {held}.",
    "Step aside, folks, we have a winner. {wallet} scoops {eth} ETH in draw {round} after {held} of holding.",
    "The barrel rolled, the ball dropped: draw {round} pays {eth} ETH to {wallet}, a holder of {held}.",
    "Draw {round} is done and dusted. {eth} ETH sails off to {wallet}, who had held for {held}.",
    "Hold onto your hats! {wallet} wins draw {round}: {eth} ETH. Time held: {held}.",
    "Ladies, gents and degens: {eth} ETH to {wallet} in draw {round}. They'd held {held}.",
    "Another lucky ticket! Draw {round} lands on {wallet} for {eth} ETH. Held {held}.",
    "Prize table cleared! {wallet} takes {eth} ETH from draw {round}, held for {held}.",
    "The wheel has stopped on {wallet}. Draw {round}, {eth} ETH, {held} of patience.",
    "Ring the bell! Draw {round} winner: {wallet}. Prize: {eth} ETH. Held: {held}.",
    "Who's the lucky one? {wallet}, that's who. {eth} ETH in draw {round}, after {held}.",
    "From the drum to the wallet: {eth} ETH to {wallet} for draw {round}. Held {held}.",
    "The crowd goes wild! {wallet} wins draw {round} and {eth} ETH. Holding time: {held}.",
    "Tombola draw {round} is in the books: {wallet} wins {eth} ETH, having held {held}.",
    "Pop goes the prize! {eth} ETH to {wallet} in draw {round}. Held {held}.",
    "Spin, drop, pay. Draw {round}: {wallet} collects {eth} ETH after {held}.",
    "Big cheer for {wallet}! Draw {round} pays {eth} ETH. They held for {held}.",
    "One ticket, one winner. Draw {round} goes to {wallet} for {eth} ETH, held {held}.",
    "The drum picked {wallet} for draw {round}. {eth} ETH, paid on-chain. Held {held}.",
    "Roll up and see! {wallet} is draw {round}'s winner: {eth} ETH after {held} holding {ticker}.",
  ],
  // Right after a weekly mega drop.
  winnerMega: [
    "THE MEGA DROP HAS LANDED! {wallet} wins the weekly mega, draw {round}: {eth} ETH. Held {held}.",
    "Drumroll for the big one... the weekly mega goes to {wallet}! {eth} ETH, draw {round}, held {held}.",
    "Mega night at the fair! {wallet} takes the weekly mega, {eth} ETH, after holding {held}. Draw {round}.",
    "The giant drum has turned: weekly mega draw {round} pays {eth} ETH to {wallet}. Held {held}.",
    "Stop the music! {wallet} wins the mega: {eth} ETH in draw {round}, holding {held}.",
  ],
  // A drop where nobody was eligible.
  rollover: [
    "Draw {round}: the drum spun but no ticket was eligible, so {eth} ETH rolls into the next drop.",
    "No eligible tickets in draw {round}. The {eth} ETH pot stays in the drum for next time.",
    "Empty drum in draw {round}! {eth} ETH rolls over. Hold 30 minutes to get your ticket in.",
  ],
  // One hour after a drop.
  pot: [
    "The pot's building again! {pot} ETH in the drum, {eligible} wallets in the draw. Next drop at {next}.",
    "Roll up! {pot} ETH and climbing. {eligible} tickets in the drum for the {next} drop.",
    "Fresh pot on the table: {pot} ETH so far, {eligible} eligible wallets. Drum spins at {next}.",
    "Every trade feeds the drum. Pot: {pot} ETH. In the draw: {eligible} wallets. Next spin: {next}.",
    "The prize table is filling up: {pot} ETH, {eligible} wallets eligible, drop at {next}.",
    "Pot check! {pot} ETH waiting for one lucky holder. {eligible} wallets in. Next drop {next}.",
    "Step right up, the next pot is at {pot} ETH. {eligible} tickets in the drum. Draw at {next}.",
    "Tick tock, the pot grows: {pot} ETH with {eligible} wallets in the running for {next}.",
    "Keep your tickets warm. Pot: {pot} ETH. Eligible: {eligible}. Drop time: {next}.",
    "The barker reports: {pot} ETH in the pot and {eligible} wallets in the draw. Next drop {next}.",
    "Hold 30 minutes to be in it. Current pot {pot} ETH, {eligible} wallets eligible, next drop {next}.",
  ],
  // One hour before a regular drop.
  countdown: [
    "Roll up! The drum spins in 60 minutes. Pot is {pot} ETH. {eligible} wallets in the draw.",
    "60 minutes to the drop! {pot} ETH in the pot, {eligible} tickets in the drum.",
    "One hour, folks! {pot} ETH on the line and {eligible} wallets in the draw.",
    "Last hour before the spin. Pot: {pot} ETH. Eligible wallets: {eligible}.",
    "The drum warms up: 60 minutes to go, {pot} ETH to win, {eligible} wallets in.",
    "Countdown on! The next drop is in an hour. {pot} ETH, {eligible} tickets.",
    "Step right up, there's still an hour. {pot} ETH in the pot, {eligible} wallets eligible.",
    "In 60 minutes one holder takes {pot} ETH. {eligible} wallets are in the draw.",
    "The bell rings in an hour! Pot {pot} ETH, {eligible} tickets in the drum.",
    "Get your tickets in! 60 minutes left, {pot} ETH pot, {eligible} wallets in the draw.",
    "One hour on the clock. The drum holds {pot} ETH and {eligible} tickets.",
  ],
  // One hour before the weekly mega.
  countdownMega: [
    "THE WEEKLY MEGA SPINS IN 60 MINUTES! {mega} ETH in the giant drum. {eligible} wallets in the draw.",
    "One hour to the mega drop! {mega} ETH on the table, {eligible} tickets in.",
    "Mega countdown: 60 minutes, {mega} ETH, {eligible} eligible wallets.",
  ],
  // About four a day.
  statTotalPaid: [
    "Roll up for the tally! Tombola has paid out {total} ETH to holders over {draws} draws.",
    "The prize counter reads {total} ETH paid to winners so far, across {draws} draws.",
    "So far the drum has handed out {total} ETH in {draws} draws. Every one checkable on-chain.",
  ],
  statBiggest: [
    "Biggest single drop so far: {biggest} ETH. The drum remembers.",
    "Record on the board: {biggest} ETH in one drop. Who's next?",
    "The high score at the fair: one drop of {biggest} ETH.",
  ],
  statHolders: [
    "{holders} wallets now hold at least 10,000 {ticker}. The fair is filling up!",
    "Head count at the fair: {holders} holders of 10,000+ {ticker}, {eligible} in the next draw.",
    "Roll up! {holders} holders on the grounds and {eligible} tickets in the drum right now.",
  ],
  statMega: [
    "The weekly mega spins in {megaIn}. {mega} ETH in the giant drum so far.",
    "Mega watch: {mega} ETH and counting, drawn in {megaIn}.",
    "The big drum fills all week: {mega} ETH now, spinning in {megaIn}.",
  ],
  statContract: [
    "The only official {ticker} contract: {ca}",
    "Check the ticket before you buy. Official {ticker} contract address: {ca}",
    "One fair, one contract. {ticker}: {ca}",
  ],
  // Milestones.
  milestoneFirst: [
    "The very first Tombola drop has been drawn! Draw {round} paid {eth} ETH to {wallet}. Many more to come.",
    "History at the fair: drop number one is paid. {eth} ETH to {wallet}.",
  ],
  milestonePaid: [
    "Milestone! Tombola has now paid out more than {n} ETH to holders.",
    "Ring the big bell: over {n} ETH paid out in prizes so far.",
    "{n} ETH and up paid to winners. The drum keeps turning.",
  ],
  milestoneHolders: [
    "Milestone! {n} wallets now hold at least 10,000 {ticker}. Welcome to the fair.",
    "The grounds are packed: {n} holders of 10,000+ {ticker}.",
  ],
  // Swarm check results.
  swarmFair: [
    "The swarm checked the last 6 hours of draws: all fair. {draws} draws recomputed from public data by an independent panel.",
    "Independent check done. IMD's swarm recomputed the last 6 hours of draws ({draws}) and found them all fair.",
  ],
  swarmUnfair: [
    "The swarm checked the last 6 hours of draws and did NOT confirm them as fair. We're looking into it now and will report back.",
    "Swarm check result: the panel flagged a problem with the last 6 hours of draws. We're investigating and will post what we find.",
  ],
  swarmNoAnswer: [
    "The swarm check of the last 6 hours of draws ended without an answer: the panel couldn't agree. Anyone can run verify-draw on every draw.",
    "No verdict from the swarm this time: the panel didn't reach agreement on the last 6 hours of draws. Every draw can still be verified from public data.",
  ],
  // A paid check that ended for any reason other than a split panel. {reason} is a plain phrase
  // from swarm.js FAIL_REASON, e.g. "IMD refused the request" or "no answer within 72 hours".
  swarmIncomplete: [
    "The swarm check of the last 6 hours of draws didn't complete ({reason}), so there is no verdict either way. Anyone can run verify-draw on every draw.",
    "No swarm verdict this time: the check stopped before an answer ({reason}). It says nothing about the draws, and each one can still be verified from public data.",
  ],
};

// Appended to a winner post when no pool buy was found for the winner before the draw. The bot's
// buy detection is a heuristic (transfers out of the Pons curve or the PoolManager, and one router hop
// in the same transaction), so the note says what was found rather than claiming provenance (finding 15).
export const NO_BUY_FLAG = "Heuristic note: no pool buy found for this wallet before the draw.";
// ...and when the pool buys found cover less than a tenth of the winner's balance at the snapshot.
export const SMALL_BUY_FLAG = "Heuristic note: pool buys found cover under 10% of this wallet's tokens.";
// ...and, instead of either, when the draw list rebuilt from the token's Transfer logs does not have the root the
// keeper pinned on chain (the one check the contract can't make). The Worker log carries the two roots.
export const ROOT_FLAG = "Note: the rebuilt draw list does not match the on-chain root. Investigating.";
// The longest flag, for the 280-character test.
export const TRANSFER_FLAG = [SMALL_BUY_FLAG, NO_BUY_FLAG, ROOT_FLAG].sort((a, b) => b.length - a.length)[0];

/** Fills placeholders. Unknown placeholders are left visible so a test catches them. */
export function fill(line, vars) {
  return line.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

/** Picks a line for `kind`, never the same index as `lastIndex`. */
export function pick(kind, lastIndex, rand = Math.random) {
  const bank = LINES[kind];
  if (!bank?.length) throw new Error(`no lines for ${kind}`);
  if (bank.length === 1) return { index: 0, line: bank[0] };
  let i = Math.floor(rand() * bank.length);
  if (i === lastIndex) i = (i + 1 + Math.floor(rand() * (bank.length - 1))) % bank.length;
  return { index: i, line: bank[i] };
}

export function lineCount() {
  return Object.values(LINES).reduce((a, b) => a + b.length, 0);
}
