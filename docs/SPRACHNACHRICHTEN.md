# Nachrichten zwischen Seite und Gerät

Ein Chat in beide Richtungen, gedacht für ein Gerät ohne Tastatur und Bildschirm.
Das Gerät hat **weder Tastatur noch Bildschirm**: Es kann weder Text schreiben noch anzeigen. Daraus folgt:
- **Seite zum Gerät, als Text**: Der Angehörige oder die Pflegekraft schreibt (oder diktiert) eine Nachricht. Sie geht **als Text per LoRaWAN** hinaus, und das Gerät **wandelt sie in Sprache um** und spricht sie laut aus.
- **Seite zum Gerät, als Sprache**: Der Angehörige nimmt mit dem Mikrofon eine Sprachnachricht auf. Das Audio läuft über das Relay (WLAN); das Gerät wird durch ein kleines LoRaWAN-Signal benachrichtigt, lädt es herunter und spielt es ab.
- **Gerät zur Seite**: ausschließlich **Sprachnachrichten**: Der Patient drückt die Taste und spricht. Die Nachricht kommt im Chat der Seite an (per WLAN). Das Gerät sendet nie Text.

## Warum die Stimme nicht über LoRaWAN läuft

LoRaWAN transportiert einige Dutzend Byte (51 bis 222 je nach Datenrate), mit 1 % Sendezeit und sehr wenigen Downlinks. Eine Sekunde Sprache wiegt hunderte Byte, selbst stark komprimiert: unmöglich. Ein **kurzer Text** passt dagegen in einen Downlink. Daher die Architektur:

| Richtung | Was | Worüber |
|---|---|---|
| Seite → Gerät | **Text** (höchstens 49 Byte) | **LoRaWAN**, Downlink Port 4; das Gerät spricht ihn laut aus |
| Seite → Gerät | Signal „eine Sprachnachricht wartet“ (1 Byte) | **LoRaWAN**, Downlink Port 5; das Gerät lädt das Audio per WLAN herunter |
| Seite → Gerät | **Sprachnachricht** (WAV 8 kHz, höchstens 10 s) | HTTP, über das **WLAN** des Geräts, über das Sprach-Relay |
| Gerät → Seite | Bestätigung „laut gesprochen“ (1 Byte) | LoRaWAN, Uplink Port 3 |
| Gerät → Seite | **Sprachnachricht** des Patienten | HTTP, über das **WLAN** des Geräts, über das **Sprach-Relay** des PCs |
| GPS-Position, LED-Befehl | | LoRaWAN, unverändert |

```
 Seite: geschriebener oder diktierter Text ──Downlink Port 4: [Nr.] + UTF-8-Text──► The Things Stack ──LoRaWAN──► Gerät
                                                                                                         │ Sprachsynthese des Relays (WLAN)
 Seite ◄── Bestätigung (blaue Haken) ◄── Uplink Port 3: [Nr.] ◄─────────── The Things Stack ◄─────────────┘ spricht den Text laut aus

 Gerät: Taste, der Patient spricht ──WAV 8 kHz im Strom (WLAN, Token)──► Sprach-Relay (PC, data/voice/) ──► Seite (Blase + Piepton)
```

**Grenzen beim Text**: 49 Byte UTF-8 (1 Byte Nummer + 49 = 50 Byte, die in einen Downlink mit 51 Byte bei SF12 passen). **Ein Umlaut zählt 2 Byte**: „Ich hole Sie gleich ab“ passt, eine lange Nachricht nicht. Das Eingabefeld zeigt den Zähler an. **Nur ein Downlink pro Minute**: Mehrere Nachrichten reihen sich in eine Warteschlange ein (Uhr-Symbol an der Blase) und gehen nacheinander hinaus.

**Haken**: Uhr = wartet auf Versand; ✓ = per LoRaWAN gesendet; ✓✓ = vom Gerät empfangen; blaue ✓✓ = laut gesprochen (Bestätigung des Geräts); roter Punkt = Fehlschlag.

## Eine Nachricht diktieren

Klicken Sie einmal auf das Mikrofon, sprechen Sie, klicken Sie erneut, um zu beenden. Der Text erscheint im Eingabefeld: **Lesen Sie ihn noch einmal, korrigieren Sie ihn und senden Sie dann** (ein Erkennungsfehler geht nie von allein hinaus). „Abbrechen“ oder Esc bricht das Diktat ab.

> **Datenschutz: Das Diktat nutzt den Spracherkennungsdienst von Chrome, der Ihre Stimme an Google sendet.** Das ist die einzige Funktion des Projekts, die den Computer verlässt. Um zu 100 % lokal zu bleiben, schreiben Sie mit der Tastatur. Per LoRaWAN geht der Text hinaus, nicht das Audio.

## Das Sprach-Relay

In den lokalen Server integriert (`node start.js`), ohne Abhängigkeiten.

