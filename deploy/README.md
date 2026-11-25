# Deploying on the Hetzner box (next to Tombola's keeper)

```
/opt/advent/            git checkout of this repo (user: advent)
/opt/advent/keys/       treasury.json door.json bonus.json  (0600, owner advent) — xmas and team are cold, pubkeys only.
                        The API needs door.json and bonus.json too: it pays the claims.
/opt/advent/.env        from .env.example
/opt/advent/draws/      published files; served read-only by the API and synced to the site's CDN
/opt/advent/state/      keeper, poster, village and bonus-entrant state; results/ (settled doors in full) and
                        claims.json, shared between the keeper (writes results, reads claims) and the API (the reverse)
```

```sh
useradd -r -m -d /opt/advent advent
git clone https://github.com/JJ-ME55/Advent /opt/advent && cd /opt/advent/keeper && npm ci --omit=dev
cp /opt/advent/deploy/*.service /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now advent-keeper advent-api advent-poster
journalctl -u advent-keeper -f
```

Each unit runs `node src/<job>.mjs` as `advent` with `EnvironmentFile=/opt/advent/.env`, restarts on failure, and
can only write under `/opt/advent/draws` and `/opt/advent/state`. The API listens on 8787 behind Caddy/nginx with
TLS at `api.advent.lol`.
