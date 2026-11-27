# ADVENT API (for the site)

Base URL: the keeper box, `https://api.adventcoin.lol` (CORS open to adventcoin.lol, www.adventcoin.lol,
advent-calendar-site.vercel.app and north-pole-village.vercel.app). JSON everywhere; lamports
are decimal strings; times are unix seconds. Everything the API serves is also published as files the keeper
writes (`snapshot.json`, `door-<d>.json`), so the site can be fully static against a CDN copy if we want.

**It's an advent calendar.** Nobody is told they've won until they open their door, and nothing is paid until they
press Claim. So: the draw is fixed at door time, the published data names a winner only once they've opened, and the
site shows the winners list for a door only to a viewer who has opened it. "The drum" is **Santa's Nice List** in
every user-facing text.

## Reads

| Endpoint | Returns |
|---|---|
| `GET /pot` | `{ at, pots: { treasury, door, xmas, bonus }, claimed, totalWon, totalPaid, nextDoor, nextDoorAt, wallets }` — `pots.door` is today's prize so far (door wallet minus gas reserve, including prizes not yet claimed); `totalWon` every prize drawn, `totalPaid` what has been claimed. |
| `GET /door/:d` | `{ door, status, opensAt, snapshotAt, secondsToOpen, winnerCount, eligible, pot, commit: { signature, blockTime, hash }, round }` — `status` is `locked` (future), `locked-in` (snapshot taken, commit on chain, countdown running), `due` (past time, not yet settled: drand/keeper late), `open` (drawn; holders can open and claim). |
| `GET /winners/:d` | `{ door, hash, round, seed, signature, commit, pot, eligible, winnerCount, totalLamports, openedCount, claimedCount, claimedLamports, unclaimedLamports, winners: [{ k, account, lamports, opened, claimed, claimSignature }], bonus: { winnerCount, …, winners: [...] } }` — **no spoilers:** `winners` holds only the winners who have opened or claimed (k = 1 is the grand). Counts and totals cover everyone. `seed`, `signature` (drand) and `commit` are what Verify needs; 404 until settled. |
| `GET /eligible/:wallet` | `{ wallet, holder, inDrum, balance, holdStart, heldSeconds, tickets, totalTickets, odds, reason }` — `inDrum` = on Santa's Nice List (the field name stays); odds is a fraction (0.0137 = 1.37%); `reason` says why not. Computed live from the published balance history at "now". |
| `GET /bonus/:d` | `{ door, phase, entrants, playing, closesAt, drawAt, winnerCount, totalLamports, openedCount, claimedCount, claimedLamports, winners: [opened or claimed only] }` — `phase` is `open` (runs count), `closed` (snapshot taken, drawing at `drawAt`), `drawn`. |
| `GET /village/layout` | `{ spawn, bank, coins: 10, jobCoins: 10, firstDoor, givers: { taxi, delivery, chase, brawl }, taxiPoints, deliveryDoors, ringRoad, respawns }` — the layout file Fish exports, as the server read it. |
| `GET /village/map/:d` | `{ door, coins: [...], jobs: [...] }` — the day's 10 hidden-coin positions, **403 until that door's entries close** (then anyone can see where they were); the 403 body already carries the day's `jobs`, which were never secret. |

## Wallet-signed writes

1. `GET /nonce/:wallet` → `{ nonce, expiresIn, formats }`. The message to sign is `ADVENT <action> <wallet> <nonce>`
   (`formats` spells each one out); nonces last 5 minutes and are single-use. There is deliberately no `message`
   field: the site builds the string itself from the action it's about to do.
2. Sign it with the wallet (`signMessage` in wallet adapters; ed25519 over the UTF-8 bytes), base58-encode the signature.
3. Every write takes `{ wallet, nonce, signature }`; 401 `{ ok: false, error }` on a bad or reused nonce/signature.

| Write | Message | Answer |
|---|---|---|
| `POST /door/:d/open` | `ADVENT open-<d> <wallet> <nonce>` | `{ ok: true, door, wallet, inDrum, won, k, lamports, claimed, claimSignature, claimedAt }` for **any settled door, any day** (missed a day? open it later). 409 `{ ok: false, error, status, opensAt }` while the door is locked or still settling. Opening is remembered: from then on the wallet appears in `GET /winners/:d`. |
| `POST /door/:d/claim` | `ADVENT claim-<d> <wallet> <nonce>` | Pays the prize from the door wallet, once, memo `ADVENT door door=d winner=k/n hash=…`. 200 `{ ok: true, claimed: true, lamports, signature }`; 409 `{ claimed: true, signature, lamports }` if already claimed (the earlier tx); 409 `{ ok: false, pending: true }` if a claim is mid-flight (two quick clicks never pay twice); 403 not a winner; 409 not settled; 410 past the claim deadline when one is configured; 502 the send failed (try again); 503 claims not enabled on this server. |
| `POST /bonus/:d/open` | `ADVENT bonus-<d> <wallet> <nonce>` | Same as the door, for the Bonus Box: `{ ok: true, door, wallet, entered, inDrum, won, k, lamports, claimed, claimSignature, entrants }`. 409 `{ error, drawAt, entered }` before the door has opened. |
| `POST /bonus/:d/claim` | `ADVENT bonus-claim-<d> <wallet> <nonce>` | Same as the door claim, paid from the bonus wallet, memo `ADVENT bonus door=d winner=k/n hash=…`. |
| `POST /village/session` | `ADVENT village <wallet> <nonce>` | Starts or resumes a village run (below). |

