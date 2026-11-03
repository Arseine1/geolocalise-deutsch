/**
 * GPS-Gerät für Geofencing – Heltec WiFi LoRa 32 V3 (SX1262) + GPS NEO-6M
 * LoRaWAN OTAA EU868 vers The Things Stack (device heltec-gps-01).
 *
 * ⚠ AUF HARDWARE NICHT GETESTETER CODE: geschrieben für den Tag, an dem die Platine verfügbar ist.
 *   Syntaxprüfung und RadioLib-Signaturen wurden am Quellcode von RadioLib 7.8.1 geprüft,
 *   aber nichts wurde auf einer echten Platine kompiliert oder ausgeführt. Siehe firmware/README.md.
 *
 * Fonctionnement :
 *  - UPLINK auf FPort 1, alle 30 s, NUR wenn das GPS einen gültigen Fix hat.
 *    Rahmen von 8 Byte: Breitengrad x 1e7 (vorzeichenbehaftetes int32, Big-Endian), dann Längengrad x 1e7 (ebenso).
 *    Das ist genau das von ttn/uplink_decoder.js erwartete Format.
 *  - DOWNLINK auf FPort 2: 0x01 = LED blinkt, 0x00 = LED aus.
 *    (Bei LoRaWAN Klasse A wird ein Downlink erst nach einem Uplink empfangen: höchstens 30 s Verzögerung.)
 *
 * SPRACHNACHRICHTEN (hinzugefügter Abschnitt, siehe docs/SPRACHNACHRICHTEN.md):
 *  ⚠ DIESER ABSCHNITT WURDE NIE KOMPILIERT ODER AUSPROBIERT: Er setzt Hardware voraus (I2S-Mikrofon INMP441, Verstärker
 *    I2S MAX98357A, Lautsprecher, Taste), die ich nicht habe. Die Namen der ESP_I2S-API (arduino-esp32 3.x) sind aus dem
 *    Gedächtnis geschrieben und können beim Kompilieren Korrekturen erfordern. Als Ausgangspunkt behandeln.
 *  - LoRaWAN transportiert keine Stimme: Das Audio läuft per HTTP über das WLAN zum Sprach-Relay des PCs.
 *  - ZUR SEITE: Taste gehalten = Aufnahme von höchstens 10 s, WAV 8 kHz 16 Bit mono, im Strom (chunked) gesendet
 *    an das Relay über das WLAN, ohne die Nachricht je im Speicher zu behalten (kein PSRAM auf dem Heltec V3).
 *  - VON DER SEITE: TEXT, per LoRaWAN. DOWNLINK auf FPort 4 = [Nummer (1 Byte)] + UTF-8-Text (höchstens 49 Byte).
 *    Das Gerät spricht diesen Text laut aus: Es lädt die Sprachsynthese vom Relay herunter (WLAN, GET /api/voice/tts), spielt sie ab
 *    und bestätigt das Vorlesen mit einem UPLINK von 1 Byte (der Nummer) auf FPort 3. Die Stimme läuft nie über LoRaWAN.
 *  - Positions-Uplinks werden während eines Sprachaustauschs (einige Sekunden) ausgesetzt.
 *
 * Testmodus: Entfernen Sie den Kommentar bei TEST_OHNE_GPS, um Positionen ohne GPS-Modul zu simulieren.
 */

#include <RadioLib.h>
#include <TinyGPSPlus.h>

// Sprachnachrichten: Machen Sie diese Zeile zum Kommentar, um das ursprüngliche Verhalten ohne WLAN und Audio zu erhalten
// (und ohne secrets.h zu benötigen).
#define SPRACHNACHRICHTEN

#ifdef SPRACHNACHRICHTEN
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESP_I2S.h>
#if __has_include("secrets.h")
#include "secrets.h"   // WIFI_SSID, WIFI_PASSWORD, RELAY_HOST, RELAY_PORT, VOICE_TOKEN, VOICE_DEVICE_ID
#else
#error "secrets.h fehlt: Kopieren Sie secrets.example.h nach secrets.h und füllen Sie sie aus (siehe firmware/README.md)."
#endif
#endif

// ============================================================================
// CONFIGURATION
// ============================================================================

// Kommentar entfernen, um die Platine OHNE GPS-Modul zu testen: simulierte Positionen (hin und zurück aus dem Kreis).
// #define TEST_OHNE_GPS

