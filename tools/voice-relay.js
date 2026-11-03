#!/usr/bin/env node
/**
 * Sprach-Relay (ohne Abhängigkeiten): speichert die zwischen der Webseite und dem Gerät ausgetauschten Sprachnachrichten.
 *
 * LoRaWAN transportiert keine Stimme (Nutzlast von 51 bis 222 Byte, 1 % Sendezeit): Das Audio läuft daher
 * per HTTP über dieses Relay, und LoRaWAN dient nur dazu, das Gerät zu benachrichtigen (Downlink Port 5, ein Byte).
 *
 * Routen (alle unter /api/voice, in tools/serve.js eingehängt):
 *   POST /api/voice               Inhalt = rohes Audio; Header X-From (page|device), X-Duration-Ms (außer WAV)
 *   GET  /api/voice?since=<id>    Liste der Nachrichten (Option unheard=1: nur die, die der Aufrufer noch nicht angehört hat)
 *   GET  /api/voice/<id>/audio    die Audiodatei (der erste Download durch die Gegenseite = „empfangen“);
 *                                 ?format=wav: WAV-Version mit 8 kHz für das Gerät (das WebM/Opus nicht dekodieren kann)
 *   POST /api/voice/<id>/wav      die Seite legt die WAV-Version (8 kHz, 16 Bit, mono) ihrer Nachricht ab (im Browser umgewandelt)
 *   POST /api/voice/<id>/ack      markiert die Nachricht als „angehört“
 *   GET  /api/voice/stream        Server-Sent Events: neue Nachrichten, Aktualisierungen, Benachrichtigungen
 *   POST /api/voice/notify?id=<id> die Seite meldet, dass sie diesen Text gerade per LoRaWAN gesendet hat (für den Simulator)
 *   GET  /api/voice/next          nächste noch nicht angehörte Sprachnachricht der Seite: { id, duration } oder 204 (für das Gerät)
 *   GET  /api/voice/tts?text=...  LOKALE Sprachsynthese des Textes (WAV 8 kHz mono): Das Gerät lädt sie herunter, um den empfangenen Text zu sprechen
 *
 * Textnachrichten: Die Seite schreibt (oder diktiert) einen Text, der per LoRaWAN gesendet wird, und das Gerät spricht ihn laut aus.
 * POST /api/voice mit Content-Type: text/plain und X-From: page; höchstens 49 Byte UTF-8 (Grenze eines EU868-Downlinks).
 * Das Gerät sendet nie Text (weder Tastatur noch Bildschirm): nur Sprachnachrichten.
 *
 * Sicherheit:
 *  - Browser (Seite, Simulator): nur über die lokale Schleife akzeptiert, mit lokalem Host und Origin.
 *  - Gerät (oder jeder Client ohne Browser-Header): Header X-Voice-Token gleich VOICE_DEVICE_TOKEN.
 *  - Standardmäßig nur lokales Lauschen; VOICE_LAN=1 öffnet einen zweiten Port im lokalen Netz, nur für das Gerät (Token erforderlich).
 *  - Höchstens 1 MB und 30 s je Nachricht, 20 Nachrichten pro Stunde, Löschung nach VOICE_RETENTION_DAYS Tagen.
 *  - Das Token wird nie in Protokolle geschrieben oder in einer Antwort zurückgegeben.
 * Configuration : tools/voice.env (exclu de git) et variables d'environnement (voir tools/voice.env.example).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const { synthesize } = require("./voice-tts.js");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(__dirname, "voice.env");

const MAX_BYTES = 1024 * 1024;       // 1 Mo par message
const TEXT_MAX_BYTES = 49;           // 1 Byte Nummer + 49 Text = 50 Byte: passt in einen Downlink von 51 Byte (SF12)
const MAX_SECONDS = 30;             // 30 s par message
const MAX_PER_HOUR = 20;             // Sprachnachrichten pro Stunde, beide Richtungen zusammen
const MAX_TEXT_PER_HOUR = 200;       // Texte pro Stunde (LoRaWAN begrenzt den Versand ohnehin: ein Downlink pro Minute)
const LIST_MAX = 200;                // höchstens zurückgegebene Nachrichten pro Liste
const SSE_MAX = 20;                  // gleichzeitige Abonnenten des Ereignisstroms
const KEEPALIVE_MS = 20000;          // Haltezeile des Ereignisstroms
const DRAIN_CAP = 8 * MAX_BYTES;     // darüber wird ein abgelehnter Versand abrupt abgebrochen

// MIME-Basistyp -> Erweiterung der gespeicherten Datei
const EXT_OF_TYPE = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav" };
const TYPE_OF_EXT = { webm: "audio/webm", ogg: "audio/ogg", m4a: "audio/mp4", wav: "audio/wav" };

// ---------- Configuration ----------
function readEnvFile(file) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trim().startsWith("#")) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Einstellungen aus den Umgebungsvariablen, dann aus tools/voice.env gelesen. */
function settingsFromEnv(env, file) {
  env = env || process.env;
  const f = readEnvFile(file || ENV_FILE);
  const get = (k, def) => (env[k] !== undefined && env[k] !== "" ? env[k] : f[k] !== undefined && f[k] !== "" ? f[k] : def);
  const days = Number(get("VOICE_RETENTION_DAYS", "7"));
  const lanPort = Number(get("VOICE_LAN_PORT", "8081"));
  return {
    enabled: !/^(0|false|non|no)$/i.test(get("VOICE_ENABLED", "1")),
    token: get("VOICE_DEVICE_TOKEN", ""),
    lan: /^(1|true|oui|yes)$/i.test(get("VOICE_LAN", "0")),
    lanPort: Number.isInteger(lanPort) && lanPort > 0 && lanPort < 65536 ? lanPort : 8081,
    retentionDays: days > 0 ? days : 7,
    dir: get("VOICE_DATA_DIR", path.join(ROOT, "data", "voice"))
  };
}

