# ADVENT — spec (merged, 24 Nov 2026)

Fish's concept brief (`CONCEPT-fish.md`) merged with the technical draft (`SPEC-draft1.md`). Where they differed,
the choice and the reason are stated. Open decisions are at the end.

## 1. What it is

A Christmas memecoin on Solana whose trading fees fill a door every day. The site is an advent calendar. At door
time the backend draws that day's winners from the eligible holders using drand's public randomness; each holder
opens the door to see if they won (the draw happens first, the door only reveals it). Nobody is told they've won
until they open their door, and nothing is paid until they press Claim: the prize then goes to that wallet. A Bonus
Box per day rewards holders who finish the North Pole village game, the same way. Christmas Day is the mega door.

## 2. Timeline

| Date | What |
|---|---|
| Mon 30 Nov | Launch. A full day of fees builds door 1. |
| 1–24 Dec | One door a day at **18:00 UTC** (1 pm NY, 6 pm London; midnight UTC is dead for content). |
| 25 Dec | Christmas door: the jackpot pot plus that day's fees. |
| Bonus Box | Starts the day the village game is ready, announced in advance ("from door 8"). Not on the launch path. |

## 3. Launchpad and fees

**pump.fun, SOL pair, creator fee wallet = the Advent treasury.** Creator fee 0.30% of every curve trade, 0.95% on
PumpSwap at low cap (sliding to 0.30% by $10M). Claimed hourly by the keeper. No capital needed.