// --- OTAA-Zugangsdaten: aus der Konsole übernehmen (End device > Overview) -----------------
// Diese Werte nie veröffentlichen. JoinEUI: 0000000000000000 wie in docs/CONFIG_TTI.md.
// Die Nullen unten sind Platzhalter: durch die Werte Ihres Geräts ersetzen.
static const uint64_t JOIN_EUI = 0x0000000000000000ULL;
static const uint64_t DEV_EUI  = 0x0000000000000000ULL;   // DevEUI des Geräts (MSB-Anzeige der Konsole)
// AppKey (MSB). Bei LoRaWAN 1.0.x dient derselbe Schlüssel als NwkKey: Wir übergeben ihn daher zweimal.
static const uint8_t APP_KEY[16] = {
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00
};

// --- Pins des Heltec WiFi LoRa 32 V3 (aus der Variante arduino-esp32 "heltec_wifi_lora_32_V3" entnommen) ---
static const int8_t LORA_NSS   = 8;
static const int8_t LORA_DIO1  = 14;   // in der Variante DIO0 genannt, es ist der DIO1 des SX1262
static const int8_t LORA_RST   = 12;
static const int8_t LORA_BUSY  = 13;
static const int8_t LORA_SCK   = 9;
static const int8_t LORA_MISO  = 11;
static const int8_t LORA_MOSI  = 10;
static const int8_t LED_PIN    = 35;   // weiße LED der Platine

// GPS NEO-6M an Serial2. Diese beiden Pins sind eine WAHL, die Sie am Pinout Ihrer Platine prüfen müssen (am Stecker frei):
//  - GPS_RX_PIN: Pin der Platine, der mit dem TX des GPS verbunden ist
//  - GPS_TX_PIN: Pin der Platine, der mit dem RX des GPS verbunden ist
static const int8_t GPS_RX_PIN = 5;
static const int8_t GPS_TX_PIN = 4;
static const uint32_t GPS_BAUD = 9600;   // Standardgeschwindigkeit des NEO-6M

// Spannung des TCXO des SX1262 auf dem Heltec V3. Wert 1,8 V in der Heltec-Dokumentation bestätigen;
// initialisiert sich das Funkmodul nicht (Fehler -706 oder ähnlich), versuchen Sie 1,6, dann 3,0.
static const float TCXO_VOLTAGE = 1.8f;

#ifdef SPRACHNACHRICHTEN
// --- Audio: GEWÄHLTE Pins (nicht vorgegeben) unter denen, die ich auf dem Heltec V3 für frei halte. Am
//     Pinout Ihrer Platine prüfen (siehe firmware/README.md) und hier bei Bedarf ändern. ---
// I2S-Mikrofon INMP441: SCK/BCLK, WS/LRCLK, SD/DOUT des Mikrofons. Das Mikrofon liegt auf dem linken Kanal (L/R mit GND verbunden).
static const int8_t MIC_BCLK_PIN = 6;
static const int8_t MIC_WS_PIN   = 7;
static const int8_t MIC_DIN_PIN  = 2;
// Amplificateur I2S MAX98357A : BCLK, LRC, DIN
static const int8_t SPK_BCLK_PIN = 38;
static const int8_t SPK_LRC_PIN  = 39;
static const int8_t SPK_DIN_PIN  = 40;
// Taster „sprechen“ zwischen diesem Pin und GND (interner Pull-up-Widerstand aktiviert)
static const int8_t TASTE_PIN   = 41;

static const uint32_t STIMME_AUFNAHME_MAX_MS = 10UL * 1000UL;   // 10 s au maximum par message
static const uint32_t STIMME_AUFNAHME_MIN_MS = 500;             // darunter: versehentliches Drücken, nichts wird gesendet
static const uint32_t STIMME_FREQ_MIKRO            = 16000;           // das Mikrofon tastet mit 16 kHz ab ...
static const uint32_t STIMME_FREQ_WAV              = 8000;            // ... dann wird paarweise gemittelt: WAV mit 8 kHz
static const int      STIMME_MIKRO_VERSCHIEBUNG   = 14;              // INMP441: 24 Bit in 32; >> 14 ergibt einen brauchbaren Pegel (anpassen)
static const uint32_t WIFI_WARTEZEIT_MS              = 15000;           // Abbruch des WLAN-Verbindungsaufbaus nach 15 s
static const uint32_t HTTP_TIMEOUT_MS              = 8000;
#endif

// --- Temporisations ---
static const uint32_t SENDEINTERVALL_MS = 30UL * 1000UL;   // ein Uplink alle 30 s
static const uint32_t JOIN_WARTEZEIT_MS  = 30UL * 1000UL;   // nouvel essai de jointure
static const uint32_t BLINK_MS     = 300;             // halbe Periode des LED-Blinkens
static const uint32_t FIX_ALTER_MAX_MS      = 5000;            // ein Fix, der älter als 5 s ist, wird abgelehnt

