# Launch day (JJ)

Everything here is run by JJ; the keeper never creates the coin or moves money on its own except claims, splits and
payouts from the hot wallets.

## Before
1. **Wallets.** `keys/treasury.json` is the coin's creator and the pump.fun creator-fee wallet: the coin MUST be
   created from this wallet (import the keypair into Phantom, or create through pump's API with it), or the fees go
   elsewhere. Fund it with ~0.1 SOL. `door.json` and `bonus.json` pay the claims (from the API process, which needs
   both keys) and need ~0.05 SOL each for gas; the keeper's `RESERVE_SOL` keeps that back. `XMAS_WALLET` and
   `TEAM_WALLET` are cold addresses of your choice.
2. **Hetzner.** `deploy/README.md`. Keys copied by hand, `.env` filled, services enabled but the keeper waits: it
   refuses to start without `MINT`.
3. **Fish.** Site pointed at the API; the exclusion list agreed (team wallets).

## Launch
1. Create the coin on pump.fun **from the treasury wallet**: name, ticker, image, SOL pair, no opening buy (or a
   small one from a *different* wallet so the creator wallet never holds the coin). Copy the mint address.
2. Fill `.env`: `MINT`, `EXCLUDE` = the bonding curve PDA and the PumpSwap pool for the mint (`node -e` with
   `bondingCurvePda` / `canonicalPumpPoolPda` from `@pump-fun/pump-sdk`), plus the team wallets. The keeper adds its
   own five wallets automatically.
3. `systemctl restart advent-keeper advent-api advent-poster`. Watch `journalctl -u advent-keeper -f` for the first
   `claim(` and `split(` lines (needs > CLAIM_MIN_SOL of fees first).
4. Post the CA from the X account; the poster's countdown posts start on the next tick (dry-run until the X keys
   are in `.env` and `DRY_RUN=0`).

## Door 1 (1 Dec, 17:50 snapshot, 18:00 open)
- 17:50: `commit(door 1, …)` in the log; `draws/door-1.json` published; the site shows "locked in".
- 18:00:05: `settle(door 1) -> winner k: … awaiting claim` lines, one per winner; nothing is sent. The poster posts
  "Door 1 is open: X SOL waiting for N winners" within a minute.
- Holders open their doors on the site; winners press Claim: `claim(door 1, 7xKq…3fP, 1234 lamports) -> <sig>` in
  the API's log (`journalctl -u advent-api -f`), and a claim card from the poster.
- `node keeper/src/verify-door.mjs 1` from anywhere with the env set: must end "Verified".

## If
- **drand late / RPC down:** the keeper retries every tick; an alert fires after `LATE_AFTER_SECONDS`. Nothing is
  lost: the round is fixed, the payout just lands late.
- **Keeper down across a door:** on restart it commits the missed door immediately to a round 11 minutes out and
  settles it; the site's countdown shows the new time.
- **A wrong list:** the window between commit and round is the time to stop a door. There is no on-chain cancel;
  the keeper simply doesn't settle and the pot stays in the door wallet for the next door. Say so publicly.
- **Unclaimed prizes** sit in the door/bonus wallets indefinitely (`unclaimedLamports` in `GET /winners/:d`). No
  rule yet; `CLAIM_DEADLINE_SECONDS` in `.env` when there is one.
