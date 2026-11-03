# SMS-Alarme mit Vonage

Bei jedem Verlassen der Zone (und optional bei jeder Rückkehr) fordert die Seite den Versand einer SMS an. Sie spricht nicht direkt mit Vonage: Sie geht über ein kleines lokales Programm, `tools/sms-proxy.js`.

## Warum ein Zwischenprogramm
- Vonage verlangt einen Schlüssel und ein Geheimnis; jede SMS kostet Geld. In die Webseite gelegt, wären sie für jeden lesbar (Quelltext der Seite).
- Die Adressen der Vonage-API antworten nicht auf die Kontrollanfragen eines Browsers (Test ohne Schlüssel: `rest.nexmo.com` → 404, `api.nexmo.com` → 403). Ein direkter Aufruf aus der Seite wird daher bestenfalls nicht unterstützt.
- Der Proxy behält das Geheimnis und setzt den Text selbst zusammen: Die Seite kann die Nachricht nicht schreiben. Sie darf nur Empfängernummern hinzufügen oder entfernen (höchstens 3) und sieht nie eine Nummer im Klartext, nur die letzten 3 Ziffern.

```
Webseite --(„Austritt“, Position)--> sms-proxy.js (127.0.0.1 und ::1, Port 3001) --(HTTPS, Schlüssel + Geheimnis)--> Vonage Messages API --> SMS
```

## Inbetriebnahme
1. **Vonage-Konto**: *API key* und *API secret* stehen auf der Startseite des Dashboards.
2. **Guthaben**: Ein Testkonto sendet nur an Ihre Nummer und einige verifizierte Testnummern (4 oder 5 laut den Supportseiten) und stellt den Nachrichten „[FREE SMS DEMO, TEST MESSAGE]“ voran. Laut Vonage-Support werden diese Einschränkungen durch Aufladen von Guthaben aufgehoben; eine Quelle, die den genauen Umfang des Freigeschalteten bestätigt, habe ich nicht gefunden.
3. **Konfigurationsdatei**: `tools/sms-proxy.env` (Vorlage: `tools/sms-proxy.env.example`). Tragen Sie ein:
   - `VONAGE_API_KEY` und `VONAGE_API_SECRET`;
   - `SMS_TO`: Nummern im internationalen Format ohne „+“, durch Kommas getrennt. Deutsches Beispiel: +49 151 2345 6789 wird zu `4915123456789` (Vorwahl 49, ohne die führende 0). Sobald der Proxy läuft, lassen sich die Nummern auch **direkt in der Seite** ändern (Abschnitt „SMS-Alarme“: Feld „Hinzufügen“, Schaltfläche „Entfernen“, höchstens 3 Nummern); sie werden dann in `tools/sms-recipients.json` gespeichert (von git ausgeschlossen), das Vorrang vor `SMS_TO` hat.
   - `SMS_FROM`: Absender (alphanumerischer Name mit höchstens 11 Zeichen oder eine Vonage-Nummer).
   Diese Datei ist von git ausgeschlossen (`tools/.gitignore`). Geben Sie sie nicht weiter und fügen Sie ihren Inhalt nicht in einen Chat ein.
4. **Proxy starten** (PowerShell-Terminal, Projektordner):

```powershell
cd "C:\xampp\htdocs\top projet\geolocalise-deutsch"
```

```powershell
node tools/sms-proxy.js
```
   Node 18 oder neuer ist erforderlich; es müssen keine Pakete installiert werden.
5. **Prüfen**: In der Seite zeigt „SMS-Alarme“ „Proxy verbunden“. Klicken Sie auf „Test-SMS senden“.

## Testmodus (ohne Zugangsdaten)
Ohne Zugangsdaten oder ohne `SMS_TO` zeigt der Proxy den SMS-Text in seinem Terminal und im Protokoll der Seite an, ohne etwas zu senden. Die Seite zeigt „TESTMODUS“. In diesem Zustand startet er, solange `sms-proxy.env` nicht ausgefüllt ist.

