#!/usr/bin/env node
/**
 * Starter: „node start.js“
 * Startet in einem Schritt den lokalen Webserver und das Programm für den SMS-Versand und öffnet dann die Seite im Browser.
 * Existiert die Konfiguration noch nicht, wird zuerst der Assistent gestartet („node setup.js“).
 * Beenden: Strg+C.
 *
 * Optionen: --no-open  Browser nicht öffnen      --port 8080  Port des Webservers
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = __dirname;
const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const WEB_PORT = portArg >= 0 ? Number(args[portArg + 1]) || 8080 : 8080;

if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error("Node.js 18 oder neuer ist erforderlich (Sie haben " + process.version + "). Installieren Sie es von https://nodejs.org");
  process.exit(1);
}

// 1. Erste Benutzung: Konfigurationsassistent
if (!fs.existsSync(path.join(ROOT, "web", "config.js"))) {
  console.log("Erste Benutzung: Konfiguration des Projekts.\n");
  const r = spawnSync(process.execPath, [path.join(ROOT, "setup.js")], { stdio: "inherit" });
  if (r.status !== 0 || !fs.existsSync(path.join(ROOT, "web", "config.js"))) { console.error("Die Konfiguration ist nicht abgeschlossen worden."); process.exit(1); }
}

(async () => {
  // 2. Serveur web local
  const { start } = require("./tools/serve.js");
  const { port, voice } = await start(WEB_PORT);
  const url = "http://localhost:" + port + "/web/";

  // 3. Programm für den SMS-Versand (eigener Prozess, Protokoll mit Präfix)
  const proxy = spawn(process.execPath, [path.join(ROOT, "tools", "sms-proxy.js")], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const relay = (stream) => stream.on("data", (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => console.log("[SMS] " + l)));
  relay(proxy.stdout); relay(proxy.stderr);
  proxy.on("exit", (code) => { if (code) console.log("[SMS] Das SMS-Versandprogramm wurde beendet (Code " + code + "). Die SMS-Alarme sind nicht verfügbar."); });

  console.log("\n  Geofencing LoRaWAN ist bereit.");
  console.log("  Seite:        " + url);
  console.log("  Simulator:    http://localhost:" + port + "/tools/simulate.html");
  console.log("  Beenden:      Strg+C in diesem Fenster");
  if (voice.enabled) {
    console.log("  Sprachnachrichten: aktiviert (lokale Speicherung in data/voice/)" + (voice.hasToken ? "" : "; ohne Gerätetoken: Starten Sie „node setup.js“, um eines zu erzeugen"));
    if (voice.lan) {
      console.log("\n  ACHTUNG - VOICE_LAN=1: Das Sprach-Relay lauscht auch im lokalen Netz (Port " + voice.lan.port + ").");
      console.log("  Jeder in diesem Netz, der das Token des Geräts kennt, kann dort Nachrichten ablegen oder lesen.");
      console.log("  Der Datenverkehr ist NICHT verschlüsselt (HTTP): Nutzen Sie nur ein vertrauenswürdiges Netz, nie ein öffentliches WLAN.");
      console.log("  Adresse(n) für das Gerät: " + (voice.lan.addresses.map((a) => "http://" + a + ":" + voice.lan.port).join("  ") || "(keine Netzwerkschnittstelle gefunden)"));
    }
  } else console.log("  Sprachnachrichten: deaktiviert (VOICE_ENABLED=0)");
  console.log("");

  // 4. Öffnen des Browsers
  if (!args.includes("--no-open")) {
    const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
    try { spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).on("error", () => console.log("  (öffnen Sie die obige Adresse in Ihrem Browser)")).unref(); } catch (e) { /* Öffnen nicht möglich */ }
  }

  const stop = () => { try { proxy.kill(); } catch (e) { /* bereits beendet */ } process.exit(0); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
})().catch((e) => { console.error("Start nicht möglich:", e.message); process.exit(1); });
