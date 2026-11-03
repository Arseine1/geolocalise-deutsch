#!/usr/bin/env node
/**
 * Automatischer Test des Sprach-Relays: „node tools/test-voice.js“
 * Startet das Relay auf einem freien Port in einem temporären Ordner (nichts wird in data/ geschrieben) und prüft:
 * Senden, Liste, Download, Bestätigung, Ablehnung ohne Token, Ablehnung eines falschen Ursprungs, Ablehnung über 1 MB,
 * Ablehnung einer Datei, die kein Audio ist, Stundenlimit, Bereinigung, Ereignisstrom und die Einbindung
 * in tools/serve.js (Ordner data/ wird nicht als Datei ausgeliefert).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createRelay } = require("./voice-relay.js");
const { toWav8k } = require("./voice-tts.js");

const TOKEN = "jeton-de-test-" + Math.random().toString(16).slice(2);
let ok = 0, ko = 0;
function check(name, cond, detail) {
  if (cond) { ok++; console.log("  ✔ " + name); } else { ko++; console.log("  ✘ " + name + (detail ? "  → " + detail : "")); }
}

/** Rohe HTTP-Anfrage (zuverlässiger als fetch bei unterwegs abgelehnten Sendungen). */
function call(port, method, url, headers, body) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: port, method: method, path: url, headers: Object.assign({}, headers, body ? { "Content-Length": body.length } : {}) }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(buf.toString("utf8")); } catch (e) { /* kein JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, buf: buf, json: json });
      });
    });
    req.on("error", (e) => resolve({ status: 0, error: e.code || e.message, buf: Buffer.alloc(0) }));
    if (body) req.write(body);
    req.end();
  });
}

/** Ein WAV PCM 8 kHz 16 Bit mono von `seconds` Sekunden, mit Scheingrößen (wie ein Versand im Strom). */
function makeWav(seconds) {
  const data = Buffer.alloc(Math.round(8000 * 2 * seconds));
  for (let i = 0; i < data.length / 2; i++) data.writeInt16LE(Math.round(8000 * Math.sin(i / 8)), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(0xFFFFFFFF, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(0xFFFFFFFF, 40);
  return Buffer.concat([h, data]);
}
/** Eine falsche WebM-Datei: Für das Relay zählt nur die EBML-Signatur. */
const makeWebm = (n) => Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(n || 2000, 7)]);

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "voice-test-"));
  let clock = Date.now();
  const relay = createRelay({ dir: dir, token: TOKEN, retentionDays: 7, now: () => clock, maxPerHour: 20 });
  const server = http.createServer((req, res) => { if (relay.matches(req)) relay.handle(req, res); else { res.writeHead(404); res.end(); } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const PAGE = { "Origin": "http://localhost:8080", "Host": "localhost:" + port, "X-From": "page" };
  const DEV = { "X-Voice-Token": TOKEN, "X-From": "device" };
  let r;

  console.log("Sprach-Relay: Test auf Port " + port + " (Ordner " + dir + ")\n");

  console.log("Senden, Liste, Download, Bestätigung");
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm;codecs=opus", "X-Duration-Ms": "4200" }, PAGE), makeWebm());
  check("die Seite sendet eine WebM-Nachricht (200, ID, Datum, Dauer 4,2 s)", r.status === 200 && r.json && r.json.id === 1 && r.json.duration === 4.2 && !!r.json.at, JSON.stringify(r.json || r.error));
  const idPage = r.json && r.json.id;

  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/wav" }, DEV), makeWav(3));
  check("das Gerät sendet ein WAV im Strom mit Token (berechnete Dauer 3 s)", r.status === 200 && r.json.duration === 3, JSON.stringify(r.json || r.error));
  const idDev = r.json && r.json.id;

  r = await call(port, "GET", "/api/voice?since=0", PAGE);
  check("die Liste enthält die 2 Nachrichten, ohne Dateipfad", r.status === 200 && r.json.messages.length === 2 && !JSON.stringify(r.json).includes("file"), JSON.stringify(r.json));
  r = await call(port, "GET", "/api/voice?since=" + idPage, PAGE);
  check("since=<id> liefert nur die folgenden", r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].id === idDev);
  r = await call(port, "GET", "/api/voice?since=0&unheard=1", DEV);
  check("das Gerät sieht nur die noch nicht angehörte Nachricht der Seite", r.status === 200 && r.json.messages.length === 1 && r.json.messages[0].from === "page");

  r = await call(port, "GET", "/api/voice/" + idDev + "/audio", PAGE);
  const wavOut = r.buf;
  check("Download des WAV (Typ audio/wav)", r.status === 200 && r.headers["content-type"] === "audio/wav" && wavOut.length === 44 + 48000);
  check("WAV-Kopf vom Relay korrigiert (echte Größen)", wavOut.readUInt32LE(40) === 48000 && wavOut.readUInt32LE(4) === wavOut.length - 8);
  r = await call(port, "GET", "/api/voice", PAGE);
  check("der Autor, der seine eigene Nachricht herunterlädt, markiert sie nicht als „empfangen“", r.json.messages.find((m) => m.id === idPage).delivered === false);
  r = await call(port, "GET", "/api/voice/" + idPage + "/audio", DEV);
  check("das Gerät lädt die Nachricht der Seite herunter (identischer Inhalt)", r.status === 200 && r.buf.length === makeWebm().length && r.headers["content-type"] === "audio/webm");
  r = await call(port, "GET", "/api/voice", PAGE);
  check("die Nachricht der Seite wechselt auf „empfangen“", r.json.messages.find((m) => m.id === idPage).delivered === true && r.json.messages.find((m) => m.id === idPage).heard === false);
  r = await call(port, "POST", "/api/voice/" + idPage + "/ack", DEV);
  check("die Bestätigung des Geräts markiert „angehört“", r.status === 200 && r.json.heard === true);
  r = await call(port, "GET", "/api/voice?since=0&unheard=1", DEV);
  check("keine ungehörte Nachricht mehr für das Gerät", r.status === 200 && r.json.messages.length === 0);
  r = await call(port, "POST", "/api/voice/" + idDev + "/ack", DEV);
  check("man kann die eigene Nachricht nicht bestätigen", r.status === 200 && r.json.heard === false);
  r = await call(port, "GET", "/api/voice/999/audio", PAGE);
  check("unbekannte Nachricht: 404", r.status === 404);

  console.log("\nWAV-Version für das Gerät (es dekodiert kein WebM/Opus)");
  r = await call(port, "GET", "/api/voice/" + idPage + "/audio?format=wav", DEV);
  check("vor dem Ablegen fehlt die WAV-Version (404)", r.status === 404);
  r = await call(port, "POST", "/api/voice/" + idPage + "/wav", Object.assign({ "Content-Type": "audio/wav" }, DEV), makeWav(2));
  check("das Gerät kann keine WAV-Version ablegen (403)", r.status === 403);
  r = await call(port, "POST", "/api/voice/" + idPage + "/wav", Object.assign({ "Content-Type": "audio/wav" }, PAGE), makeWav(31));
  check("version WAV de plus de 30 s : 413", r.status === 413);
  r = await call(port, "POST", "/api/voice/" + idPage + "/wav", Object.assign({ "Content-Type": "audio/wav" }, PAGE), makeWav(2));
  check("die Seite legt die WAV-Version ab (meta.wav = true)", r.status === 200 && r.json.wav === true, JSON.stringify(r.json));
  r = await call(port, "GET", "/api/voice/" + idPage + "/audio?format=wav", DEV);
  check("das Gerät lädt die WAV-Version herunter (audio/wav, 2 s)", r.status === 200 && r.headers["content-type"] === "audio/wav" && r.buf.length === 44 + 32000);
  r = await call(port, "GET", "/api/voice/" + idPage + "/audio", PAGE);
  check("l'original WebM reste disponible", r.status === 200 && r.headers["content-type"] === "audio/webm");

  console.log("\nSicherheit");
  r = await call(port, "POST", "/api/voice", { "Content-Type": "audio/wav" }, makeWav(1));
  check("ohne Token und ohne Browser-Header: 401", r.status === 401, String(r.status));
  r = await call(port, "POST", "/api/voice", { "Content-Type": "audio/wav", "X-Voice-Token": "mauvais" }, makeWav(1));
  check("mauvais jeton : 401", r.status === 401);
  r = await call(port, "GET", "/api/voice?since=0", {});
  check("Lesen der Liste ohne Token: 401", r.status === 401);
  check("das Token wird nie in einer Antwort zurückgegeben", !r.buf.toString().includes(TOKEN));
  r = await call(port, "POST", "/api/voice", { "Content-Type": "audio/webm", "X-Duration-Ms": "1000", "Origin": "https://site-malveillant.example", "Host": "localhost:" + port }, makeWebm());
  check("fremder Ursprung (andere Seite): 403", r.status === 403);
  r = await call(port, "POST", "/api/voice", { "Content-Type": "audio/webm", "X-Duration-Ms": "1000", "Origin": "http://localhost:8080", "Host": "exemple.fr" }, makeWebm());
  check("nicht lokaler Hostname (DNS-Rebinding): 403", r.status === 403);
  r = await call(port, "POST", "/api/voice/notify", DEV);
  check("das Gerät kann /notify nicht auslösen (nur für die Seite)", r.status === 403);

  console.log("\nGrenzen");
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "5000" }, PAGE), makeWebm(1024 * 1024 + 10));
  check("plus de 1 Mo : 413", r.status === 413, String(r.status || r.error));
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/wav" }, DEV), makeWav(31));
  check("mehr als 30 s (WAV von 31 s, weniger als 1 MB): 413", r.status === 413, String(r.status));
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "45000" }, PAGE), makeWebm());
  check("angekündigte Dauer von 45 s: 413", r.status === 413);
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm" }, PAGE), makeWebm());
  check("fehlende Dauer bei einer Nicht-WAV-Datei: 400", r.status === 400);
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "1000" }, PAGE), Buffer.from("<html>kein Audio</html>"));
  check("Inhalt, der kein Audio ist: 400", r.status === 400);
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "text/html", "X-Duration-Ms": "1000" }, PAGE), makeWebm());
  check("type non audio : 415", r.status === 415);
  check("die abgelehnten Sendungen haben nichts gespeichert", (await call(port, "GET", "/api/voice?since=0", PAGE)).json.messages.length === 2);

  console.log("\nEreignisstrom (SSE)");
  const events = [];
  const sse = http.request({ host: "127.0.0.1", port: port, path: "/api/voice/stream", headers: PAGE }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (d) => events.push(d));
  });
  sse.end();
  await new Promise((r2) => setTimeout(r2, 200));
  await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "1500" }, DEV), makeWebm());
  await call(port, "POST", "/api/voice/notify", PAGE);
  await new Promise((r2) => setTimeout(r2, 200));
  const flux = events.join("");
  check("der Strom meldet die neue Nachricht (event: message)", /event: message\ndata: \{"id":3,/.test(flux));
  check("der Strom meldet die Benachrichtigung (event: notify)", /event: notify/.test(flux));
  sse.destroy();

  console.log("\nSenden im Strom (chunked) wie die Firmware des Geräts");
  r = await new Promise((resolve) => {
    const wav = makeWav(2);
    const req = http.request({ host: "127.0.0.1", port: port, method: "POST", path: "/api/voice", headers: Object.assign({ "Content-Type": "audio/wav", "Transfer-Encoding": "chunked" }, DEV) }, (res) => {
      const parts = [];
      res.on("data", (c) => parts.push(c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(parts).toString()) }));
    });
    req.write(wav.subarray(0, 44));                       // Kopf mit Scheingrößen, dann Stücke von 512 Byte
    for (let i = 44; i < wav.length; i += 512) req.write(wav.subarray(i, Math.min(i + 512, wav.length)));
    req.end();
  });
  check("WAV von 2 s ohne Content-Length gesendet: akzeptiert, Dauer 2 s", r.status === 200 && r.json.duration === 2, JSON.stringify(r.json));
  r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/wav" }, DEV), makeWav(0.1).subarray(0, 40));
  check("im Kopf abgeschnittenes WAV: 400", r.status === 400);

  console.log("\nStundenlimit (20 Nachrichten pro Stunde)");
  let last = 0;
  for (let i = 0; i < 25 && last !== 429; i++) {
    r = await call(port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "500" }, PAGE), makeWebm(100));
    last = r.status;
  }
  const total = (await call(port, "GET", "/api/voice?since=0", PAGE)).json.messages.length;
  check("die 21. Nachricht der Stunde wird abgelehnt (429)", last === 429 && total === 20, "Status " + last + ", " + total + " Nachrichten");

  console.log("\nBereinigung (Aufbewahrung 7 Tage)");
  clock += 6 * 86400000;
  check("an Tag +6 wird nichts gelöscht", relay.purge() === 0);
  clock += 2 * 86400000;
  const files = () => fs.readdirSync(dir).filter((f) => /^\d+\.(dev\.)?(webm|wav)$/.test(f)).length;
  const before = files();
  const removed = relay.purge();
  check("an Tag +8 werden alle Nachrichten gelöscht (Index und Dateien)", removed === 20 && files() === 0 && before === 21, removed + " gelöscht, " + files() + " Dateien übrig");
  r = await call(port, "GET", "/api/voice?since=0", PAGE);
  check("die Liste ist nach der Bereinigung leer", r.json.messages.length === 0);
  r = await call(port, "GET", "/api/voice/1/audio", PAGE);
  check("das bereinigte Audio antwortet 404", r.status === 404);

  console.log("\nDauerhafte Speicherung");
  relay.close();
  clock = Date.now();
  const relay2 = createRelay({ dir: dir, token: TOKEN, retentionDays: 7 });
  const s2 = http.createServer((req, res) => relay2.handle(req, res));
  await new Promise((r2) => s2.listen(0, "127.0.0.1", r2));
  r = await call(s2.address().port, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/wav" }, DEV), makeWav(1));
  check("nach einem Neustart laufen die IDs weiter (keine Wiederverwendung)", r.status === 200 && r.json.id === 21, JSON.stringify(r.json));
  relay2.close(); s2.close();

  console.log("\nTextnachrichten (Seite zum Gerät, per LoRaWAN) und lokale Sprachsynthese");
  {
    const dirT = fs.mkdtempSync(path.join(os.tmpdir(), "voice-text-"));
    const relayT = createRelay({ dir: dirT, token: TOKEN, retentionDays: 7 });
    const srvT = http.createServer((req, res) => { if (relayT.matches(req)) relayT.handle(req, res); else { res.writeHead(404); res.end(); } });
    await new Promise((r2) => srvT.listen(0, "127.0.0.1", r2));
    const pt = srvT.address().port;
    const PG = Object.assign({}, PAGE, { "Host": "localhost:" + pt });
    const TXT = Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, PG);
    const eventsT = [];
    const sseT = http.request({ host: "127.0.0.1", port: pt, path: "/api/voice/stream", headers: PG }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => eventsT.push(d)); });
    sseT.end();
    r = await call(pt, "POST", "/api/voice", TXT, Buffer.from("Hallo, ich komme in zehn Minuten"));
    check("die Seite sendet einen Text (200, ID, Anzahl Byte)", r.status === 200 && r.json.id === 1 && r.json.text === "Hallo, ich komme in zehn Minuten" && r.json.bytes === 32, JSON.stringify(r.json));
    r = await call(pt, "POST", "/api/voice", TXT, Buffer.from("a".repeat(49)));
    check("49 Byte: akzeptiert (Grenze eines LoRaWAN-Downlinks)", r.status === 200);
    r = await call(pt, "POST", "/api/voice", TXT, Buffer.from("a".repeat(50)));
    check("50 Byte: abgelehnt (413)", r.status === 413, String(r.status));
    r = await call(pt, "POST", "/api/voice", TXT, Buffer.from("ü".repeat(25)));
    check("25 Umlaute = 50 Byte UTF-8: abgelehnt (Umlaute zählen doppelt)", r.status === 413);
    r = await call(pt, "POST", "/api/voice", TXT, Buffer.from("   \n\t  "));
    check("leerer Text: 400", r.status === 400);
    r = await call(pt, "POST", "/api/voice", TXT, Buffer.from("Zeile eins\r\nZeile\u0007 zwei"));
    check("Zeilenumbrüche und Steuerzeichen bereinigt", r.status === 200 && r.json.text === "Zeile eins Zeile zwei", JSON.stringify(r.json));
    r = await call(pt, "POST", "/api/voice", Object.assign({ "Content-Type": "text/plain; charset=utf-8" }, DEV), Buffer.from("Ich brauche Hilfe"));
    check("das Gerät sendet nie Text (403: weder Tastatur noch Bildschirm)", r.status === 403, String(r.status));
    r = await call(pt, "POST", "/api/voice", { "Content-Type": "text/plain", "Host": "localhost:" + pt }, Buffer.from("Bonjour"));
    check("Text ohne Token und ohne lokalen Ursprung: abgelehnt (401)", r.status === 401, String(r.status));
    r = await call(pt, "GET", "/api/voice?since=0", PG);
    check("die Liste enthält nur die Texte der Seite (kind: text, text, from)", r.json.messages.length === 3 && r.json.messages.every((m) => m.kind === "text" && m.from === "page") && r.json.messages[0].text.startsWith("Hallo"), JSON.stringify(r.json.messages.map((m) => m.from)));
    r = await call(pt, "GET", "/api/voice/1/audio", PG);
    check("ein Text hat keine Audiodatei (404)", r.status === 404);
    r = await call(pt, "POST", "/api/voice/1/ack", DEV);
    check("das Gerät bestätigt das Vorlesen des Textes: angehört", r.status === 200 && r.json.heard === true);
    await call(pt, "POST", "/api/voice/notify?id=1", PG);
    await new Promise((r2) => setTimeout(r2, 200));
    check("die Benachrichtigung verteilt den Text an den Simulator (event: notify)", /event: notify\ndata: \{[^\n]*"text":"Hallo, ich komme/.test(eventsT.join("")));
    sseT.destroy();

    // Texte und Sprachnachrichten haben getrennte Zähler: 20 Sprachnachrichten pro Stunde verhindern nicht, einen Text zu senden
    const dirL = fs.mkdtempSync(path.join(os.tmpdir(), "voice-limit-"));
    const relayL = createRelay({ dir: dirL, token: TOKEN, retentionDays: 7, maxPerHour: 1 });
    const srvL = http.createServer((req, res) => { if (relayL.matches(req)) relayL.handle(req, res); else { res.writeHead(404); res.end(); } });
    await new Promise((r2) => srvL.listen(0, "127.0.0.1", r2));
    const pl = srvL.address().port, PL = Object.assign({}, PAGE, { "Host": "localhost:" + pl });
    const a1 = await call(pl, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "500" }, PL), makeWebm(100));
    const a2 = await call(pl, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "500" }, PL), makeWebm(100));
    const t1 = await call(pl, "POST", "/api/voice", Object.assign({ "Content-Type": "text/plain" }, PL), Buffer.from("Bonjour"));
    check("Limit der Sprachnachrichten erreicht (429), aber ein Text geht noch durch (200)", a1.status === 200 && a2.status === 429 && t1.status === 200, [a1.status, a2.status, t1.status].join("/"));
    srvL.close();

    // notify: Anzahl der verbundenen simulierten Geräte (?as=device)
    r = await call(pt, "POST", "/api/voice/notify?id=1", PG);
    check("notify ohne geöffnetes simuliertes Gerät: sensors 0", r.status === 200 && r.json.sensors === 0, JSON.stringify(r.json));
    const sseS = http.request({ host: "127.0.0.1", port: pt, path: "/api/voice/stream?as=device", headers: PG }, (res) => { res.resume(); });
    sseS.end();
    await new Promise((r2) => setTimeout(r2, 200));
    r = await call(pt, "POST", "/api/voice/notify?id=1", PG);
    check("notify mit geöffnetem simuliertem Gerät: sensors 1", r.status === 200 && r.json.sensors === 1, JSON.stringify(r.json));
    sseS.destroy();

    // Sprachnachricht der Seite: Die Benachrichtigung (simulierter Downlink) trägt kind "voice" und die Dauer
    const dataS = [];
    const sseV = http.request({ host: "127.0.0.1", port: pt, path: "/api/voice/stream?as=device", headers: PG }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => dataS.push(d)); });
    sseV.end();
    r = await call(pt, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "2500" }, PG), makeWebm(100));
    const vid = r.json.id;
    check("die Seite sendet eine Sprachnachricht an das Relay", r.status === 200 && vid > 0, JSON.stringify(r.json));
    await call(pt, "POST", "/api/voice/notify?id=" + vid, PG);
    await new Promise((r2) => setTimeout(r2, 200));
    check("notify einer Sprachnachricht: Event mit kind voice und der Dauer", new RegExp('event: notify\\ndata: \\{[^\\n]*"id":' + vid + ',"kind":"voice","text":null,"duration":2.5').test(dataS.join("")), dataS.join("").slice(-200));
    r = await call(pt, "GET", "/api/voice/" + vid + "/audio", DEV);
    check("das Gerät lädt das Audio der Seite herunter (200)", r.status === 200);
    r = await call(pt, "POST", "/api/voice/" + vid + "/ack", DEV);
    check("das Gerät bestätigt das Anhören der Sprachnachricht der Seite", r.status === 200 && r.json.heard === true && r.json.delivered === true);
    // /api/voice/next: Das Gerät (Firmware) fragt die nächste ungehörte Sprachnachricht der Seite ab
    const v2 = await call(pt, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "1500" }, PG), makeWebm(100));
    r = await call(pt, "GET", "/api/voice/next", DEV);
    check("next: liefert die ungehörte Sprachnachricht der Seite { id, duration }", r.status === 200 && r.json.id === v2.json.id && r.json.duration === 1.5, JSON.stringify(r.json));
    await call(pt, "POST", "/api/voice/" + v2.json.id + "/ack", DEV);
    r = await call(pt, "GET", "/api/voice/next", DEV);
    check("next: 204, wenn alles angehört ist (Texte zählen nicht)", r.status === 204, String(r.status));
    sseV.destroy();

    // Neuabtastung: 1 s in 22050 Hz Stereo -> 8000 Mono-Samples bei 8 kHz
    const n = 22050, pcm = Buffer.alloc(n * 4), h = Buffer.alloc(44);
    for (let i = 0; i < n; i++) { const v = Math.round(10000 * Math.sin(i / 20)); pcm.writeInt16LE(v, i * 4); pcm.writeInt16LE(v, i * 4 + 2); }
    h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(22050, 24); h.writeUInt32LE(22050 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
    const w8 = toWav8k(Buffer.concat([h, pcm]));
    check("Umwandlung 22,05 kHz Stereo -> WAV 8 kHz mono (1 s = 16 000 Byte Daten)", !!w8 && w8.readUInt32LE(24) === 8000 && w8.readUInt16LE(22) === 1 && w8.length === 44 + 16000, w8 && String(w8.length));

    // Echte Synthese mit der Sprach-Engine des PCs (falls der PC eine hat)
    r = await call(pt, "GET", "/api/voice/tts?text=" + encodeURIComponent("Hallo, Ihr Angehöriger kommt."), PG);
    if (r.status === 501) console.log("  - Sprachsynthese: keine Sprach-Engine auf diesem PC (501, ignoriert): " + (r.json && r.json.error));
    else check("lokale Sprachsynthese: nicht leeres WAV 8 kHz mono", r.status === 200 && r.buf.readUInt32LE(24) === 8000 && r.buf.length > 4000 && r.headers["content-type"] === "audio/wav", String(r.status));
    r = await call(pt, "GET", "/api/voice/tts?text=Bonjour", {});
    check("Synthese ohne Token und ohne Browser: 401", r.status === 401);
    r = await call(pt, "GET", "/api/voice/tts?text=Bonjour", DEV);
    check("das Gerät (mit Token) kann die Synthese anfordern", r.status === 200 || r.status === 501);
    r = await call(pt, "GET", "/api/voice/tts?text=", DEV);
    check("Synthese eines leeren Textes: 400", r.status === 400);
    relayT.close(); srvT.close();
    fs.rmSync(dirT, { recursive: true, force: true });
  }

  console.log("\nEinbindung in tools/serve.js (Relay erreichbar, Ordner data/ wird nie ausgeliefert)");
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "voice-serve-"));
  process.env.VOICE_DATA_DIR = tmp2;
  process.env.VOICE_DEVICE_TOKEN = TOKEN;
  process.env.VOICE_LAN = "0";
  const serve = require("./serve.js");
  const started = await serve.start(18080);
  const sp = started.port;
  r = await call(sp, "POST", "/api/voice", Object.assign({ "Content-Type": "audio/webm", "X-Duration-Ms": "1000" }, { "Origin": "http://localhost:" + sp, "Host": "localhost:" + sp }), makeWebm());
  check("serve.js: POST /api/voice akzeptiert", r.status === 200, String(r.status));
  r = await call(sp, "GET", "/web/", {});
  check("serve.js: die Seite /web/ wird weiterhin ausgeliefert", r.status === 200 && /Geofencing/.test(r.buf.toString()));
  r = await call(sp, "GET", "/data/voice/index.json", {});
  check("serve.js: data/ wird nie als Datei ausgeliefert (404)", r.status === 404);
  r = await call(sp, "GET", "/tools/voice.env", {});
  check("serve.js: tools/voice.env wird nicht ausgeliefert (404)", r.status === 404);
  started.server.close();

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(tmp2, { recursive: true, force: true });
  server.close();
  console.log("\n" + (ko === 0 ? "ALLE TESTS BESTANDEN" : ko + " TEST(S) FEHLGESCHLAGEN") + " (" + ok + " bestanden, " + ko + " fehlgeschlagen)");
  process.exit(ko === 0 ? 0 : 1);
})().catch((e) => { console.error("Testfehler:", e); process.exit(1); });
