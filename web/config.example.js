/**
 * VORLAGE für die Konfiguration der Seite. Enthält keine Geheimnisse.
 *
 * Die echte Datei heißt web/config.js: Sie wird vom Assistenten („node setup.js“) erstellt, der den Block
 * „AUSZUFÜLLEN“ weiter unten ausfüllt. Sie ist von git ausgeschlossen und darf nie weitergegeben werden.
 *
 * ⚠ SICHERHEIT: Der API-Schlüssel in web/config.js ist für jeden LESBAR, der die Seite öffnet (Quelltext).
 *   Nur für den LOKALEN Gebrauch auf Ihrem Computer. Veröffentlichen Sie die Seite nicht im Internet.
 *   Widerrufen Sie den Schlüssel nach der Vorführung (Konsole The Things Stack > API keys).
 */

// ===================== AUSZUFÜLLEN (der Assistent „node setup.js“ erledigt das für Sie) =====================
const TTI_HOST = "team-global.eu1.cloud.thethings.industries";   // Adresse Ihres The-Things-Stack-Bereichs
const TTI_TENANT = "team-global";                                // Name des Bereichs (Tenant)
const APP_ID = "myfirst1";                                       // Anwendung
const DEVICE_ID = "heltec-gps-01";                               // Gerät (Device)
const WEBHOOK_ID = "geofence-web";                               // für den Downlink angelegter Webhook
const API_KEY = "TA-CLE-API";                                    // API-Schlüssel: geheim, niemals weitergeben
const SMS_PROXY_PORT = 3001;                                     // Port des kleinen Programms für den SMS-Versand
// =========================================================================================================

window.CONFIG = {
  // Empfang der Positionen: HTTP-Ereignisstrom von The Things Stack (funktioniert in einem Browser).
  RECEIVE_MODE: "events",

  // Modus „mqtt“ (nicht empfohlen: Die MQTT-Ports der Plattform bieten kein WebSocket).
  MQTT_WS_URLS: [
    "wss://" + TTI_HOST + ":8883/mqtt",
    "wss://" + TTI_HOST + ":443/mqtt"
  ],
  MQTT_USER: APP_ID + "@" + TTI_TENANT,

  API_KEY: API_KEY,
  APP_ID: APP_ID,
  DEVICE_ID: DEVICE_ID,
  WEBHOOK_ID: WEBHOOK_ID,

  // HTTP-Downlink-URL (benötigt den in der Konsole angelegten Webhook WEBHOOK_ID)
  DOWNLINK_URL: "https://" + TTI_HOST + "/api/v3/as/applications/" + APP_ID + "/webhooks/" + WEBHOOK_ID + "/devices/" + DEVICE_ID + "/down/push",

  // Kleines lokales Programm für den SMS-Versand (tools/sms-proxy.js). Das Geheimnis des SMS-Anbieters und die
  // Nummern bleiben in diesem Programm, nie in dieser Seite. Leer lassen (""), um SMS zu deaktivieren.
  SMS_PROXY_URL: "http://localhost:" + SMS_PROXY_PORT,

  // Kartenhintergrund (OpenStreetMap-Daten). Standard: Esri World Street Map, ohne Schlüssel.
  // Zeigen die Kacheln „403 Access blocked“, wechseln Sie unten den Anbieter und laden die Seite neu (Strg+F5):
  //  - OpenStreetMap Frankreich: "https://{s}.tile.openstreetmap.fr/osmfr/{z}/{x}/{y}.png" (TILE_SUBDOMAINS: "abc")
  //  - Offizieller OSM-Server: "https://tile.openstreetmap.org/{z}/{x}/{y}.png" (TILE_SUBDOMAINS: "")
  TILE_URL: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
  TILE_SUBDOMAINS: "",
  TILE_ATTRIBUTION: "Kacheln &copy; Esri, HERE, Garmin, OpenStreetMap contributors",

  // Kartenmitte, wenn keine Zone definiert ist
  DEFAULT_CENTER: [48.8566, 2.3522],

  // Überwachte Zone: GPS-Punkte [Breitengrad, Längengrad] (mindestens 3: Dreieck; 4: Viereck; 5: Fünfeck …).
  // Die Punkte werden automatisch ohne Überkreuzung verbunden. Eine in der Seite geänderte Zone wird im
  // Browser gespeichert und hat Vorrang vor diesem Wert; die Schaltfläche „Standardzone“ stellt ihn wieder her.
  // Beispiel: unregelmäßiges Sechseck von etwa 1 km um das Zentrum von Paris.
  DEFAULT_ZONE: [
    [48.8612, 2.3468],
    [48.8628, 2.3563],
    [48.8583, 2.3631],
    [48.8518, 2.3596],
    [48.8503, 2.3502],
    [48.8546, 2.3436]
  ]
};