// --- Simulierte Positionen (Modus TEST_OHNE_GPS): gleiche Werte wie in web/config.js ---
#ifdef TEST_OHNE_GPS
static const double TEST_LAT_MITTE = 48.8566;
static const double TEST_LNG_MITTE = 2.3522;
static const double TEST_RADIUS_M    = 500.0;
#endif

// ============================================================================
// OBJETS
// ============================================================================

SX1262 radio = new Module(LORA_NSS, LORA_DIO1, LORA_RST, LORA_BUSY);
const LoRaWANBand_t Region = EU868;
LoRaWANNode node(&radio, &Region, 0);   // 0 = kein Unterband (in EU868 ungenutzt)

TinyGPSPlus gps;

#ifdef SPRACHNACHRICHTEN
I2SClass i2sMikrofon;     // Eingang: Mikrofon INMP441
I2SClass i2sLautsprecher;   // Ausgang: Verstärker MAX98357A
#endif

// ============================================================================
// ÉTAT
// ============================================================================

static bool     ledBlinkt   = false;   // per Downlink gesteuert
static bool     ledZustand       = false;
static uint32_t ledLetzterWechsel = 0;
static uint32_t naechsterVersand = 0;       // Zeitpunkt (millis) des nächsten Uplinks
static uint32_t letzteMeldungOhneFix = 0;
static uint8_t  testSchritt     = 0;       // Fortschritt der simulierten Strecke
#ifdef SPRACHNACHRICHTEN
static bool     textWartet   = false;   // Text-Downlink empfangen (Port 4): laut auszusprechen
static char     empfangenerText[64];              // der Text (höchstens 49 Byte, plus ein Endbyte)
static uint8_t  textNummer         = 0;       // Nummer der Nachricht, in der Bestätigung zurückgegeben
static uint8_t  textVersuche      = 0;       // bereits unternommene Versuche für diesen Text
static uint8_t  bestaetigungOffen     = 0;       // per Uplink zu bestätigende Nummer (Port 3); 0 = nichts zu senden
static bool     sprachnachrichtWartet    = false;   // Downlink Port 5 empfangen: Eine Sprachnachricht der Seite wartet auf dem Relay
static uint32_t naechsterWifiVersuch = 0;      // Zeitpunkt (millis) des nächsten WLAN-Verbindungsversuchs
#endif

// ============================================================================
// OUTILS
// ============================================================================

/** Schreibt eine vorzeichenbehaftete 32-Bit-Ganzzahl als Big-Endian nach out[0..3]. */
static void schreibeInt32BE(uint8_t* out, int32_t v) {
  uint32_t u = (uint32_t)v;
  out[0] = (uint8_t)(u >> 24);
  out[1] = (uint8_t)(u >> 16);
  out[2] = (uint8_t)(u >> 8);
  out[3] = (uint8_t)(u);
}

/** Baut den Rahmen von 8 Byte: lat x 1e7, dann lng x 1e7. */
static void baueRahmen(double lat, double lng, uint8_t* rahmen) {
  schreibeInt32BE(rahmen,     (int32_t)lround(lat * 1e7));
  schreibeInt32BE(rahmen + 4, (int32_t)lround(lng * 1e7));
}

/** Steuert die LED: aus, oder blinkend, ohne das Programm zu blockieren. */
static void ledAktualisieren() {
  if (!ledBlinkt) {
    if (ledZustand) { ledZustand = false; digitalWrite(LED_PIN, LOW); }
    return;
  }
  uint32_t now = millis();
  if (now - ledLetzterWechsel >= BLINK_MS) {
    ledLetzterWechsel = now;
    ledZustand = !ledZustand;
    digitalWrite(LED_PIN, ledZustand ? HIGH : LOW);
  }
}

/** Füttert TinyGPSPlus mit den vom GPS-Modul empfangenen Zeichen. */
static void gpsLesen() {
#ifndef TEST_OHNE_GPS
  while (Serial2.available() > 0) {
    gps.encode(Serial2.read());
  }
#endif
}

/**
 * Liefert die zu sendende Position. Gibt false zurück, wenn es keinen gültigen Fix gibt (dann wird nichts gesendet).
 * Im Modus TEST_OHNE_GPS: simulierte Strecke nach Osten bis 2,5 x Radius, dann zurück.
 */
static bool positionHolen(double* lat, double* lng) {
#ifdef TEST_OHNE_GPS
  // 20 Schritte: 0..10 hin, 9..1 zurück (Entfernung = Radius x 2,5 x Schritt/10)
  uint8_t i = testSchritt % 20;
  uint8_t schritt = (i <= 10) ? i : (20 - i);
  double dist = TEST_RADIUS_M * 2.5 * schritt / 10.0;
  *lat = TEST_LAT_MITTE;
  *lng = TEST_LNG_MITTE + dist / (111320.0 * cos(TEST_LAT_MITTE * PI / 180.0));
  testSchritt++;
  return true;
#else
  if (!gps.location.isValid() || gps.location.age() > FIX_ALTER_MAX_MS) {
    return false;
  }
  *lat = gps.location.lat();
  *lng = gps.location.lng();
  return true;
#endif
}

