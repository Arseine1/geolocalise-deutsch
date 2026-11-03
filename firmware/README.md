# Firmware: GPS-Gerät Heltec WiFi LoRa 32 V3

Sketch: [heltec_gps_geofence/heltec_gps_geofence.ino](heltec_gps_geofence/heltec_gps_geofence.ino)

> **Auf Hardware nicht getestet.** Geschrieben für den Tag, an dem Sie die Platine, das GPS und ein Gateway haben. Auf einer Platine wurde nichts kompiliert oder ausgeführt. Geprüft wurde nur: (1) der Sketch übersetzt mit g++ (`-fsyntax-only -Wall`) gegen selbst geschriebene Attrappen der Bibliotheken ohne Fehler, in allen Varianten (mit und ohne `TEST_OHNE_GPS`, mit und ohne `SPRACHNACHRICHTEN`); das belegt nur, dass die umbenannten Bezeichner untereinander stimmig sind; (2) die Aufrufe `SX1262.begin(...)`, `beginOTAA`, `activateOTAA`, `sendReceive` (beide Formen) und `timeUntilUplink` stimmen mit den echten Headern von RadioLib 7.8.1 überein. Die Bibliotheken TinyGPSPlus, WiFi, HTTPClient und ESP_I2S sowie die Hardware sind weiterhin ungeprüft. Nur die Signaturen von RadioLib wurden in dessen Quellcode (Tag 7.8.1) geprüft, und die Pins in der Variante `heltec_wifi_lora_32_V3` von arduino-esp32. Beim Übersetzen in die deutsche Fassung wurden zudem die französischen Bezeichner des Sketches umbenannt (z. B. `TEST_SANS_GPS` heißt jetzt `TEST_OHNE_GPS`, `MESSAGES_VOCAUX` heißt `SPRACHNACHRICHTEN`); auch das ist nie kompiliert worden.

## Bibliotheken und Versionen

| Element | Angestrebte Version | Quelle / Bemerkung |
|---|---|---|
| RadioLib | **7.8.1** | Letzte am 28.09.2026 veröffentlichte Version (GitHub-API). Der Sketch nutzt `LoRaWANNode(&radio, &Region, 0)`, `beginOTAA(joinEUI, devEUI, nwkKey, appKey)`, `activateOTAA()` und `sendReceive(dataUp, len, fPort, dataDown, &len, confirmed, &evUp, &evDown)`. Diese Aufrufe gibt es in 7.8.1; sie könnten sich in einer späteren Hauptversion ändern, daher **die Version 7.8.1 im Bibliotheksverwalter festlegen**. |
| TinyGPSPlus | **1.0.3** | Mikal Hart. Letzte auf GitHub gefundene Version: v1.0.3a (09/2022). Im Arduino-Verwalter kann es eine neuere geben; nicht geprüft. |
| Board-Unterstützung ESP32 (arduino-esp32) | **3.3.12** | Letzte gefundene Version (18.09.2026). Zu wählendes Board: *Heltec WiFi LoRa 32(V3)*. Die Kompatibilität von RadioLib 7.8.1 mit diesem Kern ist nicht getestet. Das Paket „Heltec ESP32 Series Dev-boards“ von Heltec ist eine Alternative, die ich nicht geprüft habe. |

Installation: Arduino IDE > Werkzeuge > Bibliotheken verwalten > nach *RadioLib* und *TinyGPSPlus* suchen und die obigen Versionen wählen.

## Verdrahtung

| GPS NEO-6M | Heltec-V3-Platine |
|---|---|
| VCC | 3V3 (der NEO-6M akzeptiert je nach Modul 3,3 V oder 5 V: Prüfen Sie Ihres) |
| GND | GND |
| TX | GPIO 5 (Empfang der Platine, `GPS_RX_PIN`) |
| RX | GPIO 4 (Senden der Platine, `GPS_TX_PIN`) |

**Zu prüfen**: Diese beiden Pins sind meine Wahl (freie GPIOs der Variante), keine Vorgabe. Prüfen Sie sie am Pinout Ihrer Platine und ändern Sie bei Bedarf `GPS_RX_PIN` / `GPS_TX_PIN`. Die Pins des SX1262 (NSS 8, DIO1 14, RST 12, BUSY 13, SPI 9/10/11) und der LED (35) stammen aus der Variantendatei von arduino-esp32.

