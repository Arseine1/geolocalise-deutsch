#!/usr/bin/env node
/**
 * Lokaler Proxy für den SMS-Versand (Vonage) der Geofencing-Demo.
 *
 * Warum: Vonage verlangt einen Schlüssel und ein Geheimnis, die nicht in eine Webseite gehören (für alle lesbar),
 * und lehnt direkte Aufrufe aus einem Browser ab. Die Seite meldet diesem kleinen Programm daher nur „es gibt einen Alarm“;
 * es fügt das Geheimnis hinzu und fordert bei Vonage den Versand an.
 *
 * Start:   node tools/sms-proxy.js        (Node 18 oder neuer, keine Abhängigkeiten zu installieren)
 * Konfiguration: Datei tools/sms-proxy.env (siehe tools/sms-proxy.env.example) oder Umgebungsvariablen.
 *
 * Sicherheit:
 *  - hört nur auf der lokalen Schleife (127.0.0.1 und ::1), nie aus dem Netzwerk erreichbar;
 *  - das Vonage-Geheimnis bleibt in diesem Programm; die Seite erhält die Nummern nie im Klartext (nur die letzten 3
 *    Ziffern) und gibt den SMS-Text nicht vor (er wird hier aus geprüften Zahlen zusammengesetzt). Sie kann nur
 *    einen Empfänger hinzufügen oder entfernen (Route /recipients, nur lokale Seiten, höchstens 3 Nummern, gespeichert
 *    in tools/sms-recipients.json);
 *  - nur auf diesem Rechner geöffnete Seiten können ihn aus einem Browser aufrufen;
 *  - Mindestabstand zwischen zwei SMS und Tageslimit (in einer Datei gespeichert: Ein Neustart setzt es nicht zurück).
 *
 * Testmodus (Dry-Run): Ohne Vonage-Zugangsdaten oder mit SMS_DRY_RUN=1 wird keine SMS gesendet: Der Text wird
 * nur in diesem Terminal angezeigt.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------- Konfiguration ----------
/** Liest eine KEY=VALUE-Datei (leere Zeilen und #-Kommentare werden ignoriert). Gibt {} zurück, wenn sie nicht existiert. */
function readEnvFile(file) {
  const out = {};
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return out; }
  text.split(/\r?\n/).forEach((line) => {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith("#")) return;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");   // entfernt eventuelle Anführungszeichen
  });
  return out;
}

const fileEnv = readEnvFile(path.join(__dirname, "sms-proxy.env"));
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== "" ? process.env[k] : fileEnv[k] !== undefined && fileEnv[k] !== "" ? fileEnv[k] : d);

// Projekteigener Name: Die allgemeine Variable „PORT“ wird von anderen Programmen verwendet und würde den Proxy stören
const PORT = Number(env("SMS_PROXY_PORT", "3001"));
const API_KEY = env("VONAGE_API_KEY", "");
const API_SECRET = env("VONAGE_API_SECRET", "");
const SMS_FROM = env("SMS_FROM", "Geofence");
const VONAGE_URL = env("VONAGE_URL", "https://api.nexmo.com/v1/messages");     // Messages-API von Vonage
const REPORTS_URL = env("VONAGE_REPORTS_URL", "https://api.nexmo.com/v2/reports/records");
const MIN_INTERVAL_S = Number(env("MIN_INTERVAL_SECONDS", "30"));              // Mindestabstand zwischen zwei SMS
const DAILY_MAX = Number(env("DAILY_MAX", "10"));                              // SMS pro Tag, alle Empfänger zusammen
// Seiten, die den Proxy aus einem Browser aufrufen dürfen. Standard: jede auf diesem Rechner geöffnete Seite
// (localhost, 127.0.0.1, [::1], beliebiger Port: Python-Server, XAMPP …). ALLOWED_ORIGINS erzwingt eine genaue Liste.
const ALLOWED_ORIGINS = env("ALLOWED_ORIGINS", "").split(",").map((s) => s.trim()).filter(Boolean);
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;
const originAllowed = (o) => (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.includes(o) : LOOPBACK_ORIGIN.test(o));
const COUNTER_FILE = path.join(__dirname, ".sms-counter.json");