## Zustellverfolgung
„Angenommen“ von Vonage heißt nur „Nachricht übernommen“. 15 s nach jedem echten Versand liest die Seite das Versandprotokoll von Vonage (Reports-API, nur lesend) und zeigt das tatsächliche Ergebnis unter der Test-Schaltfläche an:
- grün: „Zugestellt“;
- rot: abgelehnt, mit Grund und Code (z. B. Code 24: Land von Fraud Defender gesperrt);
- orange: wartet auf den Netzbetreiber (die Seite prüft noch zweimal).

## Schutzmaßnahmen
| Schutzmaßnahme | Standardwert | Einstellung |
|---|---|---|
| Lauscht nur auf dem lokalen Rechner | 127.0.0.1 und ::1 | nicht änderbar |
| Seiten, die ihn aufrufen dürfen | jede auf diesem Rechner geöffnete Seite | `ALLOWED_ORIGINS` |
| Mindestabstand zwischen zwei Sendungen | 30 s (10 s für die Test-Schaltfläche) | `MIN_INTERVAL_SECONDS` |
| Tageslimit (SMS, alle Empfänger) | 10 | `DAILY_MAX` |

Das Limit wird in `tools/.sms-counter.json` gespeichert: Ein Neustart setzt es nicht zurück. Jeder Empfänger zählt als eine SMS. Wird eine Sendung wegen des Mindestabstands abgelehnt, sendet die Seite sie nach Ablauf der Wartezeit erneut (sofern sich die Lage nicht geändert hat).

## SMS-Text
Die Nachrichten sind für einen Angehörigen oder eine Pflegekraft geschrieben, die einen Patienten begleitet. Sie enthalten keine Umlaute (ä wird zu ae usw.; ein einziges Zeichen außerhalb des GSM-Alphabets senkt die Grenze von 160 auf 70 Zeichen) und passen jeweils in eine einzige SMS (etwa 115 bis 130 Zeichen):
- **Austritt**: `ALARM: Ihr Patient hat gerade seine Kontrollzone verlassen (123 m vom Rand). 10:04 https://maps.google.com/?q=48.85660,2.35220`
- **erste Position bereits außerhalb der Zone**: `ALARM: Ihr Patient befindet sich ausserhalb seiner Kontrollzone (11028 m vom Rand). 10:04 https://maps.google.com/?q=48.90000,2.50000`
- **Rückkehr**: `INFO: Ihr Patient ist gerade in seine Kontrollzone zurueckgekehrt. 10:12 https://maps.google.com/?q=48.85660,2.35220`
- **Test**: `TEST: Die SMS-Alarme der Ueberwachung funktionieren. 10:04`

Der Google-Maps-Link öffnet die Karte an der Position des Patienten. Beide SMS (Austritt und Rückkehr) sind in der Seite standardmäßig aktiviert (Kästchen „SMS-Alarme“).

Um die Person zu benennen, setzen Sie z. B. `PATIENT_LABEL=Ihr Patient Marie` in `tools/sms-proxy.env` (Umlaute werden automatisch umgeschrieben) und starten den Proxy neu. Der Text wird vom Proxy zusammengesetzt: Die Seite kann ihn nicht ändern.

## Getestete Länder
- **Kamerun**: Beim Test von Vonage abgelehnt (Code 24, „Länderregel von Fraud Defender“, Netz Orange Kamerun). Das Land muss im Dashboard erlaubt werden (Fraud Defender > Country Management, oder eine „Allow“-Regel in Traffic Rules für die Vorwahl 237).
- **Deutschland**: Die Vonage-Seite zu Deutschland nennt alphanumerische Absender als unterstützt, und Anleitungen Dritter geben an, dass keine Registrierung nötig ist. Deutsche Netzbetreiber filtern den Inhalt von SMS jedoch streng, sodass eine Nachricht auch ohne Registrierung blockiert werden kann. Nicht getestet: durch einen Versuch zu bestätigen.