Fish's 3.5% isn't reachable on pump.fun or StonkFun (both cap the creator around 1%; their holder-reward modes pay
every holder pro-rata from *their* wallet, so they can't fund a draw). The way to 3.5% is our own Token-2022 coin
with a transfer fee and a Raydium pool we seed (2–5 SOL): fees land in our wallet natively. That's a different,
bigger launch; v1 is pump.fun with prizes scaled to the real fee. Decision 1 below.

**Split of every claim:** 70% today's door · 10% Christmas door · 10% Bonus Box · 10% team.
(Fish: 3% rewards / 0.5% team of 3.5% ≈ 86/14. With 1% in, 10% team is ~0.1% of volume; the 10% burn from draft 1
is dropped in favour of the Bonus Box pot. Burns can come back from the team share if wanted.)

## 4. Eligibility (Santa's Nice List)

Same rule as Tombola, ported:
- balance ≥ **MIN** (start: 100,000 of the 1B supply = 0.01%), held ≥ **30 min** before the snapshot;
- weight = balance × multiplier, 1× at 30 min rising to 3× at 72 h; any outgoing transfer resets the hold clock;
  an inbound into an empty wallet starts it;
- excluded and published with every snapshot: pump's bonding curve, the PumpSwap pool, the treasury and its
  sub-wallets, the team wallets, the burn address. Fixed before door 1, never changed.
- "Eligible holders" = wallets with weight > 0 at the snapshot. That number drives the winner count.

## 5. The door

- **Snapshot** at `T − 10 min` (17:50 UTC): list built, published (`draws/door-d.json`), `listHash = sha256(list)`.
- **Commit:** a Memo transaction from the treasury: `ADVENT commit door=d hash=<listHash> round=<r> total=<W>
  winners=<n>`; `r` is the drand evmnet round at `T`. The memo must land ≥ 60 s before the round.
- **Winner count** from eligible holders (Fish's curve): <100 → 1, 100+ → 2, 200+ → 5, 500+ → 10, 1000+ → 20,
  2500+ → 30, 5000+ → 50; then capped so no prize is under ~$20 (cap = floor(pot / $20)).
- **Prizes:** winner 1 (the grand) takes 40% of the door; the rest is split equally. With 1 winner, all of it.
- **Randomness:** drand round `r`, `seed = sha256(signature)`; winner k: `word_k = sha256(seed ‖ d ‖ k)`,
  `target = word_k mod W_k` over the list with earlier winners removed. Deterministic, recomputable.
- **Settle** at `T + 5 s`: the keeper fixes the winners and their amounts (door, winner list, lamports each, the
  drand round, the list hash) and **sends nothing**. The money stays in the door wallet until claimed.
- **Reveal:** `POST /door/:d/open` (wallet-signed) answers WIN + amount or no luck, for any settled door, any day;
  the site animates the door. A winner presses Claim: `POST /door/:d/claim` (a second signed message) pays that
  wallet from the door wallet, once, memo `ADVENT door door=d winner=k/n hash=<listHash>`.
- **No spoilers:** the published door names a winner only once they've opened. Prize sizes, the list, the hash, the
  round and the seed are public, so anyone can recompute who won; the site just doesn't say.
- **Unclaimed prizes** stay in their wallets. The rule (a deadline, roll into the Christmas pot) isn't decided;
  `CLAIM_DEADLINE_SECONDS` exists for when it is (default: none).
- **Verify:** `verify-door.mjs d` and the site's Verify rebuild the list from the chain, check the hash against the
  commit memo and the memo's time against the round, check drand's signature from three relays, recompute the
  winners and find their payout transactions.

Nothing is enforced by a program. The design proves we *couldn't pick* the winners; it doesn't force us to pay. The
site says so: "the pot sits in a public wallet, every payout is a public transaction, here's the verifier".

## 6. Bonus Box (village game)

Fish's loop: pick a character, earn 20 coins a day in the North Pole village (10 hidden around the map, 10 from three
daily jobs paying 3 + 3 + 4: Sleigh Ride, Special Delivery, Runaway Reindeer, Elf Trouble), bank them at the Post
Office, open the box.
Two changes for safety and simplicity:
- **No race.** Everyone who banks their 20 before the door's snapshot is entered; **10 winners are drawn** from them with the
  same drand round as the door (`sha256(seed ‖ d ‖ "bonus" ‖ k)`). A "first 10" race is a bot contest; a draw makes
  bots pointless.
- **Server is the judge** (Fish's anti-cheat kept): coin positions server-side, revealed near the player;
  pickups checked for distance and speed; jobs judged from the run's position history; one session per wallet;
  the wallet must be on the Nice List.
- Bonus pot split into 10 random amounts (seeded from the same drand round, so it's verifiable too).

## 7. The site (Fish)

Home with the sleigh, countdown, today's pot. Calendar: locked / today / opened doors. Pot page: fees collected,
door pot, Christmas pot, bonus pot, total paid, winner history with tx links. Am I in? (paste or connect a wallet:
tickets, odds, hold time). Village. Verify. Wallet connect everywhere. Built on the Tombola site's bones
(`ref/tombola-site`): same build/CSP, same Verify architecture, Christmas skin.

## 8. Backend (JJ / Claude)

One Node service on the Hetzner box: the keeper loop plus a small HTTP API.

Keeper (every 20 s): claim creator fees when > 0.05 SOL → split 70/10/10/10 into four public wallets → at 17:50
snapshot, publish, commit memo → at 18:00:05 settle → publish `snapshot.json` → alert on failure.

API (all reads public; writes wallet-signed with a nonce):

| Endpoint | Returns / does |
|---|---|
| `GET /pot` | fees collected, today's door pot, Christmas pot, bonus pot, total won, total paid |
| `GET /door/:d` | locked/open, winner count, eligible count, countdown |
| `POST /door/:d/open` · `/claim` | WIN + amount or no luck (any settled door); claim pays once |
| `GET /winners/:d` | prize counts and totals, verify data, and only the winners who have opened |
| `GET /eligible/:wallet` | on the Nice List?, tickets, odds, hold time |
| `POST /village/session` · `/move` · `/pickup` · `/job/start` · `/job/finish` · `/bank` | the game, server-judged (`docs/API.md`) |
| `GET /bonus/:d` · `POST /bonus/:d/open` · `/claim` | entrants, claimed count, reveal, claim |

Data: Helius (free tier) for the mint's transfer history; a local SQLite ledger; drand via the Tombola lib.

## 9. Content

Reveal video per door (30–45 s, auto-rendered from the result), countdown clip every 4 h, winner cards on X within
a minute (door opened: how much for how many, "open yours"; a claim: the wallet shortened), burns if any. Voice: the carnival barker in a Santa hat; the fairground music with
sleigh bells. The X bot from Tombola, run on the Hetzner box next to the keeper (no Cloudflare).

## 10. Build plan

| Day | Done when |
|---|---|
| 1 (24–25 Nov) | `keeper/`: Solana client with fallback RPC, list replay from Helius, draw maths, commit memo, payouts, tests. |
| 2 (26 Nov) | Keeper loop + fee claim on pump.fun + API; dry-run door on devnet. Verifier. Site data layer for Fish. |
| 3 (27 Nov) | Cards, countdown clips, reveal video pipeline, bot (dry-run). Launch checklist. |
| 30 Nov | Launch from the treasury wallet; door 1 pot starts. |
| 1 Dec | Door 1. |
| Village | Claude + Fish, in parallel, ships when ready. |

## 11. Decisions (JJ)

1. **Launchpad:** pump.fun at ~1% (recommended for 30 Nov), or our own Token-2022 coin at 3.5% with seeded LP.
2. **Split:** 70 / 10 / 10 / 10 (door / Christmas / bonus / team).
3. **Winner curve:** Fish's table + the $20 floor; grand 40%, rest equal.
4. **Eligibility:** 100k tokens, 30 min, 1×→3× over 72 h.
5. **Payout:** on claim, after opening the door (Fish, 25 Nov). Unclaimed prizes: rule still open.
6. **Draw method:** drand + published snapshot + commit memo (as above).
7. **Doors:** 25, with the Christmas finale.
8. **Backend:** Hetzner, plain HTTP for the village.
9. **Name / ticker, door time (18:00 UTC), team wallets to exclude.**