/** Gibt einen RadioLib-Statuscode (Zahl) zur Diagnose aus. */
static void zustandAusgeben(const char* kontext, int16_t funkStatus) {
  Serial.print(kontext);
  Serial.print(" - RadioLib-Code ");
  Serial.println(funkStatus);
}

/** Tritt dem Netz bei (OTAA); versucht es bei Misserfolg unbegrenzt alle 30 s erneut. */
static void netzBeitreten() {
  int16_t funkStatus = node.beginOTAA(JOIN_EUI, DEV_EUI, APP_KEY, APP_KEY);   // NwkKey = AppKey (LoRaWAN 1.0.x)
  if (funkStatus != RADIOLIB_ERR_NONE) {
    zustandAusgeben("OTAA-Initialisierung nicht möglich (Zugangsdaten?)", funkStatus);
    while (true) { delay(1000); }   // Konfigurationsfehler: Erneutes Versuchen ist sinnlos
  }
  while (true) {
    Serial.println(F("OTAA-Beitritt läuft ..."));
    funkStatus = node.activateOTAA();
    if (funkStatus == RADIOLIB_LORAWAN_NEW_SESSION) {
      Serial.println(F("Beitritt erfolgreich."));
      return;
    }
    zustandAusgeben("Beitritt fehlgeschlagen (kein Gateway in Reichweite?), neuer Versuch in 30 s", funkStatus);
    delay(JOIN_WARTEZEIT_MS);
  }
}

// ============================================================================
// SPRACHNACHRICHTEN (WLAN + Sprach-Relay des PCs) – AUF HARDWARE NICHT GETESTET
// ============================================================================
#ifdef SPRACHNACHRICHTEN

static const int STIMME_LAUTSTAERKE_PROZENT = 60;   // Wiedergabelautstärke (0 bis 100)