## Konfiguration vor dem Hochladen
1. Öffnen Sie in der Konsole das Gerät `heltec-gps-01`: Kopieren Sie **DevEUI** und **AppKey** (MSB-Format) nach `DEV_EUI` und `APP_KEY` im Sketch. Veröffentlichen Sie diese Werte nie (die Nullen in der Datei sind Platzhalter).
2. Das Gerät muss auf **LoRaWAN 1.0.x**, OTAA, EU868 stehen, wie in [docs/CONFIG_TTI.md](../docs/CONFIG_TTI.md). Derselbe Schlüssel wird als AppKey und NwkKey übergeben, was für 1.0.x passt; diesen Punkt habe ich in der RadioLib-Dokumentation nicht geprüft.
3. Serieller Monitor auf **115200**.

## Verhalten
- **Uplink**: FPort 1, 8 Byte (lat × 10⁷, dann lng × 10⁷, vorzeichenbehaftete Big-Endian-int32), alle 30 s, **nur wenn der GPS-Fix gültig ist** (gültige Position, jünger als 5 s). Ohne Fix wird nichts gesendet.
- **Downlink**: FPort 2, `0x01` = LED blinkt, `0x00` = LED aus. In Klasse A empfängt die Platine nur nach einem Uplink: höchstens 30 s Verzögerung zwischen Alarm und LED.
- **Modus `TEST_OHNE_GPS`**: Entfernen Sie den Kommentar bei der Zeile `// #define TEST_OHNE_GPS` am Anfang des Sketches. Es wird kein GPS gelesen; die Platine sendet eine simulierte Strecke nach Osten (bis zum 2,5-Fachen des Radius und zurück), mit Mitte und Radius aus `web/config.js` (48.8566, 2.3522, 500 m). Ein LoRaWAN-Gateway in Reichweite ist trotzdem nötig.
- Schlägt der Beitritt fehl (kein Gateway), versucht die Platine es alle 30 s erneut.

## Sprachnachrichten (Ergänzung)

> **Dieser Teil ist noch weniger geprüft als der Rest: Er wurde nie kompiliert oder ausprobiert.** Er setzt Hardware voraus, die ich nicht habe. Die Namen der `ESP_I2S`-API (arduino-esp32 3.x) sind aus dem Gedächtnis geschrieben und können beim Kompilieren Korrekturen erfordern. Behandeln Sie ihn als Ausgangspunkt. Wird `// #define SPRACHNACHRICHTEN` im Sketch auskommentiert, erhält man das ursprüngliche Verhalten (ohne WLAN, Audio oder `secrets.h`).

Vollständige Funktionsweise: [docs/SPRACHNACHRICHTEN.md](../docs/SPRACHNACHRICHTEN.md).

### Zusätzliche Hardware
- I2S-Mikrofon **INMP441**; I2S-Verstärker **MAX98357A** mit einem kleinen Lautsprecher (4 bis 8 Ω); ein **Taster**.

### Vorgeschlagene Verdrahtung
**Die Pins sind meine Wahl, keine Vorgabe.** Ich halte sie auf dem Heltec V3 für frei, ohne es am Pinout Ihrer Platine geprüft zu haben: Prüfen Sie sie und ändern Sie bei Bedarf die Konstanten am Anfang des Sketches. Vermeiden Sie bereits belegte GPIOs (LoRa 8 bis 14, LED 35, GPS 4 und 5, OLED-Display, PRG-Taste 0).

| Bauteil | Pin des Bauteils | Heltec-V3-Platine |
|---|---|---|
| Mikrofon INMP441 | VDD / GND | 3V3 / GND |
| | SCK | GPIO 6 (`MIC_BCLK_PIN`) |
| | WS | GPIO 7 (`MIC_WS_PIN`) |
| | SD | GPIO 2 (`MIC_DIN_PIN`) |
| | L/R | GND (linker Kanal) |
| Verstärker MAX98357A | VIN / GND | 5V oder 3V3 / GND |
| | BCLK | GPIO 38 (`SPK_BCLK_PIN`) |
| | LRC | GPIO 39 (`SPK_LRC_PIN`) |
| | DIN | GPIO 40 (`SPK_DIN_PIN`) |
| | SD, GAIN | frei gelassen (Standardeinstellung) |
| Taster | ein Anschluss | GPIO 41 (`TASTE_PIN`), der andere an GND |