Flow on the site: open → if `won`, show "Claim X SOL" → claim → show the tx. If `claimed` is already true on open,
show the tx instead of the button. Unclaimed prizes stay where they are; no deadline is set yet.

## The village (Bonus Box)

A player needs **20 coins a day: 10 hidden coins** found around the map and **10 job coins** from the day's **3 jobs**
(paying 3 + 3 + 4). Banking all 20 at the **Post Office** (the layout's `bank`) enters the wallet for that door's Bonus
Box. The keeper draws 10 winners from everyone who banked, with the door's drand round, when the door opens; they
find out by opening the box on the site and claim. One run per wallet per door; door d's village runs from door d−1
opening until door d's snapshot.

The server is the judge. It holds the day's coin positions (10 of the layout's hiding spots, chosen with a daily
secret), tells the client only the coins within 25 m of the player, checks every pickup, and judges every job from
the run's position history (every `move`, `pickup`, `bank` and `job/*` call adds the position it was sent with). All
distances are metres in the scene's own coordinates (`{x, y, z}`, y up; y is optional; job points are ground points
`{x, z}`), so Fish's layout file and the game share one frame.

Every run call takes the session `token`. Every answer (and every 4xx body that has it) carries the run's **view**:
`{ door, found, total: 10, jobCoins, jobTotal: 10, jobs, banked, nearby, closesAt, drawAt }` (`collected` is kept as an
alias of `found`), so the client can resync from any reply.

1. **Start a run.** `GET /nonce/:wallet`, sign `ADVENT village <wallet> <nonce>`, `POST /village/session`
   `{ wallet, nonce, signature }` → `{ token, spawn, bank, resumed, startedAt, …view }`. Calling again resumes it
   (`resumed: true`, same token, progress kept). 403 if the wallet isn't on the Nice List (body carries the `/eligible`
   answer and `reason`); 503 if the day's village hasn't opened yet (`opensAt`); 410 after the season.