| Route | Aufgabe |
|---|---|
| `POST /api/voice` | rohes Audio des Geräts (`X-From: device`, WAV oder WebM) **oder** Text der Seite (`Content-Type: text/plain`, `X-From: page`). Antwort `{ id, at, duration }` |
| `GET /api/voice?since=<id>` | Liste (`&unheard=1`: nur die von der Gegenseite noch nicht angehörten Nachrichten) |
| `GET /api/voice/<id>/audio` | die Audiodatei einer Sprachnachricht |
| `POST /api/voice/<id>/ack` | markiert „angehört“ (die Seite tut das für das Gerät, wenn die LoRaWAN-Bestätigung eintrifft) |
| `GET /api/voice/next` | nächste ungehörte Sprachnachricht der Seite `{ id, duration }` oder 204 (für das Gerät) |
| `GET /api/voice/tts?text=...` | **lokale Sprachsynthese**: WAV 8 kHz mono, das das Gerät abspielt |
| `GET /api/voice/stream` | Server-Sent Events: `message`, `update`, `notify` |
| `POST /api/voice/notify?id=<id>` | die Seite meldet, dass sie diesen Text gerade gesendet hat (der Simulator empfängt ihn) |
| `POST /api/voice/<id>/wav` | Ablage einer WAV-Version einer Audionachricht der Seite (von der Seite nicht mehr genutzt, beibehalten) |

**Sprachsynthese** (`tools/voice-tts.js`): Sie nutzt die Sprach-Engine **des Systems**, daher verlässt nichts den PC. Windows: System.Speech (deutsche Stimme, wenn installiert, sonst die Standardstimme). macOS: `say` (Stimme Anna). Linux: `espeak-ng` oder `espeak` (muss installiert werden). Ohne Engine antwortet die Route 501. Ein ESP32-S3 ohne PSRAM kann diese Synthese nicht selbst erzeugen: Das Gerät fragt sie per WLAN beim Relay ab.

**Grenzen**: 1 MB und 30 s pro Sprachnachricht, 20 Sprachnachrichten und 200 Texte pro Stunde, Löschung nach `VOICE_RETENTION_DAYS` Tagen. Das Gerät nimmt höchstens 10 s auf.

## In der Konsole von The Things Stack zu aktualisieren

Der **Uplink-Decoder** und der **Downlink-Encoder** des Geräts haben sich geändert: Kopieren Sie [ttn/uplink_decoder.js](../ttn/uplink_decoder.js) und [ttn/downlink_encoder.js](../ttn/downlink_encoder.js) in *Payload formatters* des Geräts. Ohne den neuen Decoder würde die Bestätigung des Geräts (Uplink Port 3) abgelehnt.

## Einstellungen (`tools/voice.env`, von `node setup.js` angelegt)

| Einstellung | Standard | Aufgabe |
|---|---|---|
| `VOICE_ENABLED` | 1 | 0 schaltet die ganze Funktion ab |
| `VOICE_DEVICE_TOKEN` | erzeugt | Token, das das Gerät in `X-Voice-Token` sendet |
| `VOICE_LAN` | 0 | 1: Das Relay lauscht zusätzlich im lokalen Netz (Port `VOICE_LAN_PORT`, 8081), für ein echtes Gerät |
| `VOICE_RETENTION_DAYS` | 7 | Aufbewahrungsdauer der Nachrichten |

## Sicherheit und Datenschutz

Eine Stimme und die an eine überwachte Person gerichteten Nachrichten sind sensible personenbezogene Daten.
- Die Nachrichten bleiben **auf diesem Computer** (`data/voice/`, von git ausgeschlossen, nie als Datei ausgeliefert) und werden nach `VOICE_RETENTION_DAYS` Tagen gelöscht. Um sofort alles zu löschen: Projekt beenden und den Ordner `data/` löschen.
- Der per LoRaWAN gesendete Text läuft wie die Position über The Things Stack (Netzwerk- und Anwendungsserver). Die Nachrichten dürfen daher keine sensiblen Angaben enthalten.
- Die Sprachsynthese ist lokal. Nur das **Diktat** (Chrome) sendet die Stimme an Google.
- Seite und Simulator werden nur von `localhost` akzeptiert (Prüfung von Adresse und Ursprung). Das Gerät muss das Token vorlegen, das in konstanter Zeit verglichen und nie in Protokolle geschrieben wird.
- Standardmäßig lauscht das Relay **nur lokal**. Mit `VOICE_LAN=1` öffnet sich ein zweiter Port im lokalen Netz (Token erforderlich, nie die Seite oder die Geheimnisse): Der Verkehr ist **unverschlüsseltes HTTP**, nur für ein vertrauenswürdiges Netz geeignet.
- Informieren Sie die überwachte Person (oder ihre Vertretung), dass der Austausch aufgezeichnet und aufbewahrt wird.

## Mit echten TTN-Uplinks testen (ohne Hardware)