// Empfänger: Nummern im internationalen Format ohne „+“ (z. B. 4915123456789 für Deutschland)
// Tolerant: „+49 151 2345-6789“, „0049 151 …“ oder „4915123456789“ ergeben dieselbe Nummer
const normNumber = (s) => String(s).replace(/[\s().-]/g, "").replace(/^\+/, "").replace(/^00/, "");
const RECIPIENTS_FILE = path.join(__dirname, "sms-recipients.json");   // von der Seite verwaltete Nummern: haben Vorrang vor SMS_TO
const MAX_RECIPIENTS = 3;
let RECIPIENTS = env("SMS_TO", "").split(",").map(normNumber).filter(Boolean);
const badNumber = RECIPIENTS.find((n) => !/^\d{7,15}$/.test(n));
try {
  const saved = JSON.parse(fs.readFileSync(RECIPIENTS_FILE, "utf8"));
  if (saved && Array.isArray(saved.numbers) && saved.numbers.length && saved.numbers.every((n) => /^\d{7,15}$/.test(n))) RECIPIENTS = saved.numbers.slice(0, MAX_RECIPIENTS);
} catch (e) { /* keine Datei: Wir behalten SMS_TO */ }
const FORCED_DRY = env("SMS_DRY_RUN", "") === "1" || !API_KEY || !API_SECRET;
let DRY_RUN = FORCED_DRY || RECIPIENTS.length === 0;
function saveRecipients() {
  DRY_RUN = FORCED_DRY || RECIPIENTS.length === 0;
  fs.writeFileSync(RECIPIENTS_FILE, JSON.stringify({ numbers: RECIPIENTS }));
}

if (badNumber) {
  console.error("Ungültige Nummer in SMS_TO: „" + badNumber + "“. Erwartetes Format: nur Ziffern, mit Landesvorwahl (4915123456789).");
  process.exit(1);
}

// ---------- Tageszähler (dauerhaft gespeichert) ----------
const today = () => new Date().toISOString().slice(0, 10);
let counter = { date: today(), count: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(COUNTER_FILE, "utf8"));
  if (saved && saved.date === today() && Number.isFinite(saved.count)) counter = saved;
} catch (e) { /* keine Datei: Zähler bei null */ }

function saveCounter() {
  try { fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter)); } catch (e) { console.warn("Zähler nicht gespeichert:", e.message); }
}
function remainingToday() {
  if (counter.date !== today()) counter = { date: today(), count: 0 };
  return Math.max(0, DAILY_MAX - counter.count);
}

let lastSentAt = 0;   // Zeitpunkt des letzten echten Versands (ms)

// ---------- SMS-Text ----------
// Bezeichnet die überwachte Person in den Nachrichten (z. B. „Ihr Patient“, „Ihr Patient Marie“).
// Umlaute werden umgeschrieben (ä -> ae usw.): Ein einziges Zeichen außerhalb des GSM-Alphabets senkt die Grenze von 160 auf 70 Zeichen je Segment.
const ascii = (s) => String(s).replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/Ä/g, "Ae").replace(/Ö/g, "Oe").replace(/Ü/g, "Ue").replace(/ß/g, "ss").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7E]/g, "?");
const PATIENT = ascii(env("PATIENT_LABEL", "Ihr Patient")).trim().slice(0, 40) || "Ihr Patient";

/**
 * Setzt die SMS aus geprüften Werten zusammen (nie Text, der von der Seite kommt).
 *  - exit   : „ALARM: Ihr Patient hat gerade seine Kontrollzone verlassen (123 m vom Rand). 10:04 <Kartenlink>“
 *  - exit bei der ersten Messung: „... befindet sich ausserhalb seiner Kontrollzone ...“ (er ist nicht vor unseren Augen „ausgetreten“)
 *  - return : „INFO: Ihr Patient ist gerade in seine Kontrollzone zurueckgekehrt. 10:12 <Kartenlink>“
 * Der (kurze) Google-Maps-Link öffnet die Karte an der Position: insgesamt etwa 130 Zeichen, also nur eine SMS.
 */
function buildText(ev, lat, lng, distanceM, first) {
  const hhmm = new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  const link = Number.isFinite(lat) && Number.isFinite(lng) ? " https://maps.google.com/?q=" + lat.toFixed(5) + "," + lng.toFixed(5) : "";
  const dist = Number.isFinite(distanceM) ? " (" + Math.round(distanceM) + " m vom Rand)" : "";
  if (ev === "exit") {
    return "ALARM: " + PATIENT + (first ? " befindet sich ausserhalb seiner Kontrollzone" : " hat gerade seine Kontrollzone verlassen") + dist + ". " + hhmm + link;
  }
  if (ev === "return") return "INFO: " + PATIENT + " ist gerade in seine Kontrollzone zurueckgekehrt. " + hhmm + link;
  return "TEST: Die SMS-Alarme der Ueberwachung funktionieren. " + hhmm;
}