2. **Walk.** `POST /village/move` `{ token, pos }` every second or so (and after any big move) → the view. Render
   `nearby: [{ id, x, y, z }]`; coins that drop out were taken or are out of range. 422 `too fast` when the move
   since the last call is over **22 m/s** (sleds do 16, Santa's sleigh 18, on foot 7.4; no boosts); the player stays where
   the last good move left them. **Exception:** a jump that lands within 8 m of one of the layout's `respawns` (busted,
   KO'd) is accepted at any speed and without a strike; it is marked in the position history, so a brawl in progress
   fails with `left-area` and a taxi/delivery keeps its timers running.
3. **Pick up.** `POST /village/pickup` `{ token, coin, pos }` → `{ picked, …view }`. 422 when more than 3 m from the
   coin or on a teleport, 429 when two pickups are under 0.7 s apart, 404 for an id that isn't today's, 409 if taken.
4. **Jobs.** The day's three are in `jobs` on every view:
   `{ id: "<d>-<type>", type, name, reward, giver: {x, z}, timerSeconds, targets: [...], done, started }`.
   They are picked from the **door number alone** (no secret: everyone gets the same three, and the client may show
   them in advance), rewards 3, 3, 4 in list order. Each counts once a day; job coins cap at 10.
   - `POST /village/job/start` `{ token, job, pos }` within 6 m of `giver` → `{ ok: true, job, startedAt, timerSeconds, …view }`.
     422 `{ ok: false, reason: "not-at-giver" | "too-fast" }`, 404 `no-such-job`, 409 `already-done`.
   - `POST /village/job/finish` `{ token, job, pos }` → `{ ok: true, job, reward, jobCoins, jobsDone: [ids], …view }`,
     or **422 `{ ok: false, reason, job, jobCoins, jobsDone }`**. A failed job is cleared: start it again from the giver
     and retry. `pos` is the player's final position and is checked like a move.

   | type | name | the server checks, from the positions since `start` | `reason` on failure |
   |---|---|---|---|
   | `taxi` | Sleigh Ride | a position within 6 m of `targets[0]` (A), then one within 6 m of `targets[1]` (B); B reached within `timerSeconds` = round(dist(A,B)/9 + 35) of the start; A→B took at least dist/22 s | `no-pickup`, `no-dropoff`, `timeout`, `too-fast` |
   | `delivery` | Special Delivery | within 6 m of the Post Office (`bank`) first, then within 6 m of each of the 3 doors in `targets`, any order, the last one within 170 s of the sack | `no-sack`, `doors-missed`, `timeout` |
   | `chase` | Runaway Reindeer | finished 20–240 s after the start, with the final position on the ring road (`targets[0]` = `ringRoad`: `{ r, width, x, z }`, within width/2 + 6 m of radius r) | `too-quick`, `timeout`, `not-on-ring` |
   | `brawl` | Elf Trouble (`timerSeconds: null`) | finished 25 s or more after the start, every position since within 40 m of the giver | `too-quick`, `left-area` |

   The chase's reindeer isn't simulated server-side (the loose check above, as agreed); the brawl's combat is
   client-side. Both are worth 3 or 4 coins and the player still needs the 10 hidden ones.
5. **Bank.** `POST /village/bank` `{ token, pos }` within 6 m of `bank` with `found` = 10 **and** `jobCoins` = 10 →
   `{ entered: true, entrants, …view }`. Otherwise **409 `{ reason: "not-enough", found, jobCoins, … }`**; 422
   `not at the Post Office`; 422 `{ reason: "too-quick" }` if the whole run took under 300 s. Banking enters the wallet:
   no race, no "10/10 claimed".
6. **Open the box, then claim.** After the door: `POST /bonus/:d/open`, and if `won`, `POST /bonus/:d/claim`
   (table above).
7. **Any token** gets 401 `no such session`; 409 `entries for door d closed` once the snapshot has passed (body
   has `next`, the door whose run is open now). Position history lives in memory: after a server restart a job in
   progress has to be started again (the hidden coins and finished jobs are kept).

**The layout file** (`VILLAGE_LAYOUT_FILE`), exported from the game:
```
{ "spawn": {x,y,z}, "bank": {x,y,z},
  "spots": [{ "id", x, y, z }, …],                     ~140 hiding spots (10 are drawn a day; the more, the less yesterday's map helps)
  "givers": { "taxi": {x,z}, "delivery": {x,z}, "chase": {x,z}, "brawl": {x,z} },
  "taxiPoints": [{ "name", x, z }, …],                 2 or more; A and B are picked from these per day
  "deliveryDoors": [{ x, z }, …],                      3 or more; 3 are picked per day
  "ringRoad": { "r", "width", "x"?, "z"? },           centre defaults to 0,0
  "respawns": { "busted": {x,z}, "knockedOut": {x,z} } }   where a busted/KO'd player reappears (a list works too); defaults to [spawn]
```
A, B and the 3 doors are picked by the same ranking trick as the coins, seeded with the door number. Without a file
the server uses a 200 m development square (64 spots, six taxi points, twelve doors, ring r = 80); missing job
fields in a file get those defaults with a warning in the log.

Thresholds (env): `VILLAGE_REVEAL_RADIUS` 25, `VILLAGE_PICKUP_RADIUS` 3, `VILLAGE_BANK_RADIUS` 6, `VILLAGE_JOB_RADIUS` 6,
`VILLAGE_MAX_SPEED` 22, `VILLAGE_RESPAWN_RADIUS` 8, `VILLAGE_PICKUP_GAP_MS` 700, `VILLAGE_MIN_RUN_SECONDS` 300, `VILLAGE_COINS` 10, `VILLAGE_FIRST_DOOR`.

## Published files (same data, no API)

- `snapshot.json`: pots, next door, exclusion list, every door's summary (committed/settled, prize counts and totals,
  claimed counts; `doors[d].door` and `doors[d].bonus` have the same shape as `GET /winners/:d` minus the list).
- `door-<d>.json`: the full snapshot list (every eligible wallet with balance, hold start, weight, cumulative), the
  commit memo tx, and after settlement the drand signature, seed and every prize as `{ k, lamports }`, with `account`,
  `claimed` and `claimSignature` added only once that winner has opened. This is what Verify uses; it recomputes the
  names itself.
- `deltas.json`: the coin's balance history the keeper replays (for the browser-side eligibility checker).

## Door timing the site should mirror

- Door `d` opens at `doorTime(d)` = 18:00 UTC on `d` December (configurable); the snapshot is 10 minutes before.
- From the snapshot until the door: show "Door d locked in — opening in mm:ss" with the pot frozen.
- At the door: the keeper settles within ~15 s of the drand round; poll `GET /door/:d` every 5 s until `open`,
  then let the holder open theirs.
- Past doors on the calendar: `GET /winners/:d` for counts and totals; the names only once the viewer has opened.
