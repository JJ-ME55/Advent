#!/usr/bin/env bash
# Ships the committed code (git HEAD, no keys, no .env, no state) to the Hetzner box and runs the server setup.
# Run from this repo on JJ's machine in Git Bash:
#   bash deploy/push.sh
# Keys and .env are NOT shipped; see deploy/README.md for the two scp lines JJ runs once.
set -euo pipefail
HOST=${HOST:-root@5.161.226.9}
KEY=${KEY:-"$HOME/Polybot/auth/ssh-key-2026-02-21.key"}
REPO=$(cd "$(dirname "$0")/.." && pwd)
SSH="ssh -i $KEY $HOST"

echo "== shipping $(git -C "$REPO" rev-parse --short HEAD) to $HOST:/opt/advent"
$SSH "mkdir -p /opt/advent"
git -C "$REPO" archive --format=tar HEAD | $SSH "tar -x -C /opt/advent"
# Windows checkouts can ship CR LF; bash on the box can't read those, so strip them before running anything
$SSH "sed -i 's/\r\$//' /opt/advent/deploy/*.sh /opt/advent/deploy/*.service && bash /opt/advent/deploy/hetzner.sh"
