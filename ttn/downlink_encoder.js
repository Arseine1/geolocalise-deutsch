/**
 * Downlink-Encoder – The Things Stack (DEVICE-Ebene: heltec-gps-01)
 *
 * Akzeptierte Eingaben:
 *   { data: { alert: true | false } }          ->  { bytes: [1] oder [0], fPort: 2 }          LED blinkt / aus
 *   { data: { text: "Hallo", seq: 7 } }        ->  { bytes: [7, ...UTF-8-Text], fPort: 4 }    Textnachricht, die das Gerät laut ausspricht
 *   { data: { voice: true } }                  ->  { bytes: [1], fPort: 5 }                   eine Sprachnachricht der Seite wartet auf dem Relay
 *
 * Sprachnachricht: Das Audio läuft nicht über LoRaWAN. Dieses kleine Signal (1 Byte) weckt das Gerät, das das Audio per WLAN
 * vom Sprach-Relay des PCs herunterlädt und dann abspielt.
 *
 * Textnachricht: Das erste Byte ist eine Nummer (1 bis 255), die das Gerät als Lesebestätigung zurückschickt (Uplink Port 3);
 * der Rest ist der Text in UTF-8. Insgesamt höchstens 50 Byte: Das passt in einen Downlink mit 51 Byte (SF12, RX2 Standard in EU868).
 * Umlaute und ß kosten je 2 Byte. Die Stimme wird NIE über LoRaWAN übertragen: nur der Text.
 */
function encodeDownlink(input) {
  var data = input && input.data ? input.data : {};

  // Signal „Sprachnachricht wartet“ (Port 5): Das Gerät holt sie per WLAN beim Sprach-Relay ab
  if (data.voice === true) {
    return { bytes: [1], fPort: 5, warnings: [], errors: [] };
  }

  // Textnachricht (Port 4)
  if (data.text !== undefined) {
    var seq = data.seq === undefined ? 1 : data.seq;
    if (typeof data.text !== "string" || data.text.length === 0) {
      return { bytes: [], fPort: 4, warnings: [], errors: ['Das Feld "text" muss ein nicht leerer Text sein'] };
    }
    if (typeof seq !== "number" || seq < 1 || seq > 255 || seq % 1 !== 0) {
      return { bytes: [], fPort: 4, warnings: [], errors: ['Das Feld "seq" muss eine ganze Zahl von 1 bis 255 sein'] };
    }
    // UTF-8-Umwandlung von Hand (der Interpreter von The Things Stack bietet kein TextEncoder)
    var bytes = [seq];
    var s = unescape(encodeURIComponent(data.text));
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    if (bytes.length > 50) {
      return { bytes: [], fPort: 4, warnings: [], errors: ["Text zu lang: " + (bytes.length - 1) + " Byte, höchstens 49"] };
    }
    return { bytes: bytes, fPort: 4, warnings: [], errors: [] };
  }

  var alert = data.alert;

  // Nur ein Boolean wird akzeptiert
  if (typeof alert !== "boolean") {
    return { bytes: [], fPort: 2, warnings: [], errors: ['Das Feld "alert" muss true oder false sein, oder "text" ein Text'] };
  }

  return { bytes: [alert ? 1 : 0], fPort: 2, warnings: [], errors: [] };
}
