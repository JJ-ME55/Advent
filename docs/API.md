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
| `GET /bonus/:d` | `{ door, entrants, winners }` |

## Wallet-signed writes

1. `GET /nonce/:wallet` → `{ nonce, message }`. The message to sign is `ADVENT <action> <wallet> <nonce>`;
   nonces last 5 minutes and are single-use.
2. Sign it with the wallet (`signMessage` in wallet adapters; ed25519 over the UTF-8 bytes), base58-encode the signature.
3. `POST /door/:d/open` with `{ wallet, nonce, signature }` where the action is `open-<d>` →
   `{ door, wallet, inDrum, won, lamports, signature }`. 409 before the door has settled (`opensAt` tells when);
   401 on a bad or reused nonce/signature.

The village endpoints (`POST /village/session`, `/pickup`, `/bank`, `POST /bonus/:d/open`) answer 501 until the
game ships; shapes as in `docs/SPEC.md` §8.

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
