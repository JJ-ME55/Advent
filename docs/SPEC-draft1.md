# ADVENT — a 24-door prize calendar on Solana

*Draft 1, 24 Nov 2026. Tombola's draw machine, rebuilt for Solana with no smart contract, no audit, no swarm. Fees from one coin fill a door every day until Christmas; each door pays five holders, one of them big; Christmas Day pays the jackpot.*

## 1. The pitch

Every day at 18:00 UTC a door opens on the calendar. Behind it: that day's fees from the coin, paid out to five holders picked by drand's public randomness. One of the five gets half. Ten percent of every day goes into the big door on the 25th. Burns happen without warning. Hold the coin, you're in; the longer you hold, the more tickets you have. The team can't win: its wallets are excluded, and the list is public.

Content is the product: a reveal video every door, a countdown clip every four hours, a winner card on X within a minute of every payout. The site is the calendar.

## 2. What we're reusing from Tombola

| Piece | Tombola | Advent |
|---|---|---|
| Eligibility rule | 10k tokens, 30 min, 1x→3x over 72 h, any send resets the clock | same rule, Solana balances |
| List building | Transfer-log replay, canonical sorted list, Merkle root | same code over Solana token transfers (Helius), SHA-256 of the list instead of a Merkle root |
| Randomness | drand evmnet, verified on-chain by DrandBeacon | drand evmnet, verified off-chain by the verifier (no program to verify it on-chain) |
| Commit-before-reveal | `commit()` pins root + round on the Draw contract | a Memo transaction from the treasury pins `sha256(list)` + drand round before the round exists |
| Payout | contract pays the winner | treasury wallet sends SOL, memo "ADVENT door 3 / winner 2 of 5" |
| Keeper | bot/pons/keeper.mjs on Hetzner | same shape: claim fees → split → snapshot → commit → settle → burn |
| Site | tombola.lol | advent calendar; same Verify, same "Am I in" checker |
| X bot + cards | xbot (Cloudflare) | same, with door artwork |
| Videos | ElevenLabs barker + music | same pipeline, Christmas voice |

Nothing is audited because nothing is deployed: the only on-chain things are the pump.fun coin, memo transactions and SOL transfers. The trust model is "the keeper is honest and you can check": weaker than Tombola's, but it ships in days, not weeks, and it is exactly what the big "lotto coins" that worked did.

## 3. Launchpad: pump.fun

Launch on pump.fun, paired with SOL, creator fee wallet = the Advent treasury. Reasons:

- **Fees from the first trade.** 0.30% of every curve trade goes to the creator; after graduation to PumpSwap the creator fee is 0.95% of volume at low market caps, sliding down as the cap grows (0.75% at $1M, 0.30% at $10M). Claimable any time with `collect_creator_fee` — the keeper does it hourly.
- **No capital.** No LP to seed, no launch fee beyond pump's.
- **The audience is there.** Pump's board and the pump.fun app are where the daily-draw coins get found.

Why not StonkFun: its "reward" launches are Token-2022 coins with a 1% or 3% transfer tax, but StonkFun's wallet collects the tax and pays it pro-rata to holders itself — we never hold it, so we can't run a draw on it. Its standard launches pay the creator **nothing on the curve** (creator rate 0; 1% platform fee) and only share graduated-pool fees. Pump is the better fit for "fees fund a prize".

Alternative if we want a fatter take (3%+): our own Token-2022 mint with a transfer fee withdrawn to the treasury, in a Raydium CPMM pool we seed ourselves. Bigger cut, but needs seed SOL and we lose pump's distribution. Not for v1.

## 4. Money

Every claim from the creator vault is split:

| Share | Where | Why |
|---|---|---|
| 70% | today's door | the daily prize |
| 10% | Christmas door (25th) | the jackpot people hold for |
| 10% | burn | market-buy ADVENT and burn it at unannounced moments ("every so often there's a burn") |
| 10% | team | ours |

Daily door: 5 winners, weighted draw without replacement. Grand 50% of the door, the other four 12.5% each.