/** Hält das WLAN verbunden, ohne zu blockieren: ein Versuch alle 30 s, solange es getrennt ist. */
static void wifiPflegen() {
  if (WiFi.status() == WL_CONNECTED) return;
  if ((int32_t)(millis() - naechsterWifiVersuch) < 0) return;
  naechsterWifiVersuch = millis() + 30000UL;
  Serial.println(F("WLAN: Verbindung wird aufgebaut ..."));
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

/** WAV-Kopf von 44 Byte (PCM 16 Bit mono 8 kHz). Die Größen sind Platzhalter: Der Strom hat keine im Voraus bekannte Größe, das Relay schreibt die echten. */
static void schreibeWavKopf(uint8_t* h) {
  const uint32_t datenrate = STIMME_FREQ_WAV * 2;   // octets par seconde
  memcpy(h, "RIFF", 4);  memset(h + 4, 0xFF, 4);  memcpy(h + 8, "WAVE", 4);
  memcpy(h + 12, "fmt ", 4);
  h[16] = 16; h[17] = 0; h[18] = 0; h[19] = 0;            // Größe des fmt-Blocks
  h[20] = 1;  h[21] = 0;                                  // PCM
  h[22] = 1;  h[23] = 0;                                  // mono
  h[24] = STIMME_FREQ_WAV & 0xFF; h[25] = (STIMME_FREQ_WAV >> 8) & 0xFF; h[26] = 0; h[27] = 0;
  h[28] = datenrate & 0xFF; h[29] = (datenrate >> 8) & 0xFF; h[30] = (datenrate >> 16) & 0xFF; h[31] = 0;
  h[32] = 2;  h[33] = 0;                                  // Byte pro Sample
  h[34] = 16; h[35] = 0;                                  // Bit pro Sample
  memcpy(h + 36, "data", 4);  memset(h + 40, 0xFF, 4);
}

/** Sendet ein Stück („Chunk“) einer HTTP-Anfrage mit Transfer-Encoding: chunked. */
static void sendeChunk(WiFiClient& client, const uint8_t* data, size_t n) {
  char groesse[12];
  int l = snprintf(groesse, sizeof(groesse), "%X\r\n", (unsigned)n);
  client.write((const uint8_t*)groesse, l);
  client.write(data, n);
  client.write((const uint8_t*)"\r\n", 2);
}

/** Fügt einer HTTPClient-Anfrage die gemeinsamen Header (Token des Geräts) hinzu. Das Token wird nie auf der seriellen Verbindung ausgegeben. */
static void relayKopfzeilen(HTTPClient& http) {
  http.addHeader("X-Voice-Token", VOICE_TOKEN);
  http.addHeader("X-From", "device");
  http.addHeader("X-Device-Id", VOICE_DEVICE_ID);
  http.setTimeout(HTTP_TIMEOUT_MS);
}
static String relayUrl(const String& pfad) {
  return String("http://") + RELAY_HOST + ":" + String(RELAY_PORT) + pfad;
}

/**
 * Taste gehalten: nimmt bis zu 10 s auf und sendet FORTLAUFEND (HTTP chunked): nur wenige hundert
 * Byte liegen gleichzeitig im Speicher (kein PSRAM auf dem Heltec V3). Zu kurzes Drücken: Die Verbindung wird getrennt,
 * ohne die Anfrage abzuschließen; das Relay speichert nichts.
 */
static void aufnehmenUndSenden() {
  Serial.println(F("Taste: Aufnahme einer Sprachnachricht ..."));
  if (!i2sMikrofon.begin(I2S_MODE_STD, STIMME_FREQ_MIKRO, I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT)) {
    Serial.println(F("I2S-Mikrofon: Initialisierung nicht möglich (Pins?)."));
    return;
  }
  WiFiClient client;
  if (!client.connect(RELAY_HOST, RELAY_PORT, HTTP_TIMEOUT_MS)) {
    Serial.println(F("Sprach-Relay nicht erreichbar (Adresse, VOICE_LAN=1, Firewall?)."));
    i2sMikrofon.end();
    return;
  }
  client.print(F("POST /api/voice HTTP/1.1\r\nHost: "));
  client.print(RELAY_HOST);
  client.print(F("\r\nContent-Type: audio/wav\r\nTransfer-Encoding: chunked\r\nConnection: close\r\nX-From: device\r\nX-Device-Id: "));
  client.print(VOICE_DEVICE_ID);
  client.print(F("\r\nX-Voice-Token: "));
  client.print(VOICE_TOKEN);
  client.print(F("\r\n\r\n"));

  uint8_t kopf[44];
  schreibeWavKopf(kopf);
  sendeChunk(client, kopf, sizeof(kopf));

  static int32_t roh[256];     // 256 32-Bit-Samples des Mikrofons (1 KB)
  static int16_t pcm[128];      // 128 16-Bit-Samples bei 8 kHz
  uint32_t anfang = millis();
  while (digitalRead(TASTE_PIN) == LOW && millis() - anfang < STIMME_AUFNAHME_MAX_MS) {
    size_t gelesen = i2sMikrofon.readBytes((char*)roh, sizeof(roh));
    size_t n = gelesen / 4;
    size_t ausgaben = 0;
    for (size_t i = 0; i + 1 < n; i += 2) {
      // Mittelwert zweier Samples bei 16 kHz = ein Sample bei 8 kHz (grober Filter gegen Spiegelfrequenzen)
      int32_t m = ((roh[i] >> STIMME_MIKRO_VERSCHIEBUNG) + (roh[i + 1] >> STIMME_MIKRO_VERSCHIEBUNG)) / 2;
      if (m > 32767) m = 32767;
      if (m < -32768) m = -32768;
      pcm[ausgaben++] = (int16_t)m;
    }
    if (ausgaben > 0) sendeChunk(client, (const uint8_t*)pcm, ausgaben * 2);
    gpsLesen();   // hält den seriellen Puffer des GPS während der Aufnahme leer
  }
  uint32_t dauer = millis() - anfang;
  i2sMikrofon.end();

  if (dauer < STIMME_AUFNAHME_MIN_MS) {
    client.stop();   // Anfrage nicht abgeschlossen: Auf dem Relay wird nichts gespeichert
    Serial.println(F("Zu kurz gedrückt: Nachricht ignoriert."));
    return;
  }
  client.print(F("0\r\n\r\n"));   // Ende des Stroms

  // Antwort des Relays: „HTTP/1.1 200 ...“, wenn die Nachricht gespeichert ist
  uint32_t t0 = millis();
  while (!client.available() && client.connected() && millis() - t0 < HTTP_TIMEOUT_MS) delay(10);
  String zeile = client.readStringUntil('\n');
  client.stop();
  if (zeile.indexOf(" 200") > 0) Serial.println(F("Sprachnachricht an das Relay gesendet."));
  else { Serial.print(F("Relay: abgelehnt oder Fehler: ")); Serial.println(zeile); }
}

/** Kodiert einen Text für eine Webadresse (%XX für alles, was kein ASCII-Buchstabe oder keine ASCII-Ziffer ist). */
static String urlKodieren(const char* text) {
  String s;
  const char* hex = "0123456789ABCDEF";
  for (const uint8_t* p = (const uint8_t*)text; *p; p++) {
    if (isalnum(*p)) s += (char)*p;
    else { s += '%'; s += hex[*p >> 4]; s += hex[*p & 15]; }
  }
  return s;
}

/**
 * Spricht den empfangenen Text: Das Relay des PCs wandelt ihn in ein WAV 8 kHz um (lokale Sprachsynthese, GET /api/voice/tts), das das Gerät
 * herunterlädt und fortlaufend abspielt. Ein ESP32-S3 ohne PSRAM kann diese Synthese nicht selbst erzeugen.
 * Gibt true zurück, wenn die Wiedergabe bis zum Ende gelaufen ist.
 */
static bool wavHttpAbspielen(HTTPClient& http);   // weiter unten definiert

static bool textSprechen(const char* text) {
  HTTPClient http;
  http.begin(relayUrl("/api/voice/tts?text=" + urlKodieren(text)));
  relayKopfzeilen(http);
  int code = http.GET();
  if (code != 200) { http.end(); Serial.print(F("Sprachsynthese: HTTP ")); Serial.println(code); return false; }
  return wavHttpAbspielen(http);
}

/** Spielt das WAV 8 kHz 16 Bit mono einer bereits geöffneten HTTP-Antwort (Code 200) fortlaufend ab und schließt dann die Anfrage. */
static bool wavHttpAbspielen(HTTPClient& http) {

  WiFiClient* strom = http.getStreamPtr();
  int verbleibend = http.getSize();   // -1, wenn die Größe unbekannt ist
  uint8_t kopf[44];
  size_t gelesen = strom->readBytes(kopf, sizeof(kopf));   // Standard-WAV-Kopf von 44 Byte (vom Relay korrigiert)
  if (gelesen != sizeof(kopf) || memcmp(kopf, "RIFF", 4) != 0) { http.end(); Serial.println(F("Empfangene Datei: ungültiger WAV-Kopf.")); return false; }
  if (verbleibend > 0) verbleibend -= sizeof(kopf);

  if (!i2sLautsprecher.begin(I2S_MODE_STD, STIMME_FREQ_WAV, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO, I2S_STD_SLOT_LEFT)) {
    http.end(); Serial.println(F("I2S-Lautsprecher: Initialisierung nicht möglich (Pins?).")); return false;
  }
  Serial.println(F("Nachricht wird abgespielt ..."));
  static uint8_t puffer[512];
  uint32_t t0 = millis();
  while (http.connected() && (verbleibend > 0 || verbleibend == -1) && millis() - t0 < 45000UL) {
    int verfuegbar = strom->available();
    if (verfuegbar <= 0) { delay(2); if (verbleibend == -1 && !http.connected()) break; continue; }
    size_t n = strom->readBytes(puffer, min((size_t)verfuegbar, sizeof(puffer)));
    n &= ~(size_t)1;   // ganze Samples
    int16_t* s = (int16_t*)puffer;
    for (size_t i = 0; i < n / 2; i++) s[i] = (int16_t)((int32_t)s[i] * STIMME_LAUTSTAERKE_PROZENT / 100);
    i2sLautsprecher.write(puffer, n);
    if (verbleibend > 0) verbleibend -= (int)n;
    gpsLesen();
  }
  i2sLautsprecher.end();
  http.end();
  return true;
}


/**
 * Sprachnachricht der Seite: Der LoRaWAN-Downlink (Port 5) hat nur benachrichtigt. Das Audio kommt per WLAN vom Relay:
 * Wir fragen die nächste ungehörte Nachricht ab (GET /api/voice/next), laden sie herunter, spielen sie ab und bestätigen dann (POST .../ack).
 * Höchstens 5 Nachrichten pro Durchgang; true, wenn die Warteschlange leer ist oder die Wiedergabe erfolgreich war.
 */
static bool seitenSprachnachrichtenAbspielen() {
  for (int runde = 0; runde < 5; runde++) {
    HTTPClient http;
    http.begin(relayUrl("/api/voice/next"));
    relayKopfzeilen(http);
    int code = http.GET();
    if (code == 204) { http.end(); return true; }   // nichts mehr anzuhören
    if (code != 200) { http.end(); Serial.print(F("Relay (nächste Sprachnachricht): HTTP ")); Serial.println(code); return false; }
    String inhalt = http.getString();
    http.end();
    int p = inhalt.indexOf("\"id\":");
    if (p < 0) { Serial.println(F("Antwort des Relays unlesbar.")); return false; }
    long id = inhalt.substring(p + 5).toInt();
    if (id <= 0) return false;

    HTTPClient audio;
    audio.begin(relayUrl("/api/voice/" + String(id) + "/audio?format=wav"));
    relayKopfzeilen(audio);
    int audioCode = audio.GET();
    if (audioCode != 200) { audio.end(); Serial.print(F("Relay (Audio): HTTP ")); Serial.println(audioCode); return false; }
    Serial.print(F("Sprachnachricht der Seite Nr. ")); Serial.println(id);
    if (!wavHttpAbspielen(audio)) return false;

    HTTPClient ack;
    ack.begin(relayUrl("/api/voice/" + String(id) + "/ack"));
    relayKopfzeilen(ack);
    int ackCode = ack.POST("");
    ack.end();
    if (ackCode != 200) { Serial.print(F("Hörbestätigung abgelehnt: HTTP ")); Serial.println(ackCode); return false; }
  }
  return true;
}

/** Bei jedem Durchlauf von loop() aufrufen: WLAN, Taste „sprechen“, wartender empfangener Text, Sprachnachrichten der Seite. */
static void sprachnachrichtenBehandeln() {
  wifiPflegen();
  if (WiFi.status() != WL_CONNECTED) return;

  if (digitalRead(TASTE_PIN) == LOW) {
    delay(30);   // anti-rebond
    if (digitalRead(TASTE_PIN) == LOW) {
      aufnehmenUndSenden();
      while (digitalRead(TASTE_PIN) == LOW) delay(10);   // wartet auf das Loslassen, bevor es weitergeht
      return;
    }
  }

  if (sprachnachrichtWartet) {
    if (seitenSprachnachrichtenAbspielen()) sprachnachrichtWartet = false;
    else delay(2000);   // kurze Pause vor dem nächsten Versuch (Relay nicht erreichbar?)
  }

  if (textWartet) {
    if (textSprechen(empfangenerText)) {
      bestaetigungOffen = textNummer;   // die Bestätigung geht im nächsten Zeitfenster als LoRaWAN-Uplink (Port 3) hinaus, siehe loop()
      textWartet = false;
    } else if (++textVersuche >= 3) {
      Serial.println(F("Text nach 3 Fehlversuchen aufgegeben (Relay nicht erreichbar?)."));
      textWartet = false;
    } else {
      delay(2000);   // kurze Pause vor dem nächsten Versuch
    }
  }
}

#endif  // SPRACHNACHRICHTEN

// ============================================================================
// SETUP / LOOP
// ============================================================================

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 3000) { delay(10); }   // wartet höchstens 3 s auf den seriellen Monitor

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

