#!/usr/bin/env node
/**
 * Kleiner lokaler Webserver (ohne Abhängigkeiten): liefert die Projektdateien aus, damit sich die Seite unter
 * http://localhost:8080/web/ öffnet (ersetzt „python -m http.server“).
 *
 * Sicherheit: lauscht nur auf der lokalen Schleife; verweigert versteckte Dateien (.git, .env …), die Geheimnisse
 * (sms-proxy.env, voice.env, Zähler), den Ordner data/ (Sprachnachrichten) und jeden Ausbruch aus dem Projektordner.
 * Kein Caching (Änderungen sind schon beim Neuladen sichtbar).
 * Liefert auch das Sprach-Relay aus (/api/voice, siehe tools/voice-relay.js).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".md": "text/markdown; charset=utf-8", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"
};

/** Wahr, wenn der angeforderte Pfad verboten ist (versteckte Dateien, Geheimnisse, technische Ordner). */
function forbidden(rel) {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p.startsWith(".") || p === "node_modules")) return true;
  if (parts[0] === "data") return true;   // Sprachaufnahmen: nur über das Relay zugänglich, nie als Datei
  const name = parts[parts.length - 1] || "";
  return /\.env$/i.test(name) || name === "sms-proxy.env" || name === ".sms-counter.json";
}

let relay = null;   // Sprach-Relay (beim Start erstellt, siehe tools/voice-relay.js)

function handler(req, res) {
  if (relay && relay.matches(req)) { relay.handle(req, res); return; }
  const send =(code, body, type) => { res.writeHead(code, { "Content-Type": type || "text/plain; charset=utf-8", "Cache-Control": "no-store" }); res.end(body); };
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Methode nicht erlaubt");
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, "http://localhost").pathname); } catch (e) { return send(400, "Ungültige Adresse"); }
  if (rel === "/") { res.writeHead(302, { Location: "/web/" }); return res.end(); }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT + path.sep) || forbidden(path.relative(ROOT, file))) return send(404, "Nicht gefunden");
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(404, "Nicht gefunden");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": st.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

/**
 * Startet den Server auf dem ersten freien Port ab `port`; gibt { server, port, voice } zurück.
 * Das Sprach-Relay wird hier eingehängt; mit VOICE_LAN=1 lauscht es auch im lokalen Netz (zweiter Port, Token erforderlich).
 */
async function start(port) {
  const voice = require("./voice-relay.js");
  const settings = voice.settingsFromEnv();
  relay = voice.createRelay({ dir: settings.dir, token: settings.token, retentionDays: settings.retentionDays, enabled: settings.enabled, log: (m) => console.log("[STIMME] " + m) });
  const result = await listen(port);
  result.voice = { enabled: settings.enabled, hasToken: relay.hasToken(), lan: null };
  if (settings.enabled && settings.lan) {
    if (!settings.token) console.warn("[STIMME] VOICE_LAN=1 ignoriert: kein Token (VOICE_DEVICE_TOKEN); starten Sie „node setup.js“.");
    else {
      const lan = await voice.startLan(relay, settings.lanPort);
      result.voice.lan = { port: lan.port, addresses: voice.lanAddresses() };
    }
  }
  return result;
}

function listen(port) {
  return new Promise((resolve, reject) => {
    let p = port;
    const tryListen = () => {
      const server = http.createServer(handler);
      server.once("error", (e) => {
        if (e.code === "EADDRINUSE" && p < port + 20) { p += 1; tryListen(); } else reject(e);
      });
      server.listen(p, "127.0.0.1", () => {
        // „localhost“ kann je nach Browser IPv6 (::1) bedeuten: Wir lauschen auch darauf (optional)
        const s6 = http.createServer(handler);
        s6.on("error", () => { /* IPv6 indisponible : IPv4 suffit */ });
        s6.listen(p, "::1");
        resolve({ server, port: p });
      });
    };
    tryListen();
  });
}

module.exports = { start, ROOT };

if (require.main === module) {
  const port = Number(process.argv[2]) || 8080;
  start(port).then(({ port: p }) => console.log("Webserver: http://localhost:" + p + "/web/")).catch((e) => { console.error("Server kann nicht gestartet werden:", e.message); process.exit(1); });
}
