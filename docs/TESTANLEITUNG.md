# Testanleitung: Szenario OHNE Hardware

Dieses Szenario benötigt weder Heltec noch GPS noch Gateway. Die Positionen werden von `tools/simulate.html` (Uplink-Simulations-API von The Things Stack) eingespeist, und die LED ist virtuell (ein Kreis in der Seite).

Voraussetzungen: installiertes Node.js 18 oder neuer (oder Python, Befehl `python`), ein aktueller Browser (Chrome empfohlen), das Konto bei The Things Industries (Tenant team-global, Cluster eu1) und die Anwendung `myfirst1`.

## Schritt 1: Konfiguration von The Things Industries
[CONFIG_TTI.md](CONFIG_TTI.md), Punkte a bis e, befolgen:
- Gerät `heltec-gps-01` (OTAA, EU868) in `myfirst1` angelegt;
- `ttn/uplink_decoder.js` in **Payload formatters > Uplink** eingefügt, `ttn/downlink_encoder.js` in **Downlink** (Typ *Custom Javascript formatter*, auf **Geräte**-Ebene);
- API-Schlüssel `geofence-web` mit drei Rechten: Verkehr lesen, Downlinks schreiben, Uplinks schreiben;
- Webhook `geofence-web` angelegt (Platzhalter als Basis-URL).

**Erwartetes Ergebnis**:
- Im Testbereich des Uplink-Formatters ergeben FPort `1` und die Bytes `1D1EECF00166EAD0` den Wert `{ "lat": 48.8566, "lng": 2.3522 }`.
- Der Webhook erscheint unter **Integrations > Webhooks**, Status „Pending“ (normal: Es wurde noch nichts gesendet).
- Der API-Schlüssel wurde bei seiner Erstellung kopiert (er lässt sich danach nicht mehr anzeigen).

## Schritt 2: `web/config.js` ausfüllen
Die einfachste Möglichkeit ist der Assistent `node setup.js` (er stellt die Fragen und legt `web/config.js` an). Von Hand: [web/config.example.js](../web/config.example.js) nach `web/config.js` kopieren und eintragen:
- `API_KEY`: der in Schritt 1 angelegte Schlüssel (anstelle von `TA-CLE-API`);
- `DEFAULT_ZONE`: GPS-Punkte `[Breitengrad, Längengrad]` der Zone (mindestens 3: Dreieck; 4: Viereck; 5: Fünfeck …). Das mitgelieferte Beispiel ist ein unregelmäßiges Sechseck (6 Punkte, etwa 1 km) um Paris. Die Zone lässt sich auch direkt in der Seite definieren („Zone bearbeiten“, oder aus einer Adresse).

**Erwartetes Ergebnis**: Die Datei ist gespeichert, `RECEIVE_MODE` steht auf `"events"`, und `API_KEY` enthält nicht mehr den Text `TA-CLE-API`.

## Schritt 3: lokalen Server starten
In einem Terminal in den Projektordner wechseln und starten:

```powershell
cd "C:\xampp\htdocs\top projet\geolocalise-deutsch"
```

```powershell
node start.js
```

**Erwartetes Ergebnis**: Das Terminal zeigt die Adresse der Seite an (`http://localhost:8080/web/`) und bleibt geöffnet. Schließen Sie es während des Tests nicht. Ist der Port 8080 belegt, nimmt der Server den nächsten freien Port; passen Sie die Adressen unten an. (Alternativ, nur für die Seite ohne SMS und Nachrichten: `python -m http.server 8080`.)

## Schritt 4: Demo-Seite öffnen
`http://localhost:8080/web/` im Browser öffnen und dann einmal auf **Ton aktivieren** klicken.

**Erwartetes Ergebnis**:
- OpenStreetMap-Karte auf die Zone zentriert, **blaues** Polygon mit nummerierten Punkten (Zustand unbekannt) und unter „Überwachte Zone“ der Text „Viereck (4 Punkte)“;
- grünes Abzeichen oben rechts: „Datenstrom: Ereignisstrom aktiv“;
- Protokoll: „Ereignisstrom geöffnet: Warten auf Uplinks“;
- nach dem Klick auf „Ton aktivieren“: Schaltfläche „Ton aktiv ✓“ und ein Test-Piepton;
- Seitenleiste: letzte Position „keine“, Zone „UNBEKANNT“, virtuelle LED grau „aus“.

## Schritt 5: Simulator öffnen
In einem zweiten Tab `http://localhost:8080/tools/simulate.html` öffnen.

