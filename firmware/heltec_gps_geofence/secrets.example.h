/**
 * Vorlage für secrets.h: Kopieren Sie diese Datei nach „secrets.h“ (gleicher Ordner) und füllen Sie sie aus.
 * secrets.h ist von git ausgeschlossen (.gitignore): Veröffentlichen Sie sie nie.
 * Diese Werte dienen nur den Sprachnachrichten (WLAN + Sprach-Relay des PCs).
 */
#pragma once

// WLAN des Ortes, an dem sich das Gerät befindet (2,4 GHz: Der ESP32-S3 unterstützt kein 5 GHz)
#define WIFI_SSID      "NAME-DES-WLAN"
#define WIFI_PASSWORD  "PASSWORT-DES-WLAN"

// Sprach-Relay: IP-Adresse des PCs, auf dem „node start.js“ in diesem Netz läuft, und Port des Relays für das lokale Netz.
// VOICE_LAN=1 in tools/voice.env ist erforderlich; der beim Start angezeigte Port ist VOICE_LAN_PORT (standardmäßig 8081).
#define RELAY_HOST     "192.168.1.50"
#define RELAY_PORT     8081

// Token des Geräts: Übernehmen Sie den Wert von VOICE_DEVICE_TOKEN aus tools/voice.env
#define VOICE_TOKEN    "HIER-DAS-TOKEN-EINFUEGEN"

// An das Relay gesendete Kennung (Header X-Device-Id)
#define VOICE_DEVICE_ID "heltec-gps-01"
