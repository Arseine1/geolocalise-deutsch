#!/usr/bin/env node
/**
 * Konfigurationsassistent (ohne Abhängigkeiten): „node setup.js“
 *
 * Stellt einige Fragen und legt die lokalen Konfigurationsdateien an, die von git ausgeschlossen sind:
 *   - web/config.js          (Seite: Zugangsdaten für The Things Stack)
 *   - tools/sms-proxy.env    (SMS-Alarme: Vonage-Zugangsdaten, Nummern)
 *   - tools/voice.env        (Sprachnachrichten: Token des Geräts, lokales Netz, Aufbewahrungsdauer)
 * Eingegebene Geheimnisse werden nie angezeigt und bleiben auf diesem Computer.
 *
 * Optionen:  --force  legt die Dateien auch neu an, wenn sie schon existieren
 *            --yes    Modus ohne Fragen (Standardwerte oder Umgebungsvariablen, siehe unten)
 * Im Modus --yes (oder ohne Terminal) gelesene Umgebungsvariablen:
 *   TTI_HOST, TTI_TENANT, APP_ID, DEVICE_ID, WEBHOOK_ID, TTI_API_KEY, SMS_PROXY_PORT,
 *   VONAGE_API_KEY, VONAGE_API_SECRET, SMS_TO, SMS_FROM, PATIENT_LABEL,
 *   VOICE_ENABLED, VOICE_LAN, VOICE_RETENTION_DAYS, VOICE_DEVICE_TOKEN
 */
"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const crypto = require("crypto");

const ROOT = __dirname;
const CONFIG = path.join(ROOT, "web", "config.js");
const CONFIG_EXAMPLE = path.join(ROOT, "web", "config.example.js");
const ENV_FILE = path.join(ROOT, "tools", "sms-proxy.env");
const ENV_EXAMPLE = path.join(ROOT, "tools", "sms-proxy.env.example");
const VOICE_FILE = path.join(ROOT, "tools", "voice.env");
const VOICE_EXAMPLE = path.join(ROOT, "tools", "voice.env.example");
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const AUTO = args.includes("--yes") || !process.stdin.isTTY;   // ohne interaktives Terminal: keine Fragen

if (Number(process.versions.node.split(".")[0]) < 18) {
  console.error("Node.js 18 oder neuer ist erforderlich (Sie haben " + process.version + "). Installieren Sie es von https://nodejs.org");
  process.exit(1);
}

// ---------- Fragen ----------
const rl = AUTO ? null : readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let muted = false;
if (rl) { const w = rl._writeToOutput; rl._writeToOutput = function (s) { if (muted && s !== "\r\n" && s !== "\n") return; w.call(rl, s); }; }

function ask(question, def) {
  if (AUTO) return Promise.resolve(def);
  return new Promise((resolve) => rl.question(question + (def ? " [" + def + "] " : " "), (a) => resolve(a.trim() || def || "")));
}
function askSecret(question) {
  if (AUTO) return Promise.resolve("");
  return new Promise((resolve) => {
    muted = true;
    rl.question(question + " (Eingabe verdeckt, Enter zum Überspringen) ", (a) => { muted = false; process.stdout.write("\n"); resolve(a.trim()); });
  });
}
async function yesNo(question, def) {
  if (AUTO) return def;
  const a = (await ask(question + (def ? " (J/n)" : " (j/N)"), "")).toLowerCase();
  if (!a) return def;
  return a.startsWith("j") || a.startsWith("y");
}

