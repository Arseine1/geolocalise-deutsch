# Technische Erklärung des Projekts

## 1. Ziel
Eine Webseite zeigt auf einer Karte die Position eines GPS-Geräts, die per LoRaWAN über The Things Stack empfangen wird. Verlässt die Position eine Polygonzone (definiert durch 3 oder mehr GPS-Punkte), löst die Seite einen Alarm aus (optisch und akustisch) und sendet einen Downlink, der eine LED ansteuert. Es gibt **keinen Backend-Server**: Die Seite (HTML/JS) spricht direkt mit der HTTPS-API von The Things Stack.

## 2. Datenfluss und Protokolle

### Echte Demo (mit Hardware)
```
 Heltec V3 + GPS NEO-6M
   | NMEA 0183 über UART, 9600 Baud (GPS -> Platine)
   v
 Firmware (RadioLib, TinyGPSPlus)  -- Rahmen von 8 Byte, FPort 1
   | LoRaWAN 1.0.x, OTAA, EU868 (LoRa-Modulation, 868 MHz), AES-128-verschlüsselte Nachricht
   v
 LoRaWAN-Gateway
   | IP zum Netzwerkserver (Protokoll je nach Gateway: Semtech UDP oder Basic Station)
   v
 The Things Stack (Cloud, Cluster eu1)
   |  Network Server: Deduplizierung, MIC, Zähler, Downlink-Warteschlangen
   |  Application Server: Entschlüsselung (AppSKey), JavaScript-Formatter des Geräts
   |  --> Ereignis "uplink_message" mit decoded_payload {lat, lng}
   | HTTPS: POST /api/v3/events, Antwort als JSON-Strom (eine Zeile pro Ereignis)
   v
 Webseite (Leaflet + JavaScript)
   | Zugehörigkeitstest zum Polygon, Abstand zum Rand, Alarm
   | HTTPS: POST .../webhooks/geofence-web/devices/heltec-gps-01/down/push
   |        {"downlinks":[{"frm_payload":"AQ==","f_port":2,"priority":"HIGH"}]}
   v
 The Things Stack: Downlink-Warteschlange des Geräts
   | im Empfangsfenster nach dem NÄCHSTEN Uplink übertragen (Klasse A)
   v
 Gateway --> LoRa --> Heltec: FPort 2, Byte 0x01 -> LED blinkt, 0x00 -> LED aus
```

### Simulierte Demo (was Sie jetzt nutzen)
```
 tools/simulate.html (Position) und tools/sensor.html (Position, Nachrichten)
   | HTTPS: POST .../devices/heltec-gps-01/up/simulate
   |        {"uplink_message":{"f_port":1,"frm_payload":"<Base64 der 8 Byte>","settings":{"data_rate":{"lora":{"bandwidth":125000,"spreading_factor":7,"coding_rate":"4/5"}},"frequency":"868100000"}}}
   v
 The Things Stack: Application Server (Uplink-Formatter --> decoded_payload)
   | HTTPS: Strom POST /api/v3/events
   v
 web/index.html   --> Alarm, virtuelle LED
   | HTTPS: Downlink-Push (gleiche URL wie oben)
   v
 Downlink-Warteschlange des Geräts: Sie bleibt voll, da kein Gerät sie leert
```
Die Simulation speist den Uplink in den Application Server ein: Funk, Gateway, Verschlüsselung der Funkschicht und Empfangsfenster werden nicht geprüft.

## 3. Aufgabe jeder Komponente