## Fehlersuche
| Symptom | Wahrscheinliche Ursache | Maßnahme |
|---|---|---|
| „Proxy offline“ in der Seite | Der Proxy läuft nicht, oder es wird ein anderer Port benutzt. | `node tools/sms-proxy.js` starten; `SMS_PROXY_URL` in `web/config.js` und `SMS_PROXY_PORT` in `sms-proxy.env` prüfen. |
| „TESTMODUS“, obwohl Sie Ihre Schlüssel eingetragen haben | Schlüssel, Geheimnis oder `SMS_TO` leer, oder `SMS_DRY_RUN=1`. Die Datei muss `sms-proxy.env` heißen und in `tools/` liegen. | Datei korrigieren und den Proxy neu starten. |
| „SMS nicht gesendet (HTTP 502)“ mit einem Vonage-Detail | Vonage hat die Anfrage abgelehnt. | Das Detail im Protokoll lesen. Ein Zugangsdatenfehler (401) weist auf einen falschen Schlüssel oder ein falsches Geheimnis hin. |
| „Angenommen“ im Protokoll, aber die SMS kommt nicht an | „Angenommen“ heißt nur, dass Vonage die Nachricht übernommen hat; sie kann danach noch abgelehnt werden. | Unter die Test-Schaltfläche schauen: 15 s nach jedem Versand zeigt die Seite das tatsächliche Zustellergebnis. |
| Code 24: „Länderregel von Fraud Defender“ | Vonage sperrt dieses Zielland in Ihrem Konto. | Vonage-Dashboard > Fraud Defender > Country Management: das Land für SMS erlauben (oder eine „Allow“-Regel in Traffic Rules für die Vorwahl). Die genauen Bezeichnungen können abweichen. |
| Ablehnung wegen einer nicht erlaubten Nummer (die alte SMS-API nennt sie „Non White-listed Destination“, Code 29) | Testkonto: Der Empfänger ist keine verifizierte Nummer. | Die Nummer in der Liste der Testnummern des Dashboards hinzufügen, oder Guthaben aufladen. |
| Ablehnung wegen des Absenders (Code 51) | `SMS_FROM` für dieses Land nicht akzeptiert. | Eine Vonage-Nummer verwenden oder die alphanumerische Kennung registrieren lassen. |
| „zu kurz nacheinander“ oder „Tageslimit erreicht“ (429) | Schutzmaßnahmen des Proxys. | Warten, oder `MIN_INTERVAL_SECONDS` / `DAILY_MAX` anpassen. |
| Keine SMS im Demo-Modus | Gewollt: Im Demo-Modus werden SMS simuliert. | Den Demo-Modus abschalten oder die Schaltfläche „Test-SMS senden“ nutzen. |

## Bekannte Grenzen
- **Offene Seite zwingend**: Die SMS geht von der Seite aus; öffnet niemand die Seite, wird nichts gesendet. Für SMS rund um die Uhr müsste der Server die Uplinks von The Things Stack selbst empfangen (Webhook) und die Zonenberechnung wiederholen: ein eigenes Vorhaben.
- **Ratenlimits von Vonage**: keine offizielle Zahl gefunden; nur die Fehlercodes bei Überlastung sind dokumentiert.
- **Personenbezogene Daten**: Die Position des Sensors wird per SMS gesendet, also an Vonage und die Netzbetreiber. Vor einem Einsatz bei Personen oder Fahrzeugen zu entscheiden.

Quellen: [Messages API](https://developer.vonage.com/en/api/messages), [SMS API](https://developer.vonage.com/en/api/sms), [Zustellcodes](https://developer.vonage.com/en/messaging/sms/guides/delivery-receipts), [Absender-ID](https://developer.vonage.com/en/messaging/sms/guides/custom-sender-id), [SMS in Deutschland](https://api.support.vonage.com/hc/en-us/articles/212871228-Germany-SMS-Features-and-Restrictions).
