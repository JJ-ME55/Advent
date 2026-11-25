# ADVENT API (for the site)

Base URL: the keeper box, e.g. `https://api.advent.lol` (CORS open to the site origin). JSON everywhere; lamports
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
| `GET /village/layout` | `{ spawn, bank, coins, firstDoor }` — where the player starts and where to bank (from the layout file Fish exports). |
| `GET /village/map/:d` | the day's 20 coin positions, **403 until that door's entries close** (then anyone can see where they were). |

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

The server is the judge: it holds the day's 20 coin positions (chosen from the village's hiding spots with a daily
secret), tells the client only the coins within 25 m of the player, and checks every pickup. The client never needs
to know where coins are; it walks, asks, and is told. All distances are metres in the scene's own coordinates
(`{x, y, z}`, y up; y is optional), so Fish's layout file and the game share one frame.

1. **Start a run.** `GET /nonce/:wallet`, sign `ADVENT village <wallet> <nonce>`, `POST /village/session`
   `{ wallet, nonce, signature }` → `{ token, door, spawn, bank, collected, total, nearby, closesAt, drawAt, resumed }`.
   One run per wallet per door; calling again resumes it (`resumed: true`, same token, progress kept). 403 if the
   wallet isn't on the Nice List (body carries the `/eligible` answer and `reason`); 503 if the day's village hasn't
   opened yet (`opensAt`): door d's village runs from door d−1 opening until door d's snapshot. Between a door's
   snapshot and its opening (10 min) nobody plays.
2. **Walk.** `POST /village/move` `{ token, pos }` every second or so (and after any big move) →
   `{ collected, total, banked, nearby: [{ id, x, y, z }], closesAt, drawAt }`. Render `nearby`; coins that drop
   out of the list were taken or are out of range.
3. **Pick up.** `POST /village/pickup` `{ token, coin, pos }` → `{ picked, collected, total, nearby, … }`.
   422 when more than 3 m from the coin or when the move since the last call is faster than 12 m/s (a teleport),
   429 when two pickups are under 0.7 s apart, 404 for an id that isn't today's, 409 if already taken.
   Every error body carries the current view so the client can resync.
4. **Bank.** `POST /village/bank` `{ token, pos }` within 6 m of `bank` with all 20 →
   `{ entered: true, entrants, … }`. 409 while coins are missing, 422 if the whole run took under 90 s.
   Banking enters the wallet for that door's Bonus Box: no race, no "10/10 claimed". The keeper draws 10 winners
   from all entrants with the door's drand round when the door opens; they find out by opening the box and claim.
5. **Open the box, then claim.** After the door: `POST /bonus/:d/open`, and if `won`, `POST /bonus/:d/claim`
   (table above).
6. **Any token** gets 401 `no such session`; 409 `entries for door d closed` once the snapshot has passed (body
   has `next`, the door whose run is open now).

**The layout file** (`VILLAGE_LAYOUT_FILE`): `{ "spawn": {x,y,z}, "bank": {x,y,z}, "spots": [{ "id", x, y, z }, …] }`
with at least 20 spots, ideally 60–100, exported from the scene (behind houses, in stalls, up the hill). The daily
20 are drawn from these, so the more spots, the less yesterday's map helps. Without a file the server uses a 200 m
square with 64 spots for development.

Thresholds (env): `VILLAGE_REVEAL_RADIUS` 25, `VILLAGE_PICKUP_RADIUS` 3, `VILLAGE_BANK_RADIUS` 6, `VILLAGE_MAX_SPEED` 12,
`VILLAGE_PICKUP_GAP_MS` 700, `VILLAGE_MIN_RUN_SECONDS` 90, `VILLAGE_COINS` 20, `VILLAGE_FIRST_DOOR`. Tune them to the
character's real speed before launch (a sprint of 8 m/s leaves headroom for lag).

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