Worked example after graduation, $500k/day volume at ~$1M cap (0.75% creator fee = $3,750/day): door $2,625 (grand $1,312, four × $328), Christmas +$375/day → ~$9k on the 25th, burn $375/day, team $375/day → ~$9k to us by Christmas. At $2M/day it's four times that. On the curve before graduation it's 0.30%, so the pre-December warm-up is small money unless it graduates fast — which is fine, because the first door is "everything earned since launch".

## 5. Timeline

- **This week (launch day):** coin live on pump.fun, treasury claiming fees. Site shows the calendar with every door locked and one counter: "Door 1 opens 1 Dec 18:00 UTC, currently holding X SOL". Fees accrue to door 1. Content starts: countdown clips every 4 h.
- **1–24 Dec:** a door a day at 18:00 UTC. Snapshot at 17:50, list published, commit memo sent, drand round at 18:00:00, five payouts by 18:00:30, reveal video and cards out by 18:02.
- **25 Dec:** door 25 = the jackpot: one winner, same mechanics. Then the coin keeps trading; we either announce "Twelfth Night" doors or let it be.

## 6. The draw, exactly

Door *d* opens at `T_d = 2026-12-d 18:00:00 UTC`.

1. **Snapshot** at `T_d − 10 min`: the token's state after every transfer with blockTime ≤ snapshot time. For each wallet: balance and `holdStart` (reset to the transfer's time on any outgoing transfer; set on the first inbound into an empty wallet). Excluded: pump's bonding curve, the PumpSwap pool, the treasury, the burn address, the team wallets (listed in the published snapshot).
2. **Weights:** `weightFor(balance, holdStart, snapshotTime)` as Tombola: 0 if balance < MIN or held < 30 min; else `balance × mult`, `mult = 1 + 2 × min(held, 72 h) / 72 h`. MIN = 100,000 ADVENT (0.01% of the 1B supply).
3. **The list:** eligible wallets sorted by address, with cumulative weights. `listHash = sha256(canonical JSON)`. Published at `advent.lol/draws/door-d.json` and in the public draws repo.
4. **Commit:** the treasury sends a Memo transaction `ADVENT commit door=d hash=<listHash> round=<r> total=<W>` where `r` is the drand evmnet round whose time is `T_d` (round time = 1727521075 + (r − 1) × 3). The memo's block time must be < round time − 60 s; the verifier checks it.
5. **Randomness:** drand's signature for round `r`; `seed = sha256(signature)`.
6. **Winners:** for k = 1..5: `word_k = sha256(seed ‖ d ‖ k)`, `target = word_k mod W_k` over the list with earlier winners removed and weights re-summed. Winner 1 takes the grand share.
7. **Settle:** five SOL transfers from the treasury, each with memo `ADVENT door=d winner=k/5 hash=<listHash>`. Door 25 is one winner.
8. **Verify** (`verify-door.mjs d`, and the site's Verify): rebuild the list from the chain, check the hash matches the commit memo, check the memo predates the round, fetch drand's signature from three relays and check it against drand's public key, recompute the five winners, check the five payout transactions exist for them with the right amounts.

Nothing is enforced on-chain. What the design does guarantee is that we cannot pick the winners: the list is fixed and public before the number exists, the number is drand's, and anyone can redo the maths. What it does not guarantee is that we pay: there is no contract holding the pot. That's the trade for shipping without an audit, and it's honest to say so on the site ("the team holds the pot in a public wallet; every payout is a public transaction; here's the verifier").

## 7. The site (advent.lol or similar)

- **Calendar:** 5×5 grid of doors, 1–24 plus the big 25. Each door: locked (date, countdown) → open (winner cards, reveal video, verify link). Today's door is the hero with the live pot ("holding 3.21 SOL / $412 — opens in 02:14:33").
- **Am I in?** Paste a wallet: in the drum or not, tickets, odds for today's door, hold time, what to do about it.
- **Open your door:** if the pasted wallet is in today's list, after 18:00 the door animates and tells *them* whether they won. (Pure theatre on top of the public result, but it's the moment people screenshot.)
- **Jackpot door:** the 25th shows its growing pot all month.
- **Verify / Proofs / CA / Buy on pump:** as Tombola.
- Built from the Tombola site: same build, same CSP approach, same verify architecture; the fairground skin becomes a snowy fairground.