#ifdef TEST_OHNE_GPS
  Serial.println(F("MODUS TEST_OHNE_GPS: simulierte Positionen, kein GPS-Modul verwendet."));
#else
  Serial2.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.println(F("GPS an Serial2 gestartet."));
#endif

  // SPI-Bus zum SX1262, dann Initialisierung des Funkmoduls (die Frequenz stellt LoRaWAN ein)
  SPI.begin(LORA_SCK, LORA_MISO, LORA_MOSI, LORA_NSS);
  int16_t funkStatus = radio.begin(868.0, 125.0, 9, 7, RADIOLIB_SX126X_SYNC_WORD_PRIVATE, 10, 8, TCXO_VOLTAGE, false);
  if (funkStatus != RADIOLIB_ERR_NONE) {
    zustandAusgeben("Funkmodul-Initialisierung SX1262 nicht möglich", funkStatus);
    while (true) { delay(1000); }
  }

#ifdef SPRACHNACHRICHTEN
  pinMode(TASTE_PIN, INPUT_PULLUP);
  // I2S-Pins: (BCLK, WS, DOUT, DIN); -1 = nicht verwendet. Das Mikrofon hat nur DIN, der Verstärker nur DOUT.
  i2sMikrofon.setPins(MIC_BCLK_PIN, MIC_WS_PIN, -1, MIC_DIN_PIN);
  i2sLautsprecher.setPins(SPK_BCLK_PIN, SPK_LRC_PIN, SPK_DIN_PIN, -1);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // die Verbindung wird im Hintergrund aufgebaut; wifiPflegen() überwacht sie
  Serial.println(F("Sprachnachrichten aktiviert (WLAN verbindet sich)."));