// ---------- Versand über Vonage ----------
const mask = (n) => "*".repeat(Math.max(0, String(n).length - 3)) + String(n).slice(-3);
const authHeader = () => "Basic " + Buffer.from(API_KEY + ":" + API_SECRET).toString("base64");

async function sendOne(to, text) {
  const r = await fetch(VONAGE_URL, {
    method: "POST",
    headers: { "Authorization": authHeader(), "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ channel: "sms", message_type: "text", to: to, from: SMS_FROM, text: text }),
    signal: AbortSignal.timeout(10000)
  });
  let detail = "";
  try { detail = (await r.text()).slice(0, 300); } catch (e) { /* Antworttext unlesbar */ }
  let uuid;
  try { uuid = JSON.parse(detail).message_uuid; } catch (e) { /* kein JSON */ }
  return { to: mask(to), httpStatus: r.status, ok: r.status >= 200 && r.status < 300, detail: r.ok ? undefined : detail, uuid: uuid };
}

// ---------- Zustellverfolgung ----------
// „Angenommen“ von Vonage heißt nicht „empfangen“: Der Netzbetreiber oder Vonage kann die Nachricht danach noch ablehnen.
// Das Versandprotokoll von Vonage (Reports-API, nur lesend) liefert das tatsächliche Ergebnis.
const DLR_TEXT = {
  "0": "Zugestellt",
  "1": "Nicht zugestellt, Ursache unbekannt",
  "2": "Telefon nicht erreichbar (vorübergehend)",
  "3": "Nummer inaktiv",
  "4": "Anrufe/SMS vom Teilnehmer gesperrt",
  "5": "Fehler bei der Rufnummernmitnahme",
  "6": "Vom Spam-Filter des Netzbetreibers blockiert",
  "7": "Telefon besetzt",
  "8": "Netzwerkfehler",
  "9": "Nummer abgelehnt (der Empfänger hat diese Nachrichten abgelehnt)",
  "10": "Ungültige Nachricht (falscher Parameter)",
  "11": "Keine Route verfügbar: Vonage-Support kontaktieren",
  "12": "Ziel nicht erreichbar: Nummer prüfen",
  "14": "Nummer vom Netzbetreiber gesperrt",
  "15": "Prepaid-Guthaben des Empfängers reicht nicht aus",
  "17": "Nachricht von einem Anbieter blockiert (Inhalt oder Einschränkung)",
  "20": "Von einer Verkehrsregel von Fraud Defender abgelehnt",
  "22": "Vom Burst-Schutz von Fraud Defender abgelehnt",
  "23": "Vom AIT-Schutz von Fraud Defender abgelehnt",
  "24": "Von einer LÄNDER-Regel von Fraud Defender abgelehnt: Erlauben Sie dieses Land im Vonage-Dashboard (Fraud Defender > Country Management)",
  "25": "Von einer Netzregel von Fraud Defender abgelehnt",
  "41": "Vonage-Tageslimit erreicht",
  "50": "Entitätskennung fehlt oder ist falsch",
  "51": "Absender (from) fehlt oder ist für dieses Land falsch",
  "52": "Inhaltskennung fehlt oder ist falsch",
  "53": "Einwilligung nicht erlaubt",
  "99": "Allgemeiner Vonage-Fehler: Support kontaktieren"
};
function dlrExplain(status, code) {
  if (code === "0" || status === "delivered") return DLR_TEXT["0"];
  if (code && DLR_TEXT[code]) return DLR_TEXT[code];
  if (code) return "Abgelehnt, Code " + code + " (siehe Liste der Vonage-Codes)";
  return "Ausstehend: noch keine Antwort des Netzbetreibers";
}

async function fetchDelivery() {
  const since = new Date(Date.now() - 24 * 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
  const until = new Date(Date.now() + 3600e3).toISOString().replace(/\.\d+Z$/, "Z");
  const url = REPORTS_URL + "?account_id=" + encodeURIComponent(API_KEY) + "&product=SMS&direction=outbound&date_start=" + since + "&date_end=" + until;
  const r = await fetch(url, { headers: { "Authorization": authHeader(), "Accept": "application/json" }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error("Vonage hat mit HTTP " + r.status + " geantwortet");
  const j = await r.json();
  const recs = (j.records || []).slice().sort((a, b) => String(b.date_received).localeCompare(String(a.date_received)));
  return recs.slice(0, 3).map((x) => ({
    when: x.date_received, network: x.network_name || "", to: mask(String(x.to || "")), from: x.from || "",
    status: x.status || "", errorCode: String(x.error_code || ""), explanation: dlrExplain(x.status, String(x.error_code || "")), messageId: x.message_id
  }));
}

// ---------- HTTP-Server ----------
function json(res, status, obj, extra) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extra || {}));
  res.end(JSON.stringify(obj));
}

async function handle(req, res) {
  const origin = req.headers.origin;
  const host = req.headers.host || "";
  // Gegen „DNS-Rebinding“: Nur der Zugriff über localhost / 127.0.0.1 / [::1] wird akzeptiert
  if (host !== "localhost:" + PORT && host !== "127.0.0.1:" + PORT && host !== "[::1]:" + PORT) return json(res, 403, { ok: false, error: "Host abgelehnt" });
  // Eine Webseite mit anderem Ursprung darf diesen Proxy nicht aufrufen
  if (origin && !originAllowed(origin)) {
    console.warn("Aufruf abgelehnt: nicht erlaubter Ursprung „" + origin + "“. Fügen Sie ihn in sms-proxy.env zu ALLOWED_ORIGINS hinzu, wenn es wirklich Ihre Seite ist.");
    return json(res, 403, { ok: false, error: "Ursprung nicht erlaubt: " + origin });
  }
  const cors = origin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } : {};

  if (req.method === "OPTIONS") { res.writeHead(204, cors); return res.end(); }

  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { ok: true, provider: "vonage", dryRun: DRY_RUN, recipients: RECIPIENTS.length, remainingToday: remainingToday(), dailyMax: DAILY_MAX, minIntervalSeconds: MIN_INTERVAL_S }, cors);
  }

  // Von der Seite verwaltete Empfänger: nie im Klartext zurückgegeben (nur die letzten 3 Ziffern)
  if (req.url === "/recipients" && (req.method === "GET" || req.method === "POST")) {
    const view = () => ({ ok: true, numbers: RECIPIENTS.map(mask), max: MAX_RECIPIENTS, dryRun: DRY_RUN });
    if (req.method === "GET") return json(res, 200, view(), cors);
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 512) return json(res, 413, { ok: false, error: "Inhalt zu groß" }, cors);
    }
    let b;
    try { b = JSON.parse(raw); } catch (e) { return json(res, 400, { ok: false, error: "Ungültiges JSON" }, cors); }
    if (b && b.action === "add") {
      const n = normNumber(b.number === undefined ? "" : b.number);
      if (!/^\d{7,15}$/.test(n)) return json(res, 400, { ok: false, error: "Ungültige Nummer: mit Landesvorwahl, 7 bis 15 Ziffern (z. B. +49 151 2345 6789)" }, cors);
      if (RECIPIENTS.includes(n)) return json(res, 400, { ok: false, error: "Diese Nummer steht schon in der Liste" }, cors);
      if (RECIPIENTS.length >= MAX_RECIPIENTS) return json(res, 400, { ok: false, error: MAX_RECIPIENTS + " Nummern höchstens: Entfernen Sie zuerst eine" }, cors);
      RECIPIENTS.push(n);
    } else if (b && b.action === "remove") {
      const i = Number(b.index);
      if (!Number.isInteger(i) || i < 0 || i >= RECIPIENTS.length) return json(res, 400, { ok: false, error: "Unbekannte Nummer" }, cors);
      if (RECIPIENTS.length === 1) return json(res, 400, { ok: false, error: "Behalten Sie mindestens eine Nummer (fügen Sie die neue hinzu, bevor Sie die alte entfernen)" }, cors);
      RECIPIENTS.splice(i, 1);
    } else return json(res, 400, { ok: false, error: "action muss add oder remove sein" }, cors);
    try { saveRecipients(); } catch (e) { return json(res, 500, { ok: false, error: "Speichern nicht möglich: " + e.message }, cors); }
    console.log("Empfänger über die Seite geändert: " + RECIPIENTS.map(mask).join(", "));
    return json(res, 200, view(), cors);
  }

  if (req.method === "GET" && req.url === "/delivery") {
    if (DRY_RUN) return json(res, 400, { ok: false, error: "Testmodus: Es wurde keine echte SMS gesendet" }, cors);
    try { return json(res, 200, { ok: true, records: await fetchDelivery() }, cors); }
    catch (e) { return json(res, 502, { ok: false, error: e.name === "TimeoutError" ? "Vonage hat nicht innerhalb von 10 s geantwortet" : e.message }, cors); }
  }

  if (req.method === "POST" && req.url === "/alert") {
    // Inhalt auf 2 KB begrenzt
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2048) return json(res, 413, { ok: false, error: "Inhalt zu groß" }, cors);
    }
    let b;
    try { b = JSON.parse(raw); } catch (e) { return json(res, 400, { ok: false, error: "Ungültiges JSON" }, cors); }
    if (!b || typeof b !== "object" || !["exit", "return", "test"].includes(b.event)) return json(res, 400, { ok: false, error: "event muss exit, return oder test sein" }, cors);
    const lat = b.lat === undefined ? NaN : Number(b.lat), lng = b.lng === undefined ? NaN : Number(b.lng);
    const dist = b.distanceM === undefined ? NaN : Number(b.distanceM);
    if ((b.lat !== undefined && !(Math.abs(lat) <= 90)) || (b.lng !== undefined && !(Math.abs(lng) <= 180)) || (b.distanceM !== undefined && !(dist >= 0 && dist < 1e7))) {
      return json(res, 400, { ok: false, error: "Ungültige Koordinaten oder Entfernung" }, cors);
    }

    const text = buildText(b.event, lat, lng, dist, b.first === true);

    if (DRY_RUN) {
      console.log("[TEST, keine SMS gesendet] " + text);
      return json(res, 200, { ok: true, dryRun: true, text: text, remainingToday: remainingToday() }, cors);
    }

    // Schutzmaßnahmen vor jedem echten Versand
    const wait = lastSentAt + (b.event === "test" ? Math.min(MIN_INTERVAL_S, 10) : MIN_INTERVAL_S) * 1000 - Date.now();
    if (wait > 0) { console.log("[" + b.event + "] ABGELEHNT: zu kurz nacheinander (erneut versuchen in " + Math.ceil(wait / 1000) + " s)"); return json(res, 429, { ok: false, error: "zu kurz nacheinander: erneut versuchen in " + Math.ceil(wait / 1000) + " s" }, cors); }
    if (remainingToday() < RECIPIENTS.length) { console.log("[" + b.event + "] ABGELEHNT: Tageslimit erreicht"); return json(res, 429, { ok: false, error: "Tageslimit erreicht (" + DAILY_MAX + " SMS)" }, cors); }

    lastSentAt = Date.now();
    const results = [];
    for (const to of RECIPIENTS) {
      try {
        const r = await sendOne(to, text);
        if (r.ok) { counter.count += 1; saveCounter(); }
        results.push(r);
      } catch (e) {
        results.push({ to: mask(to), ok: false, detail: e.name === "TimeoutError" ? "Vonage hat nicht innerhalb von 10 s geantwortet" : e.message });
      }
    }
    const ok = results.every((r) => r.ok);
    console.log("[" + b.event + "] " + results.map((r) => r.to + " -> " + (r.ok ? "angenommen" : "FEHLER " + (r.httpStatus || "") + " " + (r.detail || ""))).join(" | "));
    return json(res, ok ? 200 : 502, { ok: ok, dryRun: false, results: results, remainingToday: remainingToday() }, cors);
  }

  return json(res, 404, { ok: false, error: "Unbekannte Route" }, cors);
}

