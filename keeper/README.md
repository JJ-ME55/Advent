# keeper

The ADVENT backend: one Node process per job, all reading and writing the same `draws/` folder.

| Process | What | Run |
|---|---|---|
| `src/keeper.mjs` | claims pump.fun creator fees, splits them, snapshots and commits each door, settles it, publishes `draws/snapshot.json` and `draws/door-<d>.json` | `node src/keeper.mjs` (`ONCE=1` for a single tick) |
| `src/api.mjs` | the site's HTTP API over the published files; wallet-signed door opening; the village game (sessions, pickups, banking → `state/bonus-entrants.json` for the keeper) | `PORT=8787 node src/api.mjs` |
| `src/poster.mjs` | X posts with cards: door opened, countdown, jackpot; `DRY_RUN=1` writes to `posts/` | `node src/poster.mjs` |
| `src/verify-door.mjs <d>` | recomputes a door from the chain and drand and checks the payouts | `MINT=… TREASURY=… DOOR_WALLET=… node src/verify-door.mjs 3` |

Settings come from the environment (`../.env.example`); keys from `keys/*.json` (Solana JSON keypairs).

## Modules
- `drum.mjs` — eligibility and the draw maths (Tombola's rules): replay, list, hash, weighted picks, winner count, prizes.
- `drand.mjs` — drand evmnet rounds by time; relay fetch; seed.
- `doors.mjs` — the calendar (door time, snapshot time, round); `DOOR_TIMES` overrides for rehearsals.
- `solana.mjs` — fallback-RPC connection, memo and payout transactions, memo lookup, balance history (Helius, or
  plain RPC one transaction at a time).
- `draw.mjs` — snapshot → commit → settle against an abstract chain (tests use a fake).
- `claim.mjs` — pump.fun sweep + collect of creator fees.
- `village.mjs` — the Bonus Box game's judge: daily coin map from a secret and the layout's hiding spots, one run per
  wallet per door, reveal-by-proximity, distance/speed/pace checks, banking writes the entrants file. `docs/API.md`.
- `cards/` — SVG card templates and the resvg renderer; `x.mjs` — X API v2 with OAuth 1.0a.

## Tests
`node --test test/*.test.mjs` (23, no network). `test/smoke-village.mjs` plays a whole run against the API on localhost.
`test/smoke-local.mjs` and `test/rehearse-devnet.mjs` hit devnet with the funded treasury (`faucet.solana.com`):
the rehearsal creates a throwaway mint, fakes buyers, runs a real door ~5 minutes out and verifies it.
`test/render-cards.mjs` writes the three cards to `scratch/cards/`.