// ---------- Hilfsfunktionen ----------
const envOr = (name, def) => (process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : def);
function setConst(text, name, value) {
  const re = new RegExp("^(const " + name + " = )(\"[^\"]*\"|\\d+)(;)", "m");
  if (!re.test(text)) throw new Error("Zeile „const " + name + "“ in web/config.example.js nicht gefunden");
  const literal = typeof value === "number" ? String(value) : JSON.stringify(value);
  return text.replace(re, (m, a, b, c) => a + literal + c);
}
function setEnv(text, key, value) {
  // [ \t]* und nicht \s*: \s* würde den vorherigen Zeilenumbruch verschlucken und die Einstellung an einen Kommentar kleben
  const re = new RegExp("^#?[ \\t]*" + key + "=.*$", "m");
  return re.test(text) ? text.replace(re, () => key + "=" + value) : text.replace(/\s*$/, "\n") + key + "=" + value + "\n";
}
/** Normalisiert eine eingegebene Nummer („+49 151 2345-6789“, „0049 151 …“) zu reinen Ziffern mit Vorwahl, oder null. */
function normalizePhone(s) {
  let d = String(s).replace(/[\s().-]/g, "").replace(/^\+/, "");
  if (d.startsWith("00")) d = d.slice(2);
  return /^\d{7,15}$/.test(d) && !d.startsWith("0") ? d : null;
}

