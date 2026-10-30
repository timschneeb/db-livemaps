#!/usr/bin/env bash
# Deployt die Zuglage-Karte auf den Server: rsync -> venv/Requirements ->
# systemd-Unit installieren -> Dienst neu starten -> Health-Check.
#
# Usage: ./deploy/deploy.sh [ssh-host]     # Standard: srv1.timschneeberger.me
set -euo pipefail

SERVER="${1:-srv1.timschneeberger.me}"
APP_DIR=/opt/ris-map/app
SERVICE=ris-map.service
PORT=8011

cd "$(dirname "$0")/.."

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
remote() { ssh "$SERVER" "$@"; }

say "Bereite ${SERVER}:${APP_DIR} vor"
remote "set -e
  test -d /opt/ris-map || install -d -m 755 /opt/ris-map
  install -d -m 755 '${APP_DIR}'"

if remote "ss -ltnH | grep -q ':${PORT} '" \
   && ! remote "systemctl is-active --quiet ${SERVICE}"; then
  echo "Port ${PORT} ist auf ${SERVER} bereits durch einen anderen Dienst belegt." >&2
  exit 1
fi

say "Synchronisiere Quellcode"
rsync -az --delete \
  --exclude '.git/' \
  --exclude '.venv/' \
  --exclude 'cache/' \
  --exclude 'chrome-data/' \
  --exclude 'positions.jsonl' \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'deploy/' \
  --exclude 'docs/' \
  ./ "${SERVER}:${APP_DIR}/"

say "Installiere Python-Abhaengigkeiten"
remote "set -e
  cd '${APP_DIR}'
  [ -x .venv/bin/python ] || python3 -m venv .venv
  .venv/bin/pip install -q --disable-pip-version-check -r requirements.txt"

say "Installiere ${SERVICE}"
remote "sudo install -m 644 /dev/stdin /etc/systemd/system/${SERVICE}" < deploy/ris-map.service
remote "set -e
  sudo systemctl daemon-reload
  sudo systemctl enable ${SERVICE}
  sudo systemctl restart ${SERVICE}"

say "Warte auf Health-Check (MQTT verbunden)"
for _ in $(seq 1 30); do
  if remote "curl -fsS --max-time 2 http://127.0.0.1:${PORT}/api/health 2>/dev/null | grep -q '\"connected\":true'"; then
    remote "curl -fsS http://127.0.0.1:${PORT}/api/health"
    say "Laeuft: http://${SERVER}:${PORT}"
    exit 0
  fi
  sleep 1
done

echo "Health-Check fehlgeschlagen." >&2
remote "sudo systemctl --no-pager status ${SERVICE} || true
  sudo journalctl -u ${SERVICE} -n 40 --no-pager || true"
exit 1