**Erwartetes Ergebnis**: Das Protokoll zeigt „Simulator bereit. Ziel: https://team-global.eu1.cloud.thethings.industries/api/v3/as/applications/myfirst1/devices/heltec-gps-01/up/simulate“.

## Schritt 6: eine Position IN der Zone senden
In `simulate.html` auf **Position in der Zone** klicken.

**Erwartetes Ergebnis**:
- `simulate.html`: Protokoll mit dem gesendeten Rahmen (Hex `1D1EECF00166EAD0` für die Standardmitte), dann „HTTP 200“ (ein anderer 2xx-Code ist möglich: Ich habe die echte Antwort der API nicht gesehen);
- Demo-Seite: Protokoll „Uplink empfangen: lat 48.8566, lng 2.3522“, dann „Erste Position: in der Zone (0 m vom Rand)“;
- blaue Markierung im Inneren des Polygons, **grünes** Polygon, Zone „DRINNEN“, Abstand „N m vom Rand, innerhalb“;
- kein Banner, kein Ton, LED grau.

Hinweis: `simulate.html` nutzt die von der Demo-Seite gespeicherte Zone (dieselbe Adresse `localhost:8080` ist zum Teilen der Zone zwingend), sonst `DEFAULT_ZONE` aus `config.js`. Es sendet einen Punkt im Inneren des Polygons. Ändern Sie die Zone, laden Sie `simulate.html` neu.

## Schritt 7: eine Position AUSSERHALB der Zone senden
Auf **Position außerhalb der Zone** klicken (Punkt östlich des Polygons, jenseits seines Rands).

**Erwartetes Ergebnis**:
- Protokoll: „ALARM: Gerät AUSSERHALB der Zone, N m vom Rand“;
- **blau/rot blinkendes** Banner „ALARM: Das Gerät hat die Zone VERLASSEN“;
- 3 Pieptöne (wenn der Ton aktiviert ist);
- **rotes** Polygon, Zone „DRAUSSEN“;
- Protokoll: „Downlink 0x01 (HTTP): Code 200“ (oder ein anderer 2xx-Code), Seitenleiste „Downlink: HTTP“;
- **rot blinkende virtuelle LED** („an (Downlink 0x01 gesendet)“).

## Schritt 8: in die Zone zurückkehren
Erneut auf **Position in der Zone** klicken.

**Erwartetes Ergebnis**:
- **grünes** Banner „Das Gerät ist in die Zone ZURÜCKGEKEHRT“ für 10 s und 2 hohe Pieptöne;
- grünes Polygon, Zone „DRINNEN“;
- ist das Kästchen „Rückkehr-Downlink senden“ angehakt: Der Downlink 0x00 ist auf **einen Versand pro 60 s** begrenzt. Wird er weniger als 60 s nach dem 0x01 angefordert, zeigt das Protokoll „Downlink 0x00 um N s verzögert“, und die virtuelle LED wird wieder grau, wenn er hinausgeht.

## Schritt 9 (optional): automatische Strecke
In `simulate.html` auf **Strecke starten** klicken.

**Erwartetes Ergebnis**: 11 Positionen, eine alle 5 s, von einem inneren Punkt zu einem Punkt östlich der Zone. Die Seite geht in den Alarm, sobald die Position mehr als 5 m außerhalb des Rands liegt (Hysterese). Die Strecke endet an der letzten Position („Strecke beendet“).

## Schritt 11: eine eigene Zone definieren (Dreieck, Viereck, Polygon, oder aus einer Adresse)
In der Demo-Seite, Abschnitt „Überwachte Zone“:
1. **Aus einer Adresse**: Geben Sie im Feld „Zone aus einer Adresse zeichnen“ eine Adresse ein (ohne Koordinaten) und klicken Sie auf **Suchen**: Der Punkt wird gesetzt und die Zone darum gezeichnet. Stellen Sie den **Radius** ein (50 m bis 5 km, 500 m standardmäßig): Die Zone wird sofort neu gezeichnet. Weitere Treffer werden als Schaltflächen angeboten.
2. **Von Hand**: Klicken Sie auf **Zone bearbeiten** und dann auf **Alles löschen**.
3. Klicken Sie auf die Karte, um die Punkte zu setzen: 3 Punkte bilden ein Dreieck, 4 ein Viereck, 5 ein Fünfeck usw. Die Punkte sind nummeriert. Ein Punkt lässt sich durch Ziehen verschieben, ein Rechtsklick löscht ihn.
4. Oder fügen Sie Koordinaten in das Textfeld ein (eine Zeile `Breitengrad, Längengrad` pro Punkt) und klicken Sie auf **Koordinaten übernehmen**.
5. Klicken Sie auf **Bearbeitung beenden**: Die Zone ist wieder gesperrt (statisch) und im Browser gespeichert.