1. Kopieren Sie [ttn/uplink_decoder.js](../ttn/uplink_decoder.js) in *Payload formatters > Uplink* des Geräts (Save).
2. Öffnen Sie die Seite `http://localhost:8080/web/` mit **abgewähltem Demo-Modus** (der Demo-Modus trennt das Zuhören bei TTN). Das Protokoll zeigt „Ereignisstrom geöffnet“.
3. TTN-Konsole > Gerät > *Messaging* > *Simulate uplink*:
   - **FPort 3**, Payload `06`: Lesebestätigung der Nachricht Nr. 6 (blaue Haken).
   - **FPort 1**, Payload `1D1EECF00166EAD0`: Position.

## Oberfläche des simulierten Geräts: `tools/sensor.html`

Eigene Seite für den Sensor, zu öffnen unter `http://localhost:8080/tools/sensor.html` (mit `node start.js`), neben der Hauptoberfläche. Sie sendet **echte simulierte Uplinks an TTN** (gleicher Aufruf und gleicher API-Schlüssel wie `simulate.html`), und die Hauptoberfläche empfängt sie über den Ereignisstrom (Demo-Modus abgewählt):
- **Position** (FPort 1): Koordinaten, Schaltflächen „in / außerhalb der Zone“, Bewegungspfeile, automatischer Versand alle 30 s.
- **Sprachnachrichten**: Das Mikrofon sendet eine Sprachnachricht (höchstens 10 s) über das WLAN-Relay an die Seite, wie das echte Gerät. Keine Tastatur und kein Textfeld: Das Gerät schreibt nicht.
- **Nachrichten der Seite**: Das Relay meldet jeden Versand der Seite an diese Sensor-Seite. Ein **Text** wird in Sprache umgewandelt und vorgelesen, dann geht die **Lesebestätigung** (FPort 3) an TTN: Die Haken auf der Hauptoberfläche werden blau. Eine **Sprachnachricht** wird heruntergeladen, abgespielt und dann über das Relay bestätigt.
- **Karte**: die überwachte Zone und die Markierung des Geräts (zum Ziehen oder Anklicken).

Voraussetzungen: aktueller Decoder in der TTN-Konsole und ein API-Schlüssel mit dem Recht *Write uplink application traffic*.

## Testablauf Schritt für Schritt (ohne Hardware)

1. `node start.js`. Öffnen Sie `http://localhost:8080/web/` und in einem zweiten Tab `http://localhost:8080/tools/simulate.html`. Verwenden Sie unbedingt **localhost**.
2. Haken Sie auf der Seite **Demo-Modus** an (es geht kein echter Downlink hinaus) und klicken Sie einmal auf die Seite, um den Ton zu aktivieren.
3. **Seite zum Gerät**: Schreiben Sie „Ich hole Sie gleich ab“ ins Eingabefeld und klicken Sie auf Senden (oder diktieren Sie mit der kleinen Schaltfläche „Diktieren“ im Textfeld). Das Protokoll zeigt „[DEMO] simulierter Downlink: Text … (Port 4)“. Die Sensor-Seite zeigt die empfangene Nachricht, **wandelt sie in Sprache um und spricht sie laut aus**, und die Blase der Seite bekommt blaue Haken.
4. **Seite zum Gerät, als Sprache**: Klicken Sie auf der Seite auf das grüne Mikrofon, sprechen Sie (höchstens 10 s) und klicken Sie auf „Senden“. Die Sensor-Seite (`tools/sensor.html`, daneben geöffnet) spielt die Nachricht ab und bestätigt sie: Die Haken der Seite werden blau.
4b. **Gerät zur Seite, als Sprache**: Klicken Sie auf der Sensor-Seite auf das Mikrofon, sprechen Sie, klicken Sie erneut. Auf der Hauptseite: Piepton, Abzeichen „neu“, Blase links, und die Nachricht wird **automatisch abgespielt** (sofern der Browser den Ton erlaubt; sonst klicken Sie auf Wiedergabe).
5. **Die Alarme laufen weiter**: Bewegen Sie im Demo-Modus den Sensor aus der Zone (Pfeiltasten, Umschalt = großer Schritt): Banner, virtuelle LED und SMS (simuliert) funktionieren wie zuvor.
6. **Echt** (Gerät dem Netz beigetreten): Demo-Modus abwählen; der Text geht als echter Downlink (Port 4) hinaus. Solange das Gerät nicht beigetreten ist, antwortet The Things Stack mit `no_device_session`, und die Seite erklärt das.
7. Automatischer Test des Relays: `node tools/test-voice.js`.

## Bekannte Grenzen
- Die **Firmware wurde nie kompiliert oder ausprobiert** (siehe `firmware/README.md`).
- Das Gerät empfängt den Text erst nach seinem nächsten Uplink (Klasse A): höchstens 30 s, plus die Grenze von einem Downlink pro Minute zwischen zwei Nachrichten.
- Das Diktat hängt von Chrome und dem Internet ab; es wurde in diesem Projekt nicht mit einem echten Mikrofon ausprobiert.
- Ein einziges Gerät; keine Verschlüsselung des Textes über die von LoRaWAN hinaus.