// ---------- Analyse der Audiodateien ----------
/** Prüft die Dateisignatur: Wir speichern nur Audio, nicht irgendetwas. */
function sniff(buf, ext) {
  if (ext === "webm") return buf.length > 4 && buf.readUInt32BE(0) === 0x1A45DFA3;
  if (ext === "ogg") return buf.length > 4 && buf.toString("latin1", 0, 4) === "OggS";
  if (ext === "m4a") return buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp";
  if (ext === "wav") return buf.length > 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE";
  return false;
}

/**
 * WAV PCM: berechnet die Dauer und korrigiert die Größen im Kopf. Ein Gerät, das im Strom (chunked) sendet, kennt
 * die Endgröße nicht im Voraus und lässt Scheinwerte stehen; das Relay schreibt die echten, damit die
 * Browser die Datei lesen. Gibt { duration, buf } oder null zurück, wenn das WAV ungültig ist.
 */
function analyseWav(buf) {
  let pos = 12, byteRate = 0, dataStart = -1, pcm = false;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      if (pos + 24 > buf.length) return null;
      pcm = buf.readUInt16LE(pos + 8) === 1;
      byteRate = buf.readUInt32LE(pos + 16);
    } else if (id === "data") { dataStart = pos + 8; break; }
    pos += 8 + size + (size & 1);
  }
  if (!pcm || !byteRate || dataStart < 0) return null;
  const dataLen = buf.length - dataStart;
  const out = Buffer.from(buf);
  out.writeUInt32LE(dataLen, dataStart - 4);
  out.writeUInt32LE(out.length - 8, 4);
  return { duration: dataLen / byteRate, buf: out };
}

// ---------- Zugriffskontrolle ----------
const isLoopback = (a) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/i;
const hostnameOf = (hostHeader) => String(hostHeader || "").replace(/:\d+$/, "");

function tokenOk(given, expected) {
  if (!expected || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);   // Vergleich in konstanter Zeit
}

// ---------- Relais ----------
/**
 * Erstellt das Relay. Optionen: dir, token, retentionDays, enabled, log (Funktion), now (Funktion, für Tests),
 * maxBytes, maxSeconds, maxPerHour.
 */