### Konfiguration
1. Kopieren Sie `heltec_gps_geofence/secrets.example.h` nach **`secrets.h`** (gleicher Ordner, von git ausgeschlossen): WLAN 2,4 GHz, IP-Adresse des PCs, Port des Relays, **Token** (Wert von `VOICE_DEVICE_TOKEN` in `tools/voice.env`).
2. Setzen Sie auf dem PC `VOICE_LAN=1` in `tools/voice.env` (oder starten Sie `node setup.js --force` erneut) und dann `node start.js`: Das Terminal zeigt die Adresse und den Port an, die in `secrets.h` gehören. Erlauben Sie den Port bei Bedarf in der Windows-Firewall.

### Verhalten
- **Taste gehalten**: Aufnahme von höchstens 10 s, WAV 8 kHz 16 Bit mono (das Mikrofon tastet mit 16 kHz ab, paarweise gemittelt), **im Strom** gesendet (HTTP chunked): einige hundert Byte gleichzeitig im Speicher, da der Heltec V3 kein PSRAM hat. Drücken unter 0,5 s: ignoriert.
- **Downlink Port 4 = Text**: `[Nummer (1 Byte)] + UTF-8-Text` (höchstens 49 Byte). Das Gerät **spricht ihn laut aus**: Es lädt die Sprachsynthese vom Relay herunter (`GET /api/voice/tts`, WAV 8 kHz, WLAN), spielt sie ab und bestätigt das Vorlesen mit einem **Uplink von 1 Byte (der Nummer) auf Port 3**. Ein ESP32-S3 ohne PSRAM kann die Synthese nicht selbst erzeugen; das Relay macht das mit der Stimme des PCs. Die Stimme läuft nie über LoRaWAN.
- **Downlink Port 5 = Sprachnachricht der Seite**: 1 Byte (0x01), das das Gerät benachrichtigt. Es fragt dann beim Relay die nächste ungehörte Sprachnachricht ab (`GET /api/voice/next`), lädt das WAV herunter (`GET /api/voice/<id>/audio?format=wav`), spielt es ab und bestätigt das Anhören (`POST /api/voice/<id>/ack`), alles per WLAN. Das Audio läuft nie über LoRaWAN.
- **Das Gerät sendet nie Text** (weder Tastatur noch Bildschirm): nur die Position, die Lesebestätigung eines Textes (Uplink Port 3) und Sprachnachrichten (WLAN).
- Aktualisieren Sie Decoder und Encoder des Geräts in der Konsole (`ttn/uplink_decoder.js` und `ttn/downlink_encoder.js`).
- Das WLAN bleibt dauerhaft verbunden (Verbrauch im Akkubetrieb beobachten); Positions-Uplinks werden während der Aufnahme und der Wiedergabe ausgesetzt.

### Unsichere Punkte (Sprache)
- `ESP_I2S`-API: Namen und Parameter von `begin`, `setPins`, `readBytes`, `write` beim Kompilieren nicht geprüft.
- Das Mikrofon INMP441 gibt 24 Bit in einem 32-Bit-Wort aus: `STIMME_MIKRO_VERSCHIEBUNG` (14) stellt den Pegel ein und ist nach Gehör anzupassen.
- Zwei gleichzeitige I2S-Peripheriegeräte auf dem ESP32-S3: vorgesehen, nicht ausprobiert.
- Gewählte Pins: siehe oben.
- Die Lesebestätigung nutzt `node.sendReceive(&ack, 1, 3)`: Diese Überladung (`const uint8_t*`, Länge, FPort) existiert laut `LoRaWAN.h` von RadioLib 7.8.1 (Zeile 725, geprüft). Ein während dieses Versands empfangener Downlink wird ignoriert.

## Unsichere Punkte
- **TCXO**: `TCXO_VOLTAGE` steht auf 1,8 V. Das ist der Wert, den ich für den des Heltec V3 halte; nicht bestätigt. Schlägt die Funk-Initialisierung fehl, versuchen Sie 1,6, dann 3,0.
- **Sendezeit**: Ein Uplink alle 30 s hält mit dieser kleinen Nachricht die gesetzliche Grenze von 1 % in EU868 ein (der Sketch wartet länger, wenn RadioLib es verlangt), aber die Nutzungsrichtlinie Ihres The-Things-Industries-Tarifs kann strenger sein. Verlängern Sie bei Bedarf `SENDEINTERVALL_MS`.
- **Wiederverbindung**: Die LoRaWAN-Sitzung wird nicht gespeichert; jeder Neustart führt einen neuen Beitritt durch.
- **Verbindung zur Webseite**: Der von der Webseite gesendete Downlink (`f_port` 2, `AQ==` / `AA==`) entspricht den von diesem Sketch gelesenen Bytes 0x01 / 0x00.