| Komponente | Aufgabe |
|---|---|
| `ttn/uplink_decoder.js` | Uplink-Formatter (Geräte-Ebene): wandelt die 8 Byte in `{lat, lng}` um; FPort 3: Lesebestätigung eines Textes `{ack}`. |
| `ttn/downlink_encoder.js` | Downlink-Formatter: `{alert: true/false}` zu Byte 1 oder 0 auf FPort 2; `{text, seq}` zu FPort 4; `{voice: true}` zu FPort 5. |
| API-Schlüssel `geofence-web` | Zugangstoken: liest den Verkehr, schreibt Downlinks, schreibt Uplinks (Simulation). |
| Webhook `geofence-web` | Seine Existenz aktiviert die Downlink-URL über den Webhook. Die Basis-URL ist ein Platzhalter, es wird nichts zugestellt. |
| `web/config.js` | Parameter: Host, Kennungen, Schlüssel, Standardzone (`DEFAULT_ZONE`). Von git ausgeschlossen. |
| `web/app.js` | Ereignisstrom, Karte, Erkennung, Alarm, Ton, Downlink, Demo-Modus, Nachrichten, Zone aus Adresse. |
| `tools/simulate.html` | Ersetzt das Gerät: sendet simulierte Uplinks. |
| `tools/sensor.html` | Seite des simulierten Geräts: Karte, Position, Sprachnachrichten, Empfang der Nachrichten der Seite. |
| `tools/sms-proxy.js` | Lokaler SMS-Versand (Vonage), Empfängerverwaltung. |
| `tools/voice-relay.js` | Sprach-Relay (Nachrichten, Audio, Benachrichtigungen) und lokale Sprachsynthese. |
| `firmware/heltec_gps_geofence` | Code des echten Geräts; nicht getestet, für den Tag, an dem die Hardware existiert. |

Warum ein HTTP-Ereignisstrom und nicht MQTT: Ein Browser kann nur WebSocket öffnen, und die getesteten MQTT-Ports (8883: reines MQTT-TLS; 443, Pfad `/mqtt`: Fehler 404) bieten es nicht an. Die HTTP-API dagegen akzeptiert Aufrufe zwischen Ursprüngen (`access-control-allow-origin: *`).

## 4. Rahmen von 8 Byte, Byte für Byte
FPort 1. Zwei vorzeichenbehaftete 32-Bit-Ganzzahlen, Big-Endian (höchstwertiges Byte zuerst), in Grad × 10⁷.

| Byte | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|---|---|---|---|---|---|---|---|---|
| Inhalt | Breitengrad, höchstwertig | | | Breitengrad, niederwertig | Längengrad, höchstwertig | | | Längengrad, niederwertig |

Beispiel: Breitengrad 48.8566, Längengrad 2.3522.
- 48.8566 × 10⁷ = 488 566 000 = `0x1D1EECF0` → Bytes `1D 1E EC F0`.
- 2.3522 × 10⁷ = 23 522 000 = `0x0166EAD0` → Bytes `01 66 EA D0`.
- Vollständiger Rahmen: `1D1EECF00166EAD0`, also `HR7s8AFm6tA=` in Base64 (das ist der Wert des Feldes `frm_payload`).

Dekodierung des Breitengrads: `(0x1D << 24) | (0x1E << 16) | (0xEC << 8) | 0xF0 = 488 566 000`, dann Division durch 10⁷ → 48.8566. Das `| 0` des Decoders erzwingt die vorzeichenbehaftete 32-Bit-Interpretation.

Negative Werte (Zweierkomplement): Breitengrad −33.8688 → −338 688 000 → `0xEBD00800`; Längengrad −70.6693 → −706 693 000 → `0xD5E0B878`; Rahmen `EBD00800D5E0B878`.

Auflösung: 10⁻⁷ Grad, also etwa 1,1 cm beim Breitengrad. Tatsächliche Größe eines LoRaWAN-Rahmens: 8 Byte Nutzlast + 13 Byte Kopf und Signatur (MHDR 1, DevAddr 4, FCtrl 1, FCnt 2, FPort 1, MIC 4) = 21 Byte.

Der Downlink der LED ist ein einziges Byte auf FPort 2: `0x01` (Alarm, LED blinkt) oder `0x00` (LED aus). Die Nachrichten benutzen weitere Ports: Uplink 3 (Lesebestätigung, 1 Byte), Downlink 4 (Text: `[Nummer] + UTF-8`, höchstens 49 Byte Text) und Downlink 5 (1 Byte: „eine Sprachnachricht wartet auf dem Relay“). Siehe [SPRACHNACHRICHTEN.md](SPRACHNACHRICHTEN.md).