(async () => {
  console.log("\n=== Konfigurationsassistent: Geofencing LoRaWAN ===\n");
  if (AUTO) console.log("(Modus ohne Fragen: Standardwerte oder Umgebungsvariablen)\n");

  // ----- 1. Webseite: The Things Stack -----
  let doConfig = true;
  if (fs.existsSync(CONFIG) && !FORCE) {
    doConfig = await yesNo("web/config.js existiert schon. Neu erstellen?", false);
    if (!doConfig) console.log("→ web/config.js beibehalten.\n");
  }
  if (doConfig) {
    console.log("1/3  Verbindung zu The Things Stack (der Plattform, die die Positionen empfängt)");
    console.log("     Drücken Sie Enter, um den in eckigen Klammern vorgeschlagenen Wert zu behalten.\n");
    let tpl = fs.readFileSync(CONFIG_EXAMPLE, "utf8");
    const host = await ask("Adresse Ihres The-Things-Stack-Bereichs", envOr("TTI_HOST", "team-global.eu1.cloud.thethings.industries"));
    const tenant = await ask("Name des Bereichs (Tenant)", envOr("TTI_TENANT", "team-global"));
    const app = await ask("Anwendung", envOr("APP_ID", "myfirst1"));
    const dev = await ask("Gerät (Device)", envOr("DEVICE_ID", "heltec-gps-01"));
    const hook = await ask("Webhook (für den Downlink)", envOr("WEBHOOK_ID", "geofence-web"));
    let key = AUTO ? envOr("TTI_API_KEY", "") : await askSecret("API-Schlüssel The Things Stack");
    if (!key) {
      key = "TA-CLE-API";
      console.log("     → Kein Schlüssel eingegeben: Die Seite öffnet sich, der Demo-Modus funktioniert, aber der echte Empfang ist deaktiviert.");
      console.log("       Starten Sie „node setup.js --force“ erneut, sobald Sie den Schlüssel haben.\n");
    }
    const port = Number(envOr("SMS_PROXY_PORT", "3001")) || 3001;
    for (const [n, v] of [["TTI_HOST", host], ["TTI_TENANT", tenant], ["APP_ID", app], ["DEVICE_ID", dev], ["WEBHOOK_ID", hook], ["API_KEY", key], ["SMS_PROXY_PORT", port]]) tpl = setConst(tpl, n, v);
    fs.writeFileSync(CONFIG, tpl);
    console.log("✔ web/config.js erstellt.\n");
  }

  // ----- 2. Vonage-SMS -----
  let doEnv = true;
  if (fs.existsSync(ENV_FILE) && !FORCE) {
    doEnv = await yesNo("tools/sms-proxy.env existiert schon. Neu erstellen?", false);
    if (!doEnv) console.log("→ tools/sms-proxy.env beibehalten.\n");
  }
  if (doEnv) {
    console.log("2/3  SMS-Alarme (Vonage): optional. Ohne sie werden SMS nur angezeigt (Testmodus).\n");
    let env = fs.readFileSync(ENV_EXAMPLE, "utf8");
    const wantSms = AUTO ? Boolean(process.env.VONAGE_API_KEY) : await yesNo("SMS jetzt einrichten?", false);
    if (wantSms) {
      const vk = AUTO ? envOr("VONAGE_API_KEY", "") : await askSecret("Vonage: API key");
      const vs = AUTO ? envOr("VONAGE_API_SECRET", "") : await askSecret("Vonage: API secret");
      let to = null;
      while (!to) {
        const raw = await ask("Nummer, die die SMS erhält, mit Landesvorwahl (z. B. +49 151 2345 6789)", envOr("SMS_TO", ""));
        if (!raw) { console.log("     → Keine Nummer: Die SMS bleiben im Testmodus.\n"); break; }
        to = normalizePhone(raw);
        if (!to) { if (AUTO) { console.log("     → Ungültige Nummer, ignoriert."); break; } console.log("     Ungültige Nummer. Geben Sie sie vollständig mit Vorwahl ein (z. B. +49 151 2345 6789)."); }
      }
      const from = await ask("Absendername (höchstens 11 Zeichen)", envOr("SMS_FROM", "Geofence"));
      const who = await ask("Wie soll die überwachte Person in den SMS bezeichnet werden?", envOr("PATIENT_LABEL", "Ihr Patient"));
      env = setEnv(env, "VONAGE_API_KEY", vk); env = setEnv(env, "VONAGE_API_SECRET", vs);
      env = setEnv(env, "SMS_TO", to || ""); env = setEnv(env, "SMS_FROM", from); env = setEnv(env, "PATIENT_LABEL", who);
    } else {
      env = setEnv(env, "SMS_TO", "");
    }
    env = setEnv(env, "SMS_PROXY_PORT", String(Number(envOr("SMS_PROXY_PORT", "3001")) || 3001));
    fs.writeFileSync(ENV_FILE, env);
    console.log("✔ tools/sms-proxy.env erstellt.\n");
  }

  // ----- 3. Sprachnachrichten -----
  let doVoice = true;
  if (fs.existsSync(VOICE_FILE) && !FORCE) {
    doVoice = await yesNo("tools/voice.env existiert schon. Neu erstellen?", false);
    if (!doVoice) console.log("→ tools/voice.env beibehalten.\n");
  }
  if (doVoice) {
    console.log("3/3  Sprachnachrichten zwischen Seite und Gerät (optional; das Audio bleibt auf diesem Computer)\n");
    let env = fs.readFileSync(VOICE_EXAMPLE, "utf8");
    const enabled = await yesNo("Sprachnachrichten aktivieren?", envOr("VOICE_ENABLED", "1") !== "0");
    let lan = false, days = 7;
    if (enabled) {
      lan = await yesNo("Sprach-Relay für das lokale Netz öffnen (nur für ein echtes Gerät per WLAN)?", /^(1|true|ja)$/i.test(envOr("VOICE_LAN", "0")));
      const d = Number(await ask("Aufbewahrungsdauer der Aufnahmen in Tagen", envOr("VOICE_RETENTION_DAYS", "7")));
      days = d > 0 ? Math.round(d) : 7;
    }
    // Das Token des Geräts wird hier erzeugt und nie angezeigt: Es steht in tools/voice.env
    const token = envOr("VOICE_DEVICE_TOKEN", crypto.randomBytes(24).toString("hex"));
    env = setEnv(env, "VOICE_ENABLED", enabled ? "1" : "0");
    env = setEnv(env, "VOICE_DEVICE_TOKEN", token);
    env = setEnv(env, "VOICE_LAN", lan ? "1" : "0");
    env = setEnv(env, "VOICE_RETENTION_DAYS", String(days));
    fs.writeFileSync(VOICE_FILE, env);
    console.log("✔ tools/voice.env erstellt" + (enabled ? " (das Token des Geräts ist dort gespeichert; in firmware/.../secrets.h übernehmen)." : " (Sprachnachrichten deaktiviert).") + "\n");
  }

  console.log("Konfiguration abgeschlossen.");
  console.log("Zum Starten des Projekts:  node start.js   (oder Doppelklick auf Starten.bat unter Windows)\n");
  if (rl) rl.close();
})().catch((e) => { console.error("\nFehler: " + e.message); if (rl) rl.close(); process.exit(1); });
