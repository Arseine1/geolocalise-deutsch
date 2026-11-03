@echo off
rem Doppelklick startet Geofencing LoRaWAN (Webserver + SMS-Alarme + Browser).
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ist nicht installiert. Installieren Sie die LTS-Version von https://nodejs.org und starten Sie diese Datei dann erneut.
  pause
  exit /b 1
)
node start.js
pause