// „localhost“ kann je nach Browser 127.0.0.1 (IPv4) oder ::1 (IPv6) bedeuten: Wir hören auf beiden,
// immer nur auf der lokalen Schleife (nie aus dem Netzwerk erreichbar).
const server = http.createServer(handle);
const server6 = http.createServer(handle);
server6.on("error", (e) => console.warn("IPv6-Lauschen (::1) nicht verfügbar, nur IPv4: " + e.message));
server6.listen(PORT, "::1");

server.listen(PORT, "127.0.0.1", () => {
  console.log("SMS-Proxy (Vonage) gestartet: http://localhost:" + PORT);
  if (DRY_RUN) {
    console.log("TESTMODUS: Es werden keine echten SMS gesendet (" +
      (!API_KEY || !API_SECRET ? "Vonage-Zugangsdaten fehlen" : RECIPIENTS.length === 0 ? "SMS_TO leer" : "SMS_DRY_RUN=1") + ").");
  } else {
    console.log("ECHTMODUS: " + RECIPIENTS.length + " Empfänger, Absender „" + SMS_FROM + "“, " + remainingToday() + "/" + DAILY_MAX + " SMS heute übrig.");
  }
  console.log("Erlaubte Ursprünge: " + (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(", ") : "jede auf diesem Rechner geöffnete Seite (localhost, 127.0.0.1, [::1])"));
});
