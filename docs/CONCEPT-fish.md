# Advent Coin — Concept Brief

**Working title:** Advent Coin (name and ticker TBC)
**Owners:** JJ = token, launch, fees, draws, payouts, backend. Fish = website + UI. Claude builds the village game with Fish.
**Status:** Idea, 24 Nov 2026. Launch target **Mon 30 Nov 2026**.

---

## 1. The idea in one paragraph

A Christmas memecoin whose trading fees fund daily prizes. The website is a giant advent calendar. Every day from 1 December, each holder can open that day's door and find out if they've won a share of the fees. The more holders the coin has, the more winners there are each day. On top of that, every day has a **Bonus Box**: holders who find all 20 hidden coins in a North Pole village mini-game and bank them can open it. Only the first 10 to finish each day win.

## 2. Timeline

| Date | What happens |
|---|---|
| Mon 30 Nov | Token launches. A full day of fees builds the first pot before Door 1. |
| 1 Dec → 24 Dec | One door per day. Daily winners + daily Bonus Box. |
| 25 Dec (suggested) | Christmas Day mega door: whatever is left in the pot plus a bigger share. |

Open: 24 doors (traditional) or 25 with a Christmas Day finale. Fish leans towards a big finale.

## 3. Fees

**What Fish wants:**
- **3.5% buy and sell fee:** 3% to rewards, 0.5% to team.
- If the platform takes its own cut on top, raise ours to cover it. **Hard cap: 5% total per side.**
- Rewards are split between the **daily door pot** (most of it) and the **Bonus Box pot** (smaller). Suggested start: 80% door / 20% bonus. JJ to tune.

**Launchpad: JJ's call.** Notes from a quick research pass on 24 Nov. These come from secondary sources and need checking on the live launch forms:
- **pump.fun:** Custom Pairs launches reportedly let you pick a creator fee of 0.05% to 1%. Standard SOL pairs seem to keep fixed tiers (about 0.3% on the curve, lower after graduation). Fees can be split across up to 10 wallets. "Holder Rewards" (up to 3%) is paid to all holders pro-rata, so it can't fund our own draws.
- **StonkFun:** A standard launch has a 1% or 2% pool fee, and the creator gets about half at 1%. Its 1%/3% "reward" tax goes to all holders through StonkFun's wallet, not to us. A Bitquery report (Sept 2026) says StonkFun can still change the tax on reward coins.
- I found nothing confirming a creator-controlled fee above 2% on either platform. If neither reaches 3.5%, we need another launchpad, or we scale prize counts down to whatever the fee really is.
- **Requirement for whichever platform:** the fees must land in a wallet *we* control, so we can run our own draws.

## 4. The daily door

- Each day's door unlocks at a fixed time (suggest **00:00 UTC**).
- Any eligible holder can open it **once per wallet per day** and sees **WIN** (with amount) or **no luck**.
- **The draw happens first; opening the door only reveals it.** At unlock time the backend snapshots eligible holders and draws that day's winners. Opening the door shows each person their result. Nobody can game it by opening early or late.
- **Payout:** automatic send to winners (simplest UX), or a claim button behind the door. JJ to choose.
- **Provably fair:** Tombola's approach suits this well: pin the snapshot, use a public random beacon (drand), and publish a Verify link. This matters for a prize coin.

### Number of winners scales with holders

Fish's example. JJ to set the final curve. Prizes should stay meaningful, so winner counts grow more slowly than holder counts.

| Eligible holders | Winners that day |
|---|---|
| < 100 | 1 |
| 100+ | 2 |
| 200+ | 5 |
| 500+ | 10 |
| 1,000+ | 20 |
| 2,500+ | 30 |
| 5,000+ | 50 |

- The day's door pot is split across the winners. Equal split or tiered (one big + several small) is up to JJ.
- **Eligibility (needed, because otherwise one person splits into 500 wallets):**
  - a minimum token balance
  - a minimum hold time before the snapshot
  - holder count = **eligible** holders only, not every dust wallet

## 5. The Bonus Box (village game)

**Daily loop:**
1. A holder signs in with their wallet and picks a character: elf, snowman or Santa.
2. They explore the North Pole village. **20 coins** are hidden around it each day (in shops, on hills, behind houses and market stalls).
3. They collect all 20 and carry them back to the **bank** (e.g. the post office / Santa's workshop).
4. Banking marks the wallet as "Bonus earned" for that day.
5. They open the day's **Bonus Box** and get their prize.

**Rules:**
- **The first 10 wallets to bank all 20 coins win.** After that the box is closed for the day; the site should show "10/10 claimed" live.
- **The bonus pot is split into 10 random amounts.** Each winner's box reveals one at random, so prizes vary.
- One bonus per wallet per day. The wallet must also be an eligible holder.
- Coin positions change every day, so knowing yesterday's map doesn't help.

**Anti-cheat (the main risk):** a race for money invites bots. The server must be the judge, never the browser:
- The server holds that day's coin positions. The client never gets the full list up front; it gets them as the player gets near them.
- Each pickup is checked server-side: was the player close enough, and could they have got there that fast from their last position?
- The finish time is recorded on the server; the server alone decides who's first.
- Rate limits, plus one session per wallet at a time.

## 6. Website

Fish builds these.

- **Home:** full Christmas scene. Santa's sleigh flies around the page non-stop, with "Ho ho ho!" sound. Snow, lights, magic. Countdown to the next door.
- **Calendar:** 24 (or 25) doors. Today's is openable; past doors show who won; future doors are locked.
- **Tokenomics / Pot:** live view of fees collected, today's door pot, today's bonus pot, total paid out, winner history with links to the transactions.
- **Village:** the mini-game (Claude + Fish build it, high-quality 3D North Pole market village).
- **Wallet connect** on every page.

## 7. What the backend needs to give the front end

A first sketch, for JJ to change as needed:

| Endpoint | Returns / does |
|---|---|
| `GET /pot` | Fees collected, today's door pot, bonus pot, total paid |
| `GET /door/:day` | Status (locked/open), winner count, eligible holder count |
| `POST /door/:day/open` | (wallet-signed) WIN + amount, or no luck |
| `GET /winners/:day` | Winners list + transaction links + verify data |
| `POST /village/session` | (wallet-signed) Starts a run; returns spawn + nearby coins |
| `POST /village/pickup` | Player position + coin id; server validates |
| `POST /village/bank` | Banks coins; returns place (1–10) or "box closed" |
| `POST /bonus/:day/open` | Reveals and pays the random bonus amount |
| `GET /bonus/:day` | Claimed count (x/10) |

## 8. Open decisions for JJ

1. Launchpad, and whether it can actually hit about 3.5% to us (see §3).
2. Final split: door pot / bonus pot / team.
3. Winner-count curve and how prizes are split per door.
4. Eligibility: minimum balance and hold time.
5. Payout: auto-send or claim.
6. Draw method: reuse the Tombola-style drand + snapshot?
7. 24 doors or 25 (Christmas Day finale)?
8. Where the backend runs and how the village game talks to it (normal HTTP calls or a live connection).

## 9. Who does what

| Fish | JJ | Claude (with Fish) |
|---|---|---|
| Website UI, calendar, pot page, Santa sleigh, branding, marketing | Launch, fee wallets, eligibility, draws, payouts, backend API, anti-cheat on the server | 3D North Pole village game: characters, coins, bank, connected to JJ's API |