#endif

  netzBeitreten();
  naechsterVersand = millis();   // erster Versand, sobald ein gültiger Fix verfügbar ist
}

void loop() {
  gpsLesen();
  ledAktualisieren();
#ifdef SPRACHNACHRICHTEN
  sprachnachrichtenBehandeln();
#endif

  // Noch nicht Zeit für den nächsten Versand
  if ((int32_t)(millis() - naechsterVersand) < 0) return;

  double lat, lng;
  if (!positionHolen(&lat, &lng)) {
    // Kein gültiger Fix: Wir senden nichts und versuchen es im nächsten Durchlauf erneut (Meldung auf 1 / 5 s begrenzt)
    if (millis() - letzteMeldungOhneFix > 5000) {
      letzteMeldungOhneFix = millis();
      Serial.print(F("Kein gültiger GPS-Fix (Satelliten: "));
      Serial.print(gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
      Serial.println(F("). Kein Versand."));
    }
    return;
  }

  uint8_t rahmen[8];
  baueRahmen(lat, lng, rahmen);
  Serial.print(F("Uplink: lat "));
  Serial.print(lat, 6);
  Serial.print(F(", lng "));
  Serial.println(lng, 6);

  uint8_t downlink[16];
  size_t downlinkGroesse = 0;
  LoRaWANEvent_t upEreignis, downEreignis;

  // FPort 1, unbestätigt; blockiert einige Sekunden lang während der Empfangsfenster
  int16_t funkStatus = node.sendReceive(rahmen, sizeof(rahmen), 1, downlink, &downlinkGroesse, false, &upEreignis, &downEreignis);

  if (funkStatus < RADIOLIB_ERR_NONE) {
    zustandAusgeben("Sendefehler", funkStatus);
  } else if (funkStatus > 0 && downlinkGroesse >= 1 && downEreignis.fPort == 2) {
    // funkStatus > 0: Downlink empfangen (Nummer des RX-Fensters)
    if (downlink[0] == 0x01) {
      ledBlinkt = true;
      Serial.println(F("Downlink 0x01: LED blinkt."));
    } else if (downlink[0] == 0x00) {
      ledBlinkt = false;
      Serial.println(F("Downlink 0x00: LED aus."));
    } else {
      Serial.print(F("Downlink ignoriert, unerwartetes Byte: "));
      Serial.println(downlink[0], HEX);
    }
  } else if (funkStatus > 0 && downlinkGroesse >= 2 && downEreignis.fPort == 4) {
    // Port 4: TEXT-Nachricht der Seite = [Nummer (1 Byte)] + UTF-8-Text. Die Stimme läuft nie über LoRaWAN:
    // Das Gerät spricht diesen Text laut aus (Sprachsynthese vom Relay, siehe sprachnachrichtenBehandeln).
#ifdef SPRACHNACHRICHTEN
    size_t n = downlinkGroesse - 1;
    if (n > sizeof(empfangenerText) - 1) n = sizeof(empfangenerText) - 1;
    memcpy(empfangenerText, downlink + 1, n);
    empfangenerText[n] = 0;
    textNummer = downlink[0];
    textWartet = true;
    textVersuche = 0;
    Serial.print(F("Text-Downlink Nr. "));
    Serial.print(textNummer);
    Serial.print(F(": "));
    Serial.println(empfangenerText);
#else
    Serial.println(F("Text-Downlink ignoriert: Sprachnachrichten im Sketch deaktiviert."));
#endif
  } else if (funkStatus > 0 && downlinkGroesse >= 1 && downEreignis.fPort == 5) {
    // Port 5: ein Byte (0x01) = „eine Sprachnachricht der Seite wartet auf dem Relay“; das Audio läuft nicht über LoRaWAN.
#ifdef SPRACHNACHRICHTEN
    sprachnachrichtWartet = true;
    Serial.println(F("Downlink Port 5: Sprachnachricht wartet auf dem Relay."));
#else
    Serial.println(F("Sprach-Downlink ignoriert: Sprachnachrichten im Sketch deaktiviert."));
#endif
  }

#ifdef SPRACHNACHRICHTEN
  // Lesebestätigung des laut gesprochenen Textes: 1 Byte (die Nummer der Nachricht) auf FPort 3, sofern die Sendezeit es erlaubt.
  // Ein während dieses Versands empfangener Downlink würde ignoriert (nicht behandelt: Die Seite sendet nur eine Nachricht pro Minute).
  if (bestaetigungOffen > 0 && node.timeUntilUplink() == 0) {
    uint8_t ack = bestaetigungOffen;
    int16_t ackStatus = node.sendReceive(&ack, 1, 3);
    if (ackStatus >= RADIOLIB_ERR_NONE) { bestaetigungOffen = 0; Serial.println(F("Lesebestätigung gesendet (Uplink Port 3).")); }
    else zustandAusgeben("Lesebestätigung nicht gesendet", ackStatus);
  }
#endif

  // Nächster Versand: 30 s, oder später, wenn die Sendezeitbegrenzung (Duty Cycle) es verlangt
  uint32_t erlaubteWartezeit = (uint32_t)node.timeUntilUplink();
  uint32_t wartezeit = max(SENDEINTERVALL_MS, erlaubteWartezeit);
  naechsterVersand = millis() + wartezeit;
  Serial.print(F("Nächster Versand in "));
  Serial.print(wartezeit / 1000);
  Serial.println(F(" s."));
}