**Erwartetes Ergebnis**: Das Polygon wird durch Verbinden der Punkte gezeichnet, der Text nennt die Form („Dreieck (3 Punkte)“, „Fünfeck (5 Punkte)“ …), die Zone wird je nach Position des Sensors grün oder rot. Mit weniger als 3 Punkten ist die Zone „NICHT DEFINIERT“, und es wird kein Alarm ausgelöst.

## Schritt 10: den eingereihten Downlink in der Konsole prüfen
In der Konsole: **Applications > myfirst1 > Live data** (oder **End devices > heltec-gps-01 > Live data**).

**Erwartetes Ergebnis**:
- ein weitergeleitetes Uplink-Ereignis (Name nahe bei „Forward uplink data message“) mit `decoded_payload`: `lat`, `lng`;
- ein Ereignis zum Einreihen eines Downlinks (Name mit „downlink“, z. B. „Schedule data downlink for transmission“ oder „Queue downlink“) mit `f_port` 2 und `frm_payload` `AQ==` (0x01) oder `AA==` (0x00).

Da sich das Gerät nie verbindet, bleibt der Downlink **in der Warteschlange**: Kein Gateway überträgt ihn. Das ist in der Simulation normal. Die genauen Bezeichnungen der Ereignisse können in Ihrer Konsole abweichen; ich habe sie nicht gesehen.

## Fehlersuche

| Symptom | Wahrscheinliche Ursache | Maßnahme |
|---|---|---|
| Abzeichen „Fehler bei allen URLs“ oder „WebSocket abgelehnt“ | Der Modus `RECEIVE_MODE: "mqtt"` ist aktiv. Die Ports 8883 (reines MQTT-TLS) und 443 (`/mqtt` antwortet 404) bieten kein MQTT-WebSocket. | `RECEIVE_MODE: "events"` in `config.js` setzen, mit Strg+F5 neu laden. |
| Strom: „HTTP 401“ oder Abzeichen „abgelehnt (HTTP 401)“ | API-Schlüssel falsch, abgeschnitten, widerrufen oder mit Leerzeichen. | Schlüssel neu anlegen und vollständig in `config.js` übernehmen. |
| Strom: „HTTP 403“ | Dem Schlüssel fehlt das Recht, den Verkehr zu lesen. | **Read application traffic (uplink and downlink)** (und bei Bedarf **View devices in application**) zum Schlüssel hinzufügen. |
| `simulate.html`: 403 | Recht zur Simulation fehlt. | **Write uplink application traffic** zum Schlüssel hinzufügen. |
| `simulate.html` oder Downlink: 404 | `APP_ID`, `DEVICE_ID` oder `WEBHOOK_ID` falsch, oder Webhook fehlt. | `config.js` prüfen und prüfen, ob der Webhook `geofence-web` existiert. |
| „Anfrage blockiert (wahrscheinlich CORS oder Netzwerk)“ oder „Failed to fetch“ | Netzwerk getrennt, Blockier-Erweiterung, Firmen-Proxy oder Seite per `file://` geöffnet. Ein Test ohne Schlüssel zeigt, dass die API mit `access-control-allow-origin: *` antwortet, es ist also keine Blockade auf Serverseite. | Die Seiten über `http://localhost:8080/...` öffnen, Blockier-Erweiterungen abschalten oder den Uplink mit dem in `simulate.html` angezeigten PowerShell-Befehl senden. Im Modus `events` gibt es keinen Ersatz des Downlinks über MQTT (keine MQTT-Verbindung). |
| „Uplink ohne dekodierte lat/lng empfangen“ (`decoded_payload` fehlt) | Der Uplink-Formatter ist nicht gespeichert, leer, fehlerhaft, oder der FPort ist nicht 1 oder der Rahmen hat nicht 8 Byte. | **Payload formatters > Uplink** erneut öffnen, `uplink_decoder.js` einfügen, **Save changes**, `1D1EECF00166EAD0` auf FPort 1 testen. |
| Formatter falsch platziert | Auf Anwendungsebene eingefügt, oder der Typ blieb auf „None / Repository“, oder falscher Inhalt (z. B. der Hex-Wert im Codefeld). | Auf **Geräte**-Ebene setzen: End devices > heltec-gps-01 > Payload formatters, Typ **Custom Javascript formatter**, Uplink = `uplink_decoder.js`, Downlink = `downlink_encoder.js`. |
| „Ereignis ignoriert (unerwarteter Name): …“ | Das Uplink-Ereignis trägt einen anderen Namen als `as.up.data.forward`. | Den im Protokoll angezeigten Namen kopieren; er muss in `app.js` (Funktion `eventsLoop`) angepasst werden. |
| Uplink in Live data sichtbar, aber nicht in der Seite | Der Server schließt den Ereignisstrom etwa alle 15 s; ohne Nachholen ging ein während des Wiederöffnens gesendeter Uplink verloren. Die Seite öffnet den Strom jetzt in 0,3 s neu und fordert die verpassten Ereignisse erneut an (Parameter `after`, auf dem echten Server nicht geprüft). | Mit Strg+F5 neu laden, auf „Ereignisstrom geöffnet“ warten, dann den Uplink erneut senden. |
| Kein Uplink angezeigt, Strom aktiv | Simulation an ein anderes Gerät oder eine andere Anwendung gesendet, oder Schlüssel ohne Leserecht. | `config.js` mit der Konsole vergleichen; in Live data nachsehen, ob der Uplink dort erscheint. |
| Karte ohne Kachelhintergrund | Seite per `file://` geöffnet oder kein Internetzugang. | Über den lokalen Server gehen (Schritt 3). |
| Kein Ton | Der Browser blockiert das Audio, solange nicht geklickt wurde. | Auf die Seite oder auf „Ton aktivieren“ klicken. |
| Downlink HTTP 400 oder 404 | Webhook `geofence-web` fehlt, oder URL falsch. | Webhook neu anlegen (CONFIG_TTI.md, Punkt d) und `DOWNLINK_URL` in `config.js` prüfen. |
| Die SMS-Alarme „fehlen“ nach einem Austritt oder einer Rückkehr | Der Proxy lehnt eine SMS ab, die weniger als 30 s nach der vorigen kommt; die Seite sendet sie nach Ablauf der Wartezeit erneut. | Im Protokoll nachsehen („SMS … verzögert“), das Tageslimit (`DAILY_MAX`) und die Meldungen des Proxys im Terminal prüfen. |

