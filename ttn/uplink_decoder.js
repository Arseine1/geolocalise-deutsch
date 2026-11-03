/**
 * Uplink-Decoder – The Things Stack (DEVICE-Ebene: heltec-gps-01)
 *
 * Erwarteter Rahmen: FPort 1, 8 Byte, Big-Endian, vorzeichenbehaftete 32-Bit-Ganzzahlen:
 *   Byte 0-3 : Breitengrad  x 1e7
 *   Byte 4-7 : Längengrad   x 1e7
 *
 * FPort 3: Lesebestätigung einer Textnachricht, 1 Byte = die Nummer der Nachricht (siehe downlink_encoder.js):
 *   07 -> { "ack": 7 }
 *
 * Beispiele für den Test-Tab (FPort 1):
 *   1D1EECF00166EAD0 -> { "lat": 48.8566, "lng": 2.3522 }
 *   EBD00800D5E0B878 -> { "lat": -33.8688, "lng": -70.6693 }
 */
function decodeUplink(input) {
  var bytes = input.bytes;

  // Lesebestätigung einer Textnachricht (FPort 3)
  if (input.fPort === 3) {
    if (!bytes || bytes.length !== 1 || bytes[0] < 1) {
      return { data: {}, warnings: [], errors: ["Ungültige Bestätigung: 1 Byte (Nummer von 1 bis 255) erwartet"] };
    }
    return { data: { ack: bytes[0] }, warnings: [], errors: [] };
  }

  // Unerwarteter Port: Wir melden ihn, ohne etwas zu raten
  if (input.fPort !== 1) {
    return { data: {}, warnings: [], errors: ["Unerwarteter FPort: " + input.fPort + " (1 oder 3 erwartet)"] };
  }

  // Länge zwingend: genau 8 Byte
  if (!bytes || bytes.length !== 8) {
    return { data: {}, warnings: [], errors: ["Ungültige Länge: " + (bytes ? bytes.length : 0) + " Byte, 8 erwartet"] };
  }

  // Liest eine vorzeichenbehaftete 32-Bit-Ganzzahl; "| 0" erzwingt das Zweierkomplement (negative Werte)
  function int32(i) {
    return ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) | 0;
  }

  var lat = int32(0) / 1e7;
  var lng = int32(4) / 1e7;

  // Plausibilitätsprüfung
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return { data: {}, warnings: [], errors: ["Koordinaten außerhalb der Grenzen: " + lat + ", " + lng] };
  }

  return { data: { lat: lat, lng: lng }, warnings: [], errors: [] };
}
