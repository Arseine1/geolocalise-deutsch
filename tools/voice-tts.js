/**
 * LOKALE Sprachsynthese (ohne Abhängigkeiten): wandelt einen Text in ein WAV (8 kHz, 16 Bit, mono) um, das das Gerät abspielen kann.
 * Die Engine ist die des Systems (kein Online-Dienst, der Text verlässt den Computer nicht):
 *   Windows : System.Speech (SAPI), deutsche Stimme, wenn installiert, sonst die Standardstimme
 *   macOS   : Befehl „say“ (Stimme Anna, falls vorhanden)
 *   Linux   : „espeak-ng“ oder „espeak“ (muss installiert werden)
 * Ohne Engine schlägt synthesize() mit einer klaren Meldung fehl, und das Relay antwortet 501.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

/** WAV PCM 16 Bit (beliebige Frequenz, mono oder stereo) -> WAV 8 kHz mono. Gibt null zurück, wenn das Format nicht unterstützt wird. */
function toWav8k(buf) {
  if (buf.length < 44 || buf.toString("latin1", 0, 4) !== "RIFF") return null;
  let pos = 12, ch = 0, rate = 0, bits = 0, start = -1, end = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString("latin1", pos, pos + 4), size = buf.readUInt32LE(pos + 4);
    if (id === "fmt ") { ch = buf.readUInt16LE(pos + 10); rate = buf.readUInt32LE(pos + 12); bits = buf.readUInt16LE(pos + 22); }
    else if (id === "data") { start = pos + 8; end = Math.min(buf.length, start + size); break; }
    pos += 8 + size + (size & 1);
  }
  if (start < 0 || bits !== 16 || !rate || ch < 1) return null;
  const frames = Math.floor((end - start) / (2 * ch));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i++) { let v = 0; for (let c = 0; c < ch; c++) v += buf.readInt16LE(start + (i * ch + c) * 2); mono[i] = v / ch; }
  const n = Math.max(1, Math.floor(frames * 8000 / rate));
  const out = Buffer.alloc(44 + n * 2);
  for (let i = 0; i < n; i++) {
    // Mittelwert über das Quellfenster: einfacher Filter gegen Spiegelfrequenzen
    const a = i * rate / 8000, b = Math.min(frames, Math.max(a + 1, (i + 1) * rate / 8000));
    let sum = 0, cnt = 0;
    for (let k = Math.floor(a); k < Math.ceil(b) && k < frames; k++) { sum += mono[k]; cnt++; }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(cnt ? sum / cnt : 0))), 44 + i * 2);
  }
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 2, 4); out.write("WAVE", 8); out.write("fmt ", 12);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(8000, 24); out.writeUInt32LE(16000, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(n * 2, 40);
  return out;
}

/** Startet ein Programm (Text auf der Standardeingabe); scheitert nach 20 s oder bei einem Fehlercode. */
function runTool(cmd, args, input, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env: env || process.env, windowsHide: true, stdio: ["pipe", "ignore", "ignore"] });
    const timer = setTimeout(() => { p.kill(); reject(new Error("Zeitüberschreitung")); }, 20000);
    p.on("error", () => { clearTimeout(timer); reject(new Error(cmd + " nicht gefunden")); });
    p.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(cmd + ": Code " + code)); });
    p.stdin.on("error", () => { /* das Programm hat seine Eingabe nicht gelesen: unwichtig */ });
    p.stdin.end(input || "");
  });
}

// Windows: Der Text läuft über eine Umgebungsvariable, nie über die Befehlszeile (keine Einschleusung möglich)
const PS_TTS = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
  "try { $s.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::NotSet, [System.Speech.Synthesis.VoiceAge]::NotSet, 0, [System.Globalization.CultureInfo]::GetCultureInfo('de-DE')) } catch { }; " +
  "$s.SetOutputToWaveFile($env:VOICE_TTS_OUT); $s.Speak($env:VOICE_TTS_TEXT); $s.Dispose()";

/** Text -> WAV 8 kHz mono mit der Sprach-Engine des Systems. `dir`: temporärer Ordner (die Zwischendatei wird gelöscht). */
async function synthesize(text, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "tts-" + crypto.randomBytes(6).toString("hex") + ".wav");
  try {
    if (process.platform === "win32") {
      await runTool("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PS_TTS], "", Object.assign({}, process.env, { VOICE_TTS_TEXT: text, VOICE_TTS_OUT: tmp }));
    } else if (process.platform === "darwin") {
      try { await runTool("say", ["-v", "Anna", "-o", tmp, "--data-format=LEI16@22050", "-f", "-"], text); }
      catch (e) { await runTool("say", ["-o", tmp, "--data-format=LEI16@22050", "-f", "-"], text); }
    } else {
      try { await runTool("espeak-ng", ["-v", "de", "-w", tmp, "--stdin"], text); }
      catch (e) { await runTool("espeak", ["-v", "de", "-w", tmp, "--stdin"], text); }
    }
    const wav = toWav8k(fs.readFileSync(tmp));
    if (!wav) throw new Error("Audioformat der Sprach-Engine nicht unterstützt");
    return wav;
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* nicht vorhanden */ } }
}

module.exports = { synthesize, toWav8k };