## Auszufüllende Werte

| Datei | Zeile | Wert |
|---|---|---|
| `web/config.js` | `API_KEY` | Ihr API-Schlüssel (ersetzt `TA-CLE-API`) |
| `web/config.js` | `DEFAULT_ZONE` | GPS-Punkte `[lat, lng]` der Zone (mindestens 3) |
| `web/config.js` | `APP_ID`, `DEVICE_ID`, `WEBHOOK_ID` | schon eingestellt für `myfirst1`, `heltec-gps-01`, `geofence-web` |
| `firmware/.../heltec_gps_geofence.ino` | `DEV_EUI` und `APP_KEY` | nur an dem Tag, an dem Sie die Hardware haben |

## Die ersten Befehle

```powershell
cd "C:\xampp\htdocs\top projet\geolocalise-deutsch"
```

```powershell
node start.js
```

Der zweite Befehl startet Webserver, SMS-Proxy und Browser in einem Schritt und hält das Terminal belegt. Ohne `node start.js` öffnen Sie die Adresse einfach im Browser.

## Schritt 12: SMS-Alarme (optional)
Siehe [SMS_VONAGE.md](SMS_VONAGE.md). Kurz gefasst, in einem zusätzlichen Terminal (falls Sie nicht `node start.js` nutzen):

```powershell
node tools/sms-proxy.js
```

**Erwartetes Ergebnis**: Das Terminal zeigt „SMS-Proxy (Vonage) gestartet“ und „TESTMODUS“ (solange Sie `tools/sms-proxy.env` nicht angelegt haben). In der Seite meldet der Abschnitt „SMS-Alarme“ „Proxy verbunden · TESTMODUS“. Die Schaltfläche „Test-SMS senden“ fügt dem Protokoll den SMS-Text hinzu. Außerhalb des Demo-Modus fügt ein Austritt aus der Zone „SMS im Testmodus …“ hinzu; mit Ihren Vonage-Zugangsdaten geht eine echte SMS hinaus.

## Schritt 13: Nachrichten und simuliertes Gerät (optional)
Siehe [SPRACHNACHRICHTEN.md](SPRACHNACHRICHTEN.md): Öffnen Sie `http://localhost:8080/tools/sensor.html` neben der Hauptseite (Demo-Modus abgewählt), um Positionen, Textnachrichten und Sprachnachrichten wie mit dem echten Gerät auszutauschen.
