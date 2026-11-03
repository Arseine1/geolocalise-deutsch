#!/usr/bin/env bash
# Startet Geofencing LoRaWAN (Webserver + SMS-Alarme + Browser).  Aufruf: ./starten.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js ist nicht installiert. Installieren Sie die LTS-Version von https://nodejs.org und starten Sie dann erneut." >&2
  exit 1
fi
exec node start.js
