# Konfiguration von The Things Industries (Schritt 2)

Konsole: `https://team-global.eu1.cloud.thethings.industries/console` (Cluster eu1, Tenant team-global).

> **Unsicherheit**: Die Menübezeichnungen unten entsprechen der Konsole von The Things Stack v3, wie ich sie kenne; sie können in Ihrer Version leicht abweichen. Passt eine Bezeichnung nicht, suchen Sie die ähnlichste und geben Sie mir Bescheid.

## a. Gerät heltec-gps-01 anlegen
1. **Applications** > **myfirst1** > **End devices** > **+ Register end device**.
2. **Enter end device specifics manually** wählen.
3. **Frequency plan**: *Europe 863-870 MHz (SF9 for RX2 - recommended)*; **LoRaWAN version**: *LoRaWAN Specification 1.0.3*; **Regional Parameters version**: *RP001 Regional Parameters 1.0.3 revision A*.
4. **Activation mode**: *Over the air activation (OTAA)*.
5. **JoinEUI**: `0000000000000000`. **DevEUI** und **AppKey**: Schaltfläche **Generate**.
6. **End device ID**: `heltec-gps-01` > **Register end device**.
Das Gerät sendet nie: Es hat weder Hardware noch einen echten Beitritt, die Uplinks werden simuliert.

## b. Formatter in das Gerät einfügen
1. Im Gerät: Tab **Payload formatters**.
2. Unter-Tab **Uplink**: *Formatter type* = **Custom Javascript formatter**, `ttn/uplink_decoder.js` einfügen, **Save changes**.
3. Unter-Tab **Downlink**: *Formatter type* = **Custom Javascript formatter**, `ttn/downlink_encoder.js` einfügen, **Save changes**.
4. Test (Bereich *Test decoder* unter dem Uplink-Formatter), FPort `1`:

| Hex | Erwartetes Ergebnis |
|---|---|
| `1D1EECF00166EAD0` | `{ "lat": 48.8566, "lng": 2.3522 }` |
| `EBD00800D5E0B878` | `{ "lat": -33.8688, "lng": -70.6693 }` |

Für den Downlink: Eingabe `{ "alert": true }` > Bytes `[1]`, FPort 2; `{ "alert": false }` > `[0]`.

## c. API-Schlüssel (minimale Rechte)
1. **Applications** > **myfirst1** > **API keys** > **+ Add API key**.
2. Name: `geofence-web`. Ablauf: nach Ihrem Ermessen (für eine Vorführung wird ein nahes Datum empfohlen).
3. „Grant all current and future rights“ nicht anhaken. Nur anhaken:
   - **Read application traffic (uplink and downlink)**: Lesen über MQTT;
   - **Write downlink application traffic**: Senden der Downlinks;
   - **Write uplink application traffic**: dient „Simulate uplink“ (angefordertes Recht; ich bin nicht sicher, ob die Konsole es für den Simulator verlangt, da sie Ihre Sitzung nutzt. Es ist nötig, wenn die Simulation über die API mit diesem Schlüssel erfolgt, wie bei `tools/simulate.html` und `tools/sensor.html`).
4. **Create API key** und den Schlüssel sofort kopieren: Er wird nicht mehr angezeigt. Schreiben Sie ihn nie in den Code (nur `TA-CLE-API`).

## d. Webhook geofence-web (um die Downlink-URL zu aktivieren)
1. **Applications** > **myfirst1** > **Integrations** > **Webhooks** > **+ Add webhook**.
2. **Custom webhook** wählen.
3. **Webhook ID**: `geofence-web`; **Webhook format**: *JSON*.
4. **Base URL**: eine Platzhalter-URL, z. B. `https://example.invalid` (es wird nichts wirklich gesendet, da keine Nachricht erfolgreich zugestellt wird; Sendefehler können in Live data erscheinen, das ist folgenlos).
5. Die Kästchen für Nachrichtentypen möglichst unangehakt lassen; sonst nur **Uplink message** anhaken. Ich weiß nicht, ob die Konsole null Typen erlaubt: zu prüfen.
6. **Add webhook**. Die Downlink-URL existiert erst, wenn dieser Webhook angelegt ist.

## e. Zu notierende Werte
| Element | Wert |
|---|---|
| Host | `team-global.eu1.cloud.thethings.industries` |
| MQTT-Benutzer | `myfirst1@team-global` |
| MQTT-Passwort | der unter (c) angelegte API-Schlüssel |
| Uplink-Topic | `v3/myfirst1@team-global/devices/heltec-gps-01/up` |
| Downlink-URL (POST) | `https://team-global.eu1.cloud.thethings.industries/api/v3/as/applications/myfirst1/webhooks/geofence-web/devices/heltec-gps-01/down/push` |
| Downlink-Header | `Authorization: Bearer TA-CLE-API` |

Inhalt des Downlinks: `{"downlinks":[{"f_port":2,"decoded_payload":{"alert":true},"priority":"NORMAL"}]}`.

Aktualisierung nach Prüfung: Der MQTT-Broker bietet auf den Ports 8883 und 443 kein WebSocket (getestet), daher empfängt die Seite die Uplinks über den HTTP-Ereignisstrom (`POST /api/v3/events`). Die HTTP-API antwortet mit `access-control-allow-origin: *` (Test ohne Schlüssel). Siehe [TESTANLEITUNG.md](TESTANLEITUNG.md).
