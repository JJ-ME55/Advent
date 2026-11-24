# ADVENT — working notes for Claude

A Christmas prize-calendar memecoin on Solana. Fees from the coin fill a door every day from 1 to 24 (25) December;
each door pays several holders picked by drand. Read `docs/SPEC.md` first; `docs/CONCEPT-fish.md` is Fish's brief
and `docs/SPEC-draft1.md` the first technical draft it was merged with.

## People and ownership
- **JJ** (this user; git name JJ): token, launch, fee wallets, draws, payouts, backend, keeper. Runs every
  transaction and payment himself: never print private keys, never send money; write scripts he runs.
- **Fish**: website UI, calendar, branding, marketing, videos. Pushes to the site; don't fight his design.
- **Claude**: everything in `keeper/`, the API, the verifier, the card renderer; the village game with Fish.
- Legal is sorted; don't raise it.

## What this is built from (ref/, read-only copies from the Tombola repo, C:\Users\johnk\PowerSwarmBall)
- `ref/tombola-bot/snapshot.mjs`: the eligibility replay (balance, holdStart, weightFor, canonical list,
  Merkle, weighted pick). Port it, don't rewrite the rules.
- `ref/tombola-bot/keeper.mjs`: the keeper shape (harvest → commit → settle, state file, alerts, ONCE mode).
- `ref/tombola-bot/lib.mjs`: drand relays (`drandRound`, `drandSignature`), chunked log scans, key loading.
- `ref/tombola-site/`: Fish's site; `src/draw.js` is the browser-side verifier, `scripts/build.mjs` the build
  with CSP from config, `scripts/verify-test.mjs` the mock-chain test harness.
- `ref/tombola-xbot/`: the X bot's card renderer (`templates.js`), lines and posts.

## Lessons from Tombola that apply here
- Commit before reveal: the list (hash) and the drand round go on chain before the round exists, at least 10 min
  ahead; settle the moment the round is out. People hate a second countdown: snapshot 10 min BEFORE the door time
  so the payout lands when the clock hits zero.
- No pot → no draw: a slot with nothing in it waits; never pay from anything but fees.
- Exclusions (curve/pool, treasury, team, burn, zero) must be one list shared by keeper, site and bot, published
  with every snapshot, fixed before the first draw and never changed after.
- Public RPCs blip: every client gets a fallback endpoint and a 15 s tick.
- A hot keeper key on the server, a cold guardian/treasury with the user; gas is cheap, keep 0.05 SOL spare.
- The site is the proof: a Verify that recomputes the draw from the chain and drand, with neutral "couldn't check"
  states, never a false FAIL.
- Everyone splits wallets; weight is linear in balance and any send resets the hold clock, so splitting gains nothing.
- Prizes track volume; marketing is the product. Winner cards on X within a minute of each payout.
- git: commit with `git -C <repo>` from scripts (plain `cd &&` chains have landed commits in the wrong repo).
  Heredocs with backticks break the shell tool: write files with the Write tool.

## Chain facts
- Solana mainnet. Pump.fun creator fee: 0.30% on the curve, 0.95% on PumpSwap at low cap sliding down
  (docs: pump.fun/docs/fees); claimed with `collect_creator_fee` / `collect_coin_creator_fee`. Program
  `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`.
- drand evmnet: genesis 1727521075, period 3 s, relays api.drand.sh / api2 / api3 / drand.cloudflare.com.
- Memo program `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`.

## Conventions
- Node 22+, ESM `.mjs`, viem-style bigint everywhere; tests with `node --test`.
- Keys from `KEYPAIR_FILE` env (a Solana JSON keypair) never from source. `.env` is git-ignored.
- Keep the keeper's log lines greppable: `commit(door 3, ...)`, `settle(door 3) -> ...`, `claim(... lamports)`.
