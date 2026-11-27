# Deploying on the Hetzner box (root@5.161.226.9, next to Tombola's keeper)

```
/opt/advent/            the committed code, shipped by deploy/push.sh (user: advent)
/opt/advent/keys/       treasury.json door.json bonus.json  (0600, owner advent) — xmas and team are cold, pubkeys only.
                        The API needs door.json and bonus.json too: it pays the claims.
/opt/advent/.env        from .env.example (0600; never shipped by push.sh)
/opt/advent/draws/      published files; served by the API (api.adventcoin.lol) and copyable to the site's CDN
/opt/advent/state/      keeper, poster, village and bonus-entrant state; results/ (settled doors in full) and
                        claims.json, shared between the keeper (writes results, reads claims) and the API (the reverse)
/opt/advent/posts/      the poster's dry-run output
```

## First time (JJ, from Git Bash in this repo)

1. **DNS:** an A record `api.adventcoin.lol → 5.161.226.9` (Caddy fetches the certificate the moment it resolves).
2. **Ship the code and set the box up** (user, deps, systemd units, Caddy):
   ```
   bash deploy/push.sh
   ```
3. **Copy the three hot keys** (once; never through git):
   ```
   scp -i ~/Polybot/auth/ssh-key-2026-02-21.key keys/treasury.json keys/door.json keys/bonus.json root@5.161.226.9:/opt/advent/keys/
   ssh -i ~/Polybot/auth/ssh-key-2026-02-21.key root@5.161.226.9 "chown advent:advent /opt/advent/keys/*.json && chmod 600 /opt/advent/keys/*.json"
   ```
4. **Fill `.env` on the box:** `ssh … "nano /opt/advent/.env"`. Before launch the keeper and poster idle (no `MINT`);
   the API is already live and answers empty data, which is enough for the site to switch off demo mode.
   Fill `RPC_URL` (Helius key), `XMAS_WALLET`, `TEAM_WALLET`, `SITE_ORIGIN` (the example already lists the site and the
   village game), a long random `VILLAGE_SECRET`
   (`openssl rand -hex 32`). On launch day: `MINT`, `EXCLUDE`, then `systemctl restart advent-keeper advent-poster`.
5. **Check:** `curl https://api.adventcoin.lol/pot` and `journalctl -u advent-api -f`.

## Every later update

```
bash deploy/push.sh
```
(ships HEAD, reinstalls deps if they changed, restarts the three services; keys and .env untouched.)

Each unit runs `node keeper/src/<job>.mjs` as `advent` from `/opt/advent` with `EnvironmentFile=/opt/advent/.env`,
restarts on failure, and can only write under `draws`, `state` and `posts`. The API listens on 8787 behind Caddy
with TLS at `api.adventcoin.lol`.
