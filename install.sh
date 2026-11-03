#!/usr/bin/env bash
# Installation von Geofencing LoRaWAN mit einem einzigen Befehl (macOS, Linux, Git Bash).
#
# Befehl zum Kopieren in ein Terminal:
#   curl -fsSL https://raw.githubusercontent.com/Arseine1/geolocalise-deutsch/main/install.sh | bash
#
# Lädt das Projekt von GitHub herunter (ohne git), prüft Node.js, startet den Konfigurationsassistenten und dann das Projekt.
# Aktualisierung: denselben Befehl erneut ausführen (Ihre Schlüssel und Nummern bleiben erhalten).
#
# Optionale Variablen:
#   GEO_REPO=konto/name   GEO_BRANCH=main   GEO_DIR=~/geolocalise-deutsch   GEO_SOURCE=archiv.tar.gz (oder Adresse)
#   GEO_NO_START=1 (nicht starten)   GEO_YES=1 (keine Fragen)
#   GEO_TOKEN=...  schreibgeschütztes GitHub-Token, nur nötig, wenn das Repository PRIVAT ist
set -euo pipefail

REPO="${GEO_REPO:-Arseine1/geolocalise-deutsch}"
BRANCH="${GEO_BRANCH:-main}"
DIR="${GEO_DIR:-$HOME/geolocalise-deutsch}"
SOURCE="${GEO_SOURCE:-}"

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '  \033[32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m[!]\033[0m  %s\n' "$*"; }
fail() { printf '\n  \033[31m[FEHLER]\033[0m %s\n\n' "$*" >&2; exit 1; }

# Die Fragen werden auch dann über die Tastatur gelesen, wenn das Skript per „curl | bash“ kommt
if [ -r /dev/tty ] && [ -z "${GEO_YES:-}" ]; then TTY=/dev/tty; else TTY=""; fi
ask_yes() { # $1 = Frage; Standard: ja
  [ -z "$TTY" ] && return 0
  printf '%s (J/n) ' "$1" > /dev/tty; read -r a < /dev/tty || a=""
  case "$a" in ""|[jJyY]*) return 0 ;; *) return 1 ;; esac
}

echo; cyan "=== Installation von Geofencing LoRaWAN ==="; echo

# ---------- 1. Node.js ----------
cyan "1/4  Node.js wird geprüft"
node_major() { command -v node >/dev/null 2>&1 && node --version | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  warn "Node.js 18 oder neuer ist erforderlich (es ist das einzige Programm, das installiert werden muss)."
  case "$(uname -s)" in
    Darwin) fail "Installieren Sie Node.js: „brew install node“ oder https://nodejs.org (LTS-Version) und führen Sie diesen Befehl dann erneut aus." ;;
    *)      fail "Installieren Sie Node.js (LTS-Version) von https://nodejs.org oder mit Ihrem Paketmanager und führen Sie diesen Befehl dann erneut aus." ;;
  esac
fi
green "Node.js $(node --version)"

# ---------- 2. Download ----------
cyan "2/4  Projekt wird heruntergeladen"
TMP="$(mktemp -d 2>/dev/null || mktemp -d -t geolocalise)"
trap 'rm -rf "$TMP"' EXIT
ARCHIVE="$TMP/projekt.tar.gz"
if [ -n "$SOURCE" ] && [ -f "$SOURCE" ]; then
  cp "$SOURCE" "$ARCHIVE"
else
  command -v curl >/dev/null 2>&1 || fail "curl wird benötigt, um das Projekt herunterzuladen."
  CURL_AUTH=()
  if [ -n "$SOURCE" ]; then URL="$SOURCE"
  elif [ -n "${GEO_TOKEN:-}" ]; then
    # Privates Repository: GitHub-API mit einem schreibgeschützten Token
    URL="https://api.github.com/repos/$REPO/tarball/$BRANCH"
    CURL_AUTH=(-H "Authorization: Bearer $GEO_TOKEN" -H "Accept: application/vnd.github+json")
  else URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"; fi
  echo "  $URL"
  curl -fsSL "${CURL_AUTH[@]+"${CURL_AUTH[@]}"}" "$URL" -o "$ARCHIVE" || fail "Download nicht möglich. Prüfen Sie die Internetverbindung. Ist das GitHub-Repository „$REPO“ PRIVAT, brauchen Sie ein Lese-Token (Variable GEO_TOKEN) oder müssen das Repository öffentlich machen: Ein Fehler 404 bedeutet oft „privat“."
fi

# ---------- 3. Installation (vorhandene Konfiguration bleibt erhalten) ----------
cyan "3/4  Installation in $DIR"
UPDATE=0; [ -f "$DIR/start.js" ] && UPDATE=1
[ "$UPDATE" = 1 ] && warn "Es besteht bereits eine Installation: Aktualisierung (Ihre Schlüssel und Nummern bleiben erhalten)."
mkdir -p "$DIR"
tar -xzf "$ARCHIVE" -C "$DIR" --strip-components=1 --exclude='config.js' --exclude='sms-proxy.env' --exclude='voice.env' --exclude='secrets.h' --exclude='.sms-counter.json' --exclude='sms-recipients.json' \
  || fail "Das heruntergeladene Archiv ist nicht lesbar."
[ -f "$DIR/start.js" ] || fail "Das Archiv enthält nicht das erwartete Projekt."
chmod +x "$DIR/starten.sh" 2>/dev/null || true
green "Dateien installiert."

# ---------- 4. Konfiguration und Start ----------
cyan "4/4  Konfiguration"
cd "$DIR"
if [ -n "$TTY" ]; then node setup.js < /dev/tty; else node setup.js --yes; fi
echo; green "Installation abgeschlossen in: $DIR"; echo
echo "  Zum späteren Neustart:  cd \"$DIR\" && node start.js   (oder ./starten.sh)"; echo
if [ -z "${GEO_NO_START:-}" ] && [ -n "$TTY" ]; then
  if ask_yes "Projekt jetzt starten?"; then exec node start.js; fi
fi
