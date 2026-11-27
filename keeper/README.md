# keeper

The ADVENT backend: one Node process per job, all reading and writing the same `draws/` folder.

| Process | What | Run |
|---|---|---|
| `src/keeper.mjs` | claims pump.fun creator fees, splits them, snapshots and commits each door, settles it (fixes the winners, pays nothing), publishes `draws/snapshot.json` and `draws/door-<d>.json` naming only winners who have opened | `node src/keeper.mjs` (`ONCE=1` for a single tick) |
| `src/api.mjs` | the site's HTTP API over the published files; wallet-signed door opening and prize claims (pays from the door/bonus keys, once); the village game (sessions, pickups, jobs, banking → `state/bonus-entrants.json` for the keeper) | `PORT=8787 node src/api.mjs` |
| `src/poster.mjs` | X posts with cards: door opened, countdown, jackpot; `DRY_RUN=1` writes to `posts/` | `node src/poster.mjs` |
| `src/verify-door.mjs <d>` | recomputes a door from the chain and drand and checks the payouts | `MINT=… TREASURY=… DOOR_WALLET=… node src/verify-door.mjs 3` |

Settings come from the environment (`../.env.example`); keys from `keys/*.json` (Solana JSON keypairs).

## Modules
- `drum.mjs` — eligibility and the draw maths (Tombola's rules): replay, list, hash, weighted picks, winner count, prizes.
- `drand.mjs` — drand evmnet rounds by time; relay fetch; seed.
- `doors.mjs` — the calendar (door time, snapshot time, round); `DOOR_TIMES` overrides for rehearsals.
- `solana.mjs` — fallback-RPC connection, memo and payout transactions, memo lookup, balance history (Helius, or
  plain RPC one transaction at a time).
- `draw.mjs` — snapshot → commit → settle (winners and amounts fixed, nothing sent) against an abstract chain.
- `claims.mjs` — opening and claiming: reads the keeper's private results, records opens, pays a claim once
  (race-safe), and scrubs the published winner lists so nobody is named before they open.
- `claim.mjs` — pump.fun sweep + collect of creator fees.
- `village.mjs` — the Bonus Box game's judge: 10 hidden coins a day from a secret and the layout's hiding spots, three
  daily jobs from the door number (judged from the run's position history), one run per wallet per door,
  reveal-by-proximity, distance/speed/pace checks, banking 20 at the Post Office writes the entrants file. `docs/API.md`.
- `cards/` — SVG card templates and the resvg renderer; `x.mjs` — X API v2 with OAuth 1.0a.

## Tests
`node --test test/*.test.mjs` (37, no network). `test/smoke-village.mjs` plays a whole village day (coins, jobs, bank)
against the API on localhost in about 30 s.
`test/smoke-local.mjs` and `test/rehearse-devnet.mjs` hit devnet with the funded treasury (`faucet.solana.com`):
the rehearsal creates a throwaway mint, fakes buyers, runs a real door ~5 minutes out, has every buyer open it
through the API and the winners claim, and verifies it.
`test/render-cards.mjs` writes the three cards to `scratch/cards/`.
