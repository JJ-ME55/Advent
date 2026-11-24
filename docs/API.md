# ADVENT API (for the site)

Base URL: the keeper box, e.g. `https://api.advent.lol` (CORS open to the site origin). JSON everywhere; lamports
are decimal strings; times are unix seconds. Everything the API serves is also published as files the keeper
writes (`snapshot.json`, `door-<d>.json`), so the site can be fully static against a CDN copy if we want.

## Reads

| Endpoint | Returns |
|---|---|
| `GET /pot` | `{ at, pots: { treasury, door, xmas, bonus }, claimed, totalPaid, nextDoor, nextDoorAt, wallets }` — `pots.door` is today's prize so far (door wallet minus gas reserve). |
| `GET /door/:d` | `{ door, status, opensAt, snapshotAt, secondsToOpen, winnerCount, eligible, pot, commit: { signature, blockTime, hash }, round }` — `status` is `locked` (future), `locked-in` (snapshot taken, commit on chain, countdown running), `due` (past time, not yet settled: drand/keeper late), `open` (paid). |
| `GET /winners/:d` | `{ door, hash, round, seed, signature, winners: [{ k, account, lamports, signature }], bonus: [...], commit }` — `winners[0]` is the grand. `signature` on each winner is the payout tx; `commit.signature` the memo tx. |
| `GET /eligible/:wallet` | `{ wallet, holder, inDrum, balance, holdStart, heldSeconds, tickets, totalTickets, odds, reason }` — odds is a fraction (0.0137 = 1.37%); `reason` says why not when `inDrum` is false. Computed live from the published balance history at "now". |
| `GET /bonus/:d` | `{ door, phase, entrants, playing, closesAt, drawAt, winners, paid }` — `phase` is `open` (runs count), `closed` (snapshot taken, drawing at `drawAt`), `drawn`. |
| `GET /village/layout` | `{ spawn, bank, coins, firstDoor }` — where the player starts and where to bank (from the layout file Fish exports). |
| `GET /village/map/:d` | the day's 20 coin positions, **403 until that door's entries close** (then anyone can see where they were). |

## Wallet-signed writes

1. `GET /nonce/:wallet` → `{ nonce, message }`. The message to sign is `ADVENT <action> <wallet> <nonce>`;
   nonces last 5 minutes and are single-use.
2. Sign it with the wallet (`signMessage` in wallet adapters; ed25519 over the UTF-8 bytes), base58-encode the signature.
3. `POST /door/:d/open` with `{ wallet, nonce, signature }` where the action is `open-<d>` →
   `{ door, wallet, inDrum, won, lamports, signature }`. 409 before the door has settled (`opensAt` tells when);
   401 on a bad or reused nonce/signature.

## The village (Bonus Box)

The server is the judge: it holds the day's 20 coin positions (chosen from the village's hiding spots with a daily
secret), tells the client only the coins within 25 m of the player, and checks every pickup. The client never needs
to know where coins are; it walks, asks, and is told. All distances are metres in the scene's own coordinates
(`{x, y, z}`, y up; y is optional), so Fish's layout file and the game share one frame.

1. **Start a run.** `GET /nonce/:wallet`, sign `ADVENT village <wallet> <nonce>`, `POST /village/session`
   `{ wallet, nonce, signature }` → `{ token, door, spawn, bank, collected, total, nearby, closesAt, drawAt, resumed }`.
   One run per wallet per door; calling again resumes it (`resumed: true`, same token, progress kept). 403 if the
   wallet isn't in the drum (body carries the `/eligible` answer and `reason`); 503 if the day's village hasn't
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
   from all entrants with the door's drand round and pays them from the bonus wallet when the door opens.
5. **Open the box.** After the door: sign `ADVENT bonus-<d> <wallet> <nonce>`, `POST /bonus/:d/open` →
   `{ entered, won, lamports, signature, entrants }`; 409 (`drawAt`) before the door has settled.
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

- `snapshot.json`: pots, next door, exclusion list, every door's summary (committed/settled/winners).
- `door-<d>.json`: the full snapshot list (every eligible wallet with balance, hold start, weight, cumulative), the
  commit memo tx, and after settlement the drand signature, seed, winners and payout txs. This is what Verify uses.
- `deltas.json`: the coin's balance history the keeper replays (for the browser-side eligibility checker).

## Door timing the site should mirror

- Door `d` opens at `doorTime(d)` = 18:00 UTC on `d` December (configurable); the snapshot is 10 minutes before.
- From the snapshot until the door: show "Door d locked in — opening in mm:ss" with the pot frozen.
- At the door: the keeper settles within ~15 s of the drand round; poll `GET /door/:d` every 5 s until `open`.
- The winners' doors on the calendar: `GET /winners/:d` for every past door.