## 5. Polygonzone, Erkennung und Hysterese
- **Definition der Zone**: N GPS-Punkte (N ≥ 3), eingegeben durch Klicken auf die Karte, durch Einfügen von „Breitengrad, Längengrad“ Zeile für Zeile, oder **aus einer Adresse**: Die Adresse wird bei Nominatim gesucht (`GET https://nominatim.openstreetmap.org/search`), und die Zone wird als Polygon aus 24 Punkten um den gefundenen Punkt gezeichnet, mit einem Radius von 50 m bis 5 km (500 m standardmäßig). 3 Punkte bilden ein Dreieck, 4 ein Viereck, 5 ein Fünfeck usw. Mit weniger als 3 Punkten ist die Zone „nicht definiert“, und es wird kein Alarm ausgegeben.
- **Zeichnen des Polygons**: Standardmäßig werden die Punkte nach Winkel um ihre Mitte (Mittelwert der Koordinaten) sortiert und in dieser Reihenfolge verbunden. So entsteht eine Form ohne sich kreuzende Seiten, unabhängig von der Eingabereihenfolge. Eine von Hand gezeichnete konkave Form kann durch diese Sortierung verändert werden: Wählen Sie die automatische Reihenfolge ab, um die Eingabereihenfolge zu behalten (die Seite meldet dann, ob sich Seiten kreuzen).
- **Statische Zone**: Sie ändert sich nur, wenn man „Zone bearbeiten“ aktiviert. Sie wird im Browser gespeichert (`localStorage`, Schlüssel `geofence-zone-v1`) und mit `tools/simulate.html` geteilt, wenn es unter derselben Adresse geöffnet ist; sonst gilt der Wert von `DEFAULT_ZONE` in `config.js`.
- **Zugehörigkeit**: Strahlwurf (man zählt die von einem Strahl ab der Position gekreuzten Seiten; ungerade Anzahl = innen).
- **Abstand zum Rand**: kürzester Abstand der Position zu den Seiten, in Metern in einer lokalen Ebene berechnet (1° Breitengrad ≈ 110 574 m, 1° Längengrad ≈ 111 320 m × cos(Breitengrad)). Die Näherung ist im Maßstab einer Stadt sehr gut. Der Abstand ist **vorzeichenbehaftet**: positiv innen, negativ außen.
- **Hysterese von 5 m**, um Alarme in Serie zu vermeiden, wenn das GPS um den Rand schwankt:

| Aktueller Zustand | Wechselt zu | Bedingung |
|---|---|---|
| innen | außen | vorzeichenbehafteter Abstand **<** −5 m (mehr als 5 m außerhalb des Rands) |
| außen | innen | vorzeichenbehafteter Abstand **>** +5 m (mehr als 5 m innerhalb des Rands) |
| unbekannt (erste Position) | innen oder außen | vorzeichenbehafteter Abstand ≥ 0: innen, sonst außen |

- **Alarm** nur bei einer **Zustandsänderung** (und wenn die allererste Position schon außen liegt). Eine Änderung der Zone bewertet die letzte Position neu.
- **Grenze von 60 s**: höchstens ein Downlink pro Minute; eine vor Ablauf angeforderte Änderung wird verzögert, nicht verworfen.

## 6. LoRaWAN Klasse A
- Ein Gerät der Klasse A **sendet, wann es will** (hier alle 30 s) und hört nur in zwei kurzen Empfangsfenstern, die direkt nach jedem Uplink geöffnet werden (RX1 etwa 1 s danach, RX2 etwa 2 s danach bei den Standardeinstellungen).
- Der Server kann es also nicht von sich aus ansprechen: Ein von der Seite eingereihter Downlink wird erst **nach dem nächsten Uplink** übertragen. Die Verzögerung beim Einschalten der LED reicht von einigen Sekunden bis 30 s, je nach Zeitpunkt des Alarms.
- Folge für die Nachrichten: Die Downlinks bleiben bis zu diesem Fenster in der Warteschlange des Servers.
- Funktechnische Grenze: In EU868 ist die Sendezeit auf 1 % der Zeit je Unterband begrenzt; die Nutzungsrichtlinie Ihres Tarifs kann strenger sein (nicht geprüft).

## 7. Simulierte und echte Demo