## 8. The keeper

One Node process on the Hetzner box (next to Tombola's), every 20 s:

1. **Claim** the creator vault when it holds > 0.05 SOL (pump's `collect_creator_fee` / `collect_coin_creator_fee` after graduation, via pump's SDK or PumpPortal).
2. **Split** on claim: 70/10/10/10 into four treasury sub-accounts (plain keypairs: door, jackpot, burn, team) so the site can show each pot as a public balance.
3. **Snapshot + commit** at `T_d − 10 min`: build the list (Helius enhanced transactions API for the mint's transfers since launch, cached locally), publish it, send the commit memo.
4. **Settle** at `T_d + 5 s`: fetch the drand round, compute, send the five transfers.
5. **Burn** when the burn pot is above a threshold, at a random minute within the next 24 h: market-buy on pump/PumpSwap, send to the incinerator, post "burned X".
6. **Publish** `snapshot.json` for the site and the bot; alert on any failure.

Keys: treasury keypair on the server, same hygiene as Tombola's keeper.

## 9. Content machine

- **Reveal video, daily:** 30–45 s, rendered automatically from the result: door creaks open, five names, grand winner, pot, "tomorrow's door is already filling". Voice: the carnival barker in a Santa hat (ElevenLabs, same voice), sleigh-bell version of the fairground music. Posted at 18:02 with the winner card.
- **Countdown clip, every 4 h:** 10 s, pot and time to the door. Rendered server-side, posted by the bot.
- **Winner cards:** per winner, as Tombola's cards, with the door number.
- **Burn posts:** after each burn, with the tx.
- The X bot does all of this automatically once it has X API keys and the paid Cloudflare plan (or we run it as a second process on the Hetzner box instead of Cloudflare — simpler, and it already has the card renderer).

## 10. Build plan

| Day | Done when |
|---|---|
| 1 | Coin launched on pump.fun from the treasury wallet. Keeper claims fees and splits them. Holding page live: calendar locked, door-1 pot counting. CA + X posted. |
| 2 | Snapshot/list/commit/settle path tested against a dry-run door (devnet or a test on the real chain with a 1-SOL pot). `verify-door.mjs` passes. Site: calendar, Am-I-in, Verify. |
| 3 | Reveal video + countdown clip rendering automated; bot posting (dry-run until keys). Burn job. |
| 1 Dec | Door 1. |

Day 1 is a day's work from the Tombola code. Days 2–3 are where the Solana-specific bits are (Helius indexing, pump's claim instruction, Memo program).

## 11. Decisions for JJ and Fish

1. **Name/ticker** — ADVENT / $ADVENT, or something sillier (DOOR, XMAS, SANTA…). pump.fun will have clones within the hour of whatever's chosen; the X account and site are the moat.
2. **Door time** — 18:00 UTC (1 pm New York, 7 pm London): good for both sides.
3. **Splits** — 70/10/10/10 as above, and 50/12.5×4 inside the door. Alternative: 3 winners (60/20/20) for bigger prizes with fewer holders early on.
4. **Minimum holding** — 100k (0.01%). Lower means more "in the drum" screenshots; higher means fewer dust wallets.
5. **4-hourly mini-draws or not** — I'd say no: one door a day keeps the pot meaningful; the 4-hourly content is the countdown clips, not payouts.
6. **Pre-December:** launch this week with door 1 as "everything since launch", or hold the coin until 30 Nov. Launching now is more fees but a long wait with nothing opening; a fix is three "warm-up doors" (27, 28, 29 Nov) at smaller pots so the feed has winners before December.
7. **Team wallets to exclude** — the list, so it goes in the published snapshot from day one.