function createRelay(opts) {
  const dir = opts.dir;
  const token = opts.token || "";
  const enabled = opts.enabled !== false;
  const retentionMs = (opts.retentionDays > 0 ? opts.retentionDays : 7) * 86400000;
  const now = opts.now || Date.now;
  const maxBytes = opts.maxBytes || MAX_BYTES;
  const maxSeconds = opts.maxSeconds || MAX_SECONDS;
  const maxPerHour = opts.maxPerHour || MAX_PER_HOUR;
  const log = opts.log || (() => {});
  const indexFile = path.join(dir, "index.json");
  const clients = new Set();
  const sensors = new Set();         // Abonnenten, die sich als simuliertes Gerät melden (?as=device)

  if (enabled) fs.mkdirSync(dir, { recursive: true });

  // JSON-Index: { nextId, messages: [...] }, jedes Mal atomar vollständig neu geschrieben
  let index = { nextId: 1, messages: [] };
  if (enabled) {
    try {
      const j = JSON.parse(fs.readFileSync(indexFile, "utf8"));
      if (j && Array.isArray(j.messages) && Number.isInteger(j.nextId)) index = j;
    } catch (e) {
      if (fs.existsSync(indexFile)) { try { fs.renameSync(indexFile, indexFile + ".illisible"); } catch (e2) { /* tant pis */ } }
    }
  }
  function saveIndex() {
    const tmp = indexFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(index));
    fs.renameSync(tmp, indexFile);
  }

  /** Öffentliche Ansicht einer Nachricht (kein Dateipfad). */
  const meta = (m) => {
    const o = { id: m.id, at: m.at, from: m.from, duration: m.duration, size: m.size, type: m.type, delivered: !!m.deliveredAt, heard: !!m.heardAt, wav: m.type === "audio/wav" || !!m.wavFile };
    if (m.kind === "text") { o.kind = "text"; o.text = m.text; }
    return o;
  };
  /**
   * Wahr (nach der Antwort 429), wenn das Stundenlimit erreicht ist. Sprachnachrichten (Dateien) und Texte
   * (wenige Byte) haben je einen eigenen Zähler: Texte sollen das Senden einer Sprachnachricht nicht verhindern, und umgekehrt.
   */
  function rateLimited(res, text) {
    const since = now() - 3600000;
    const recent = index.messages.filter((m) => Date.parse(m.at) > since && (m.kind === "text") === !!text).length;
    const max = text ? MAX_TEXT_PER_HOUR : maxPerHour;
    if (recent < max) return false;
    res.setHeader("Retry-After", "600");
    fail(res, 429, "Limit von " + max + (text ? " Texten" : " Sprachnachrichten") + " pro Stunde erreicht");
    return true;
  }

  function broadcast(event, data) {
    const frame = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
    for (const c of clients) { try { c.write(frame); } catch (e) { clients.delete(c); } }
  }

  /** Löscht Nachrichten, die älter als die Aufbewahrungsdauer sind; gibt ihre Anzahl zurück. */
  function purge() {
    const limit = now() - retentionMs;
    const keep = [];
    let removed = 0;
    for (const m of index.messages) {
      if (Date.parse(m.at) < limit) {
        for (const f of [m.file, m.wavFile]) if (f) { try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* bereits gelöscht */ } }
        removed++;
      } else keep.push(m);
    }
    if (removed) { index.messages = keep; saveIndex(); log(removed + " Sprachnachricht(en) gelöscht (Aufbewahrung: " + Math.round(retentionMs / 86400000) + " j)"); }
    return removed;
  }
  let purgeTimer = null;
  if (enabled) {
    purge();
    purgeTimer = setInterval(purge, 3600000);
    purgeTimer.unref();
  }

  // ----- Antwort-Werkzeuge -----
  function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  }
  const fail = (res, code, message, extra) => send(res, code, Object.assign({ error: message }, extra || {}));

  /** Wer ruft auf? { role } oder { error: [code, message] }. */
  function authorize(req, ctx) {
    const remote = req.socket.remoteAddress;
    const browserLike = !(ctx && ctx.lan) && isLoopback(remote) && (req.headers.origin || req.headers["sec-fetch-site"]);
    if (browserLike) {
      if (!LOCAL_HOST.test(hostnameOf(req.headers.host))) return { error: [403, "Adresse abgelehnt: Verwenden Sie http://localhost"] };
      if (req.headers.origin) {
        let h = "";
        try { h = new URL(req.headers.origin).hostname; } catch (e) { /* origine invalide */ }
        if (h === "::1") h = "[::1]";
        if (!LOCAL_HOST.test(h)) return { error: [403, "Ursprung abgelehnt: nur die lokale Seite wird akzeptiert"] };
      }
      if (req.headers["sec-fetch-site"] === "cross-site") return { error: [403, "Anfrage einer anderen Seite abgelehnt"] };
      return { role: req.headers["x-from"] === "device" ? "device" : "page", browser: true };
    }
    if (tokenOk(req.headers["x-voice-token"], token)) return { role: "device", browser: false };
    log("abgelehnt: Token fehlt oder ist ungültig (von " + remote + ")");   // das Token selbst wird nie geschrieben
    return { error: [401, "Jeton X-Voice-Token absent ou invalide"] };
  }

  /** Liest den Inhalt (höchstens `max` Byte). Darüber: sofortige Antwort 413, der Rest wird verworfen, ohne gespeichert zu werden. */
  function readBody(req, res, max) {
    return new Promise((resolve) => {
      const chunks = [];
      let total = 0, over = false;
      const declared = Number(req.headers["content-length"]);
      const tooBig = () => { over = true; chunks.length = 0; fail(res, 413, "Nachricht zu groß (höchstens " + Math.round(max / 1024) + " KB)"); resolve(null); };
      if (declared > max) tooBig();
      req.on("data", (c) => {
        total += c.length;
        if (over) { if (total > DRAIN_CAP) req.destroy(); return; }
        if (total > max) return tooBig();
        chunks.push(c);
      });
      req.on("end", () => { if (!over) resolve(Buffer.concat(chunks)); });
      req.on("error", () => { if (!over) resolve(null); });
    });
  }

  // ----- Routes -----
  async function postMessage(req, res, who) {
    const base = String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (base === "text/plain") return postText(req, res, who);
    const ext = EXT_OF_TYPE[base];
    if (!ext) return fail(res, 415, "Typ nicht akzeptiert (audio/webm, audio/ogg, audio/mp4, audio/wav oder text/plain)");

    if (rateLimited(res, false)) return;

    let body = await readBody(req, res, maxBytes);
    if (!body) return;
    if (!body.length) return fail(res, 400, "Message vide");
    if (!sniff(body, ext)) return fail(res, 400, "Der Inhalt ist keine Audiodatei " + base);

    let duration;
    if (ext === "wav") {
      const w = analyseWav(body);
      if (!w) return fail(res, 400, "Ungültige WAV-Datei (PCM erwartet)");
      body = w.buf; duration = w.duration;
    } else {
      const ms = Number(req.headers["x-duration-ms"]);
      if (!Number.isFinite(ms) || ms <= 0) return fail(res, 400, "Header X-Duration-Ms fehlt");
      duration = ms / 1000;
    }
    if (duration > maxSeconds + 0.5) return fail(res, 413, "Nachricht zu lang (höchstens " + maxSeconds + " s)");
    duration = Math.round(duration * 10) / 10;

    const id = index.nextId++;
    const file = id + "." + ext;
    fs.writeFileSync(path.join(dir, file), body);
    const m = { id: id, at: new Date(now()).toISOString(), from: who.role, duration: duration, size: body.length, type: TYPE_OF_EXT[ext], file: file, deliveredAt: null, heardAt: null };
    index.messages.push(m);
    saveIndex();
    log("Nachricht " + id + " von " + m.from + " empfangen (" + duration + " s, " + Math.round(body.length / 1024) + " KB)");
    broadcast("message", meta(m));
    send(res, 200, { id: m.id, at: m.at, duration: m.duration });
  }

  /**
   * Textnachricht: nur von der Seite. Das Gerät hat weder Tastatur noch Bildschirm: Es erhält den Text nur, um ihn laut auszusprechen,
   * und antwortet nur mit Sprachnachrichten.
   * Hier gespeichert; die Seite sendet ihn dann per LoRaWAN (Downlink), und das Gerät spricht ihn laut aus.
   */
  async function postText(req, res, who) {
    if (who.role !== "page") return fail(res, 403, "Nur die Seite sendet Textnachrichten (das Gerät sendet nur Sprachnachrichten)");
    if (rateLimited(res, true)) return;
    const body = await readBody(req, res, 2048);
    if (!body) return;
    const text = body.toString("utf8").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return fail(res, 400, "Message vide");
    const n = Buffer.byteLength(text, "utf8");
    if (n > TEXT_MAX_BYTES) return fail(res, 413, "Text zu lang: " + n + " Byte, höchstens " + TEXT_MAX_BYTES + " (LoRaWAN-Grenze)");
    const id = index.nextId++;
    const m = { id: id, at: new Date(now()).toISOString(), from: "page", kind: "text", text: text, duration: 0, size: n, type: "text/plain", file: null, deliveredAt: null, heardAt: null };
    index.messages.push(m);
    saveIndex();
    log("Nachricht " + id + ": Text der Seite (" + n + " Byte)");
    broadcast("message", meta(m));
    send(res, 200, { id: m.id, at: m.at, duration: 0, text: text, bytes: n });
  }

  /** Lokale Sprachsynthese: Der Text wird zu einem WAV (8 kHz mono), das das Gerät abspielt (kein Online-Dienst). */
  let ttsQueue = Promise.resolve();
  function speak(res, raw) {
    const text = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!text) return fail(res, 400, "Texte vide");
    const job = ttsQueue.then(() => synthesize(text, dir)).then((wav) => {
      res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wav.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(wav);
    }).catch((e) => {
      log("Sprachsynthese nicht möglich: " + e.message);
      if (!res.headersSent) fail(res, 501, "Sprachsynthese auf diesem PC nicht verfügbar: " + e.message);
    });
    ttsQueue = job;   // jeweils nur eine Synthese
    return job;
  }

  function listMessages(res, url, who) {
    const since = Number(url.searchParams.get("since")) || 0;
    const unheard = url.searchParams.get("unheard") === "1";
    let list = index.messages.filter((m) => m.id > since && (!unheard || (!m.heardAt && m.from !== who.role)));
    if (list.length > LIST_MAX) list = list.slice(-LIST_MAX);
    send(res, 200, { messages: list.map(meta), retentionDays: Math.round(retentionMs / 86400000 * 10) / 10, maxSeconds: maxSeconds, maxPerHour: maxPerHour });
  }

  function streamEvents(req, res, asSensor) {
    if (clients.size >= SSE_MAX) return fail(res, 503, "Zu viele Abonnenten des Stroms");
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Content-Type-Options": "nosniff" });
    res.write("retry: 3000\n: ouvert\n\n");
    clients.add(res);
    if (asSensor) sensors.add(res);
    const keep = setInterval(() => { try { res.write(": halten\n\n"); } catch (e) { /* geschlossen */ } }, KEEPALIVE_MS);
    keep.unref();
    req.on("close", () => { clearInterval(keep); clients.delete(res); sensors.delete(res); });
  }

  function sendAudio(res, m, who, wantWav) {
    if (m.kind === "text") return fail(res, 404, "Textnachricht: keine Audiodatei (siehe /api/voice/tts)");
    let file = m.file;
    if (wantWav && m.type !== "audio/wav") {
      if (!m.wavFile) return fail(res, 404, "WAV-Version nicht verfügbar (die Seite hat sie noch nicht abgelegt)");
      file = m.wavFile;
    }
    let st;
    try { st = fs.statSync(path.join(dir, file)); } catch (e) { return fail(res, 404, "Audiodatei nicht gefunden"); }
    if (m.from !== who.role && !m.deliveredAt) { m.deliveredAt = new Date(now()).toISOString(); saveIndex(); broadcast("update", meta(m)); }
    res.writeHead(200, { "Content-Type": file === m.file ? m.type : "audio/wav", "Content-Length": st.size, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    fs.createReadStream(path.join(dir, file)).pipe(res);
  }

  /** Die Seite legt die WAV-Version (8 kHz) ihrer Nachricht ab (das Gerät dekodiert kein WebM/Opus). */
  async function postWav(req, res, m, who) {
    if (!who.browser || m.from !== "page" || m.kind === "text") return fail(res, 403, "Nur für die Seite, für ihre Audionachrichten");
    if (String(req.headers["content-type"] || "").split(";")[0].trim().toLowerCase() !== "audio/wav") return fail(res, 415, "audio/wav attendu");
    const body = await readBody(req, res, maxBytes);
    if (!body) return;
    if (!sniff(body, "wav")) return fail(res, 400, "Der Inhalt ist keine WAV-Datei");
    const w = analyseWav(body);
    if (!w) return fail(res, 400, "Ungültige WAV-Datei (PCM erwartet)");
    if (w.duration > maxSeconds + 0.5) return fail(res, 413, "Nachricht zu lang (höchstens " + maxSeconds + " s)");
    m.wavFile = m.id + ".dev.wav";
    fs.writeFileSync(path.join(dir, m.wavFile), w.buf);
    saveIndex();
    log("Nachricht " + m.id + ": WAV-Version für das Gerät gespeichert (" + Math.round(w.buf.length / 1024) + " KB)");
    send(res, 200, meta(m));
  }

  function ack(res, m, who) {
    if (m.from !== who.role && !m.heardAt) {
      const t = new Date(now()).toISOString();
      m.heardAt = t;
      if (!m.deliveredAt) m.deliveredAt = t;
      saveIndex();
      log("Nachricht " + m.id + " angehört");
      broadcast("update", meta(m));
    }
    send(res, 200, meta(m));
  }

  async function route(req, res, ctx) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname.replace(/\/+$/, "");
    const who = authorize(req, ctx);
    if (who.error) return fail(res, who.error[0], who.error[1]);

    if (p === "/api/voice") {
      if (req.method === "POST") return postMessage(req, res, who);
      if (req.method === "GET") return listMessages(res, url, who);
      return fail(res, 405, "Methode nicht erlaubt");
    }
    if (p === "/api/voice/stream" && req.method === "GET") return streamEvents(req, res, url.searchParams.get("as") === "device");
    if (p === "/api/voice/notify" && req.method === "POST") {
      if (!who.browser) return fail(res, 403, "Nur für die Seite");
      const sent = index.messages.find((x) => x.id === Number(url.searchParams.get("id")));
      broadcast("notify", { at: new Date(now()).toISOString(), id: sent ? sent.id : null, kind: sent ? (sent.kind === "text" ? "text" : "voice") : null, text: sent && sent.kind === "text" ? sent.text : null, duration: sent ? sent.duration : 0 });
      log("Benachrichtigung zu Nachricht " + (sent ? sent.id : "?") + ": " + sensors.size + " simulierte(s) Gerät(e) verbunden, " + clients.size + " Abonnent(en) insgesamt");
      return send(res, 200, { ok: true, sensors: sensors.size });   // sensors: Anzahl der geöffneten simulierten Geräte (Sensor-Seite, Simulator)
    }
    if (p === "/api/voice/next" && req.method === "GET") {
      // Nächste Sprachnachricht der Seite, die das Gerät noch nicht angehört hat (die Firmware liest kein komplexes JSON)
      const next = index.messages.find((x) => x.from === "page" && x.kind !== "text" && !x.heardAt);
      if (!next) { res.writeHead(204, { "Cache-Control": "no-store" }); return res.end(); }
      return send(res, 200, { id: next.id, duration: next.duration });
    }
    if (p === "/api/voice/tts" && req.method === "GET") return speak(res, String(url.searchParams.get("text") || ""));
    const r = /^\/api\/voice\/(\d{1,9})\/(audio|ack|wav)$/.exec(p);
    if (r) {
      const m = index.messages.find((x) => x.id === Number(r[1]));
      if (!m) return fail(res, 404, "Nachricht nicht gefunden (gelöscht?)");
      if (r[2] === "audio" && req.method === "GET") return sendAudio(res, m, who, url.searchParams.get("format") === "wav");
      if (r[2] === "wav" && req.method === "POST") return postWav(req, res, m, who);
      if (r[2] === "ack" && req.method === "POST") return ack(res, m, who);
      return fail(res, 405, "Methode nicht erlaubt");
    }
    return fail(res, 404, "Route inconnue");
  }

  return {
    /** Wahr, wenn die angeforderte Adresse eine Route des Relays ist. */
    matches(req) { return /^\/api\/voice(\/|\?|$)/.test(req.url || ""); },
    /** Verarbeitet die Anfrage (die Antwort wird immer gesendet). */
    async handle(req, res, ctx) {
      if (!enabled) return fail(res, 503, "Sprachnachrichten deaktiviert (VOICE_ENABLED=0 in tools/voice.env)");
      try { await route(req, res, ctx || {}); } catch (e) {
        log("interner Fehler: " + e.message);
        if (!res.headersSent) fail(res, 500, "Interner Fehler des Sprach-Relays"); else res.end();
      }
    },
    purge,
    hasToken: () => !!token,
    close() { if (purgeTimer) clearInterval(purgeTimer); for (const c of clients) { try { c.end(); } catch (e) { /* geschlossen */ } } clients.clear(); }
  };
}

// ---------- Lauschen im lokalen Netz (VOICE_LAN=1) ----------
/** IPv4-Adressen dieses Computers im lokalen Netz. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  return out;
}

/**
 * Zweiter Server, im lokalen Netz geöffnet, der NUR das Sprach-Relay bedient (nie die Seite, nie die Geheimnisse)
 * und immer das Token verlangt. Liefert { server, port }; ist der Port belegt, wird der nächste versucht.
 */
function startLan(relay, port) {
  return new Promise((resolve, reject) => {
    let p = port;
    const attempt = () => {
      const server = http.createServer((req, res) => {
        if (relay.matches(req)) relay.handle(req, res, { lan: true });
        else { res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Introuvable"); }
      });
      server.once("error", (e) => { if (e.code === "EADDRINUSE" && p < port + 10) { p++; attempt(); } else reject(e); });
      server.listen(p, "0.0.0.0", () => resolve({ server, port: p }));
    };
    attempt();
  });
}

module.exports = { createRelay, settingsFromEnv, startLan, lanAddresses, analyseWav, ENV_FILE };