| Punkt | Simuliert (aktuell) | Echt |
|---|---|---|
| Quelle der Positionen | `simulate.html` / `sensor.html` (HTTP-POST) | GPS NEO-6M, Rahmen per LoRa |
| Funk, Gateway | nicht genutzt | zwingend |
| OTAA-Beitritt, Funkverschlüsselung | nicht geprüft | geprüft |
| Dekodierung durch den Formatter | ja | ja |
| Ereignisstrom, Erkennung, Alarm | identisch | identisch |
| Downlink | eingereiht, nie übertragen | nach dem nächsten Uplink übertragen |
| LED | virtuell (Seite) | virtuell + LED der Platine |
| Takt | auf Anforderung, oder eine Position / 5 s | 30 s |
| Aussagekraft der Ergebnisse | validiert die Software-Kette | validiert auch Reichweite, GPS-Fix, Latenz der Klasse A |

Was in der Simulation nicht validiert wird: der Empfang eines echten Downlinks durch die Platine, die Qualität des GPS-Fix im Freien, die Abdeckung des Gateways.

## 8. Echte Orte: Adresse, Stadt, Kreuzung
Die Seitenleiste zeigt zusätzlich zu den Koordinaten den Ort des Sensors und den Ort der Zonenmitte.
- **Adresse und Stadt**: Anfrage `GET https://nominatim.openstreetmap.org/reverse` (umgekehrte OpenStreetMap-Geokodierung), höchstens 1 Anfrage pro Sekunde, mit Zwischenspeicher und neuer Anfrage erst nach 25 m Bewegung (Nutzungsrichtlinie von Nominatim).
- **Nächste Kreuzung**: Anfrage an die Overpass-API (`overpass-api.de`), die die benannten Straßen im Umkreis von 150 m liefert. Eine Kreuzung ist ein Knoten, den mindestens zwei Straßen mit verschiedenen Namen teilen; die Seite zeigt die nächste an, bei mindestens 40 m Bewegung und 8 s Abstand.
- **Vertraulichkeit**: Diese beiden Aufrufe senden die **Koordinaten des Sensors an Drittdienste**; beim Zeichnen der Zone aus einer Adresse wird zudem die **eingegebene Adresse an Nominatim** gesendet. Bei einer echten Überwachung von Personen oder Fahrzeugen ist das vor dem Einsatz zu entscheiden.
- **Zuverlässigkeit**: Ist der Dienst nicht verfügbar, zeigt die Seite „nicht verfügbar“, ohne den Alarm zu blockieren. Während meiner Versuche antwortete der öffentliche Overpass-Server „at capacity“: Der Teil mit der Kreuzung wurde daher nur mit simulierten Daten getestet, nicht auf dem echten Server.

## 9. Risiko des API-Schlüssels im Frontend
- `config.js` wird dem Browser unverändert ausgeliefert: Der Schlüssel ist im Quelltext der Seite, im Tab Netzwerk (Header `Authorization`) und im Klartext auf der Festplatte lesbar.
- Dieser Schlüssel erlaubt, den Verkehr der Anwendung zu **lesen**, **Downlinks zu senden** und **falsche Uplinks einzuspeisen**. Wer ihn in die Hände bekommt, kann die Positionen verfälschen oder die LED aus der Ferne einschalten.
- Angewandte Gegenmaßnahmen: Rechte auf drei Berechtigungen beschränkt (nicht „alle Rechte“), `config.js` von git ausgeschlossen, Nutzung nur auf `localhost`.
- Zu tun: Datei und Seite nicht weitergeben, **den Schlüssel nach der Demo widerrufen** (myfirst1 > API keys), ihm ein kurzes Ablaufdatum geben.
- Dieser Schlüssel wurde während der Arbeitssitzung mit dem Assistenten in `config.js` geschrieben: Er ist also durch diese Unterhaltung gelaufen. Ihn zu widerrufen und für jeden dauerhaften Einsatz einen neuen anzulegen, ist die vorsichtige Entscheidung.
- Für einen echten Produktivbetrieb: Ein kleiner Zwischenserver würde den Schlüssel auf der Serverseite halten; genau das vermeidet dieses Projekt, um den Preis dieser Offenlegung.
