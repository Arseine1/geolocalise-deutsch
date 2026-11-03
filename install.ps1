<#
.SYNOPSIS
  Installation von Geofencing LoRaWAN mit einem einzigen Befehl (Windows PowerShell 5.1 oder neuer).

.DESCRIPTION
  Laedt das Projekt von GitHub herunter (git wird nicht benoetigt), prueft Node.js (und installiert es mit winget,
  wenn Sie zustimmen), startet den Konfigurationsassistenten und dann das Projekt.

  Befehl zum Kopieren in PowerShell:
    irm https://raw.githubusercontent.com/Arseine1/geolocalise-deutsch/main/install.ps1 | iex

  Aktualisierung: denselben Befehl erneut ausfuehren. Ihre Konfigurationsdateien (Schluessel, Nummern) bleiben erhalten.

.PARAMETER Repo      GitHub-Repository im Format konto/name. Standard: Arseine1/geolocalise-deutsch (oder Variable GEO_REPO).
.PARAMETER Branch    Herunterzuladender Branch (Standard: main).
.PARAMETER Dir       Installationsordner (Standard: %USERPROFILE%\geolocalise-deutsch).
.PARAMETER Source    Lokales ZIP-Archiv oder ZIP-Adresse, die statt GitHub verwendet wird (Tests).
.PARAMETER Token     Schreibgeschuetztes GitHub-Token, nur noetig, wenn das Repository PRIVAT ist (oder Variable GEO_TOKEN).
.PARAMETER NoStart   Das Projekt am Ende nicht starten.
.PARAMETER NonInteractive  Keine Fragen (Standardwerte oder Umgebungsvariablen, siehe setup.js).
#>
param(
  [string]$Repo = $(if ($env:GEO_REPO) { $env:GEO_REPO } else { "Arseine1/geolocalise-deutsch" }),
  [string]$Branch = $(if ($env:GEO_BRANCH) { $env:GEO_BRANCH } else { "main" }),
  [string]$Dir = $(if ($env:GEO_DIR) { $env:GEO_DIR } else { Join-Path $env:USERPROFILE "geolocalise-deutsch" }),
  [string]$Source = $env:GEO_SOURCE,
  [string]$Token = $env:GEO_TOKEN,
  [switch]$NoStart,
  [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Say($t)  { Write-Host $t -ForegroundColor Cyan }
function Ok($t)   { Write-Host ("  [OK] " + $t) -ForegroundColor Green }
function Warn($t) { Write-Host ("  [!]  " + $t) -ForegroundColor Yellow }
function Fail($t) { Write-Host ""; Write-Host ("  [FEHLER] " + $t) -ForegroundColor Red; Write-Host ""; exit 1 }
function Ask-YesNo($q) {
  if ($NonInteractive) { return $true }
  $a = Read-Host ($q + " (J/n)")
  return ($a -eq "" -or $a -match "^[jJyY]")
}

Write-Host ""
Say "=== Installation von Geofencing LoRaWAN ==="
Write-Host ""

# ---------- 1. Node.js ----------
Say "1/4  Node.js wird geprueft"
function Node-Version {
  try { $v = (& node --version) 2>$null; if ($v -match "^v(\d+)\.") { return [int]$Matches[1] } } catch { }
  return 0
}
$nodeMajor = Node-Version
if ($nodeMajor -lt 18) {
  if ($nodeMajor -gt 0) { Warn "Node.js $nodeMajor ist zu alt: Version 18 oder neuer ist erforderlich." } else { Warn "Node.js ist nicht installiert (es ist das einzige erforderliche Programm)." }
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget -and (Ask-YesNo "Node.js jetzt mit winget installieren?")) {
    & winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
    # Der PATH der Sitzung wird nicht automatisch aktualisiert: Wir laden ihn neu
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
    $nodeMajor = Node-Version
  }
  if ($nodeMajor -lt 18) { Fail "Installieren Sie Node.js (LTS-Version) von https://nodejs.org und fuehren Sie diesen Befehl dann erneut aus." }
}
Ok ("Node.js " + (& node --version))

# ---------- 2. Download ----------
Say "2/4  Projekt wird heruntergeladen"
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("geolocalise-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $tmp | Out-Null
$zip = Join-Path $tmp "projekt.zip"
try {
  if ($Source -and (Test-Path -LiteralPath $Source)) {
    Copy-Item -LiteralPath $Source -Destination $zip
  } else {
    $headers = @{}
    if ($Source) { $url = $Source }
    elseif ($Token) {
      # Privates Repository: GitHub-API mit einem schreibgeschuetzten Token
      $url = "https://api.github.com/repos/$Repo/zipball/$Branch"
      $headers = @{ Authorization = "Bearer $Token"; Accept = "application/vnd.github+json" }
    } else { $url = "https://github.com/$Repo/archive/refs/heads/$Branch.zip" }
    Write-Host ("  " + $url)
    try { Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing -Headers $headers }
    catch { Fail ("Download nicht moeglich: " + $_.Exception.Message + "`n       Pruefen Sie die Internetverbindung. Ist das GitHub-Repository '" + $Repo + "' PRIVAT, brauchen Sie ein Lese-Token (Variable GEO_TOKEN) oder muessen das Repository oeffentlich machen: Ein Fehler 404 bedeutet oft, dass das Repository privat ist.") }
  }
  Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $tmp "x") -Force
  $inner = Get-ChildItem -LiteralPath (Join-Path $tmp "x") -Directory | Select-Object -First 1
  if (-not $inner) { Fail "Das heruntergeladene Archiv ist leer oder nicht lesbar." }

  # ---------- 3. Kopieren (vorhandene Konfiguration bleibt erhalten) ----------
  Say "3/4  Installation in $Dir"
  $update = Test-Path -LiteralPath (Join-Path $Dir "start.js")
  if ($update) { Warn "Es besteht bereits eine Installation: Aktualisierung (Ihre Schluessel und Nummern bleiben erhalten)." }
  New-Item -ItemType Directory -Path $Dir -Force | Out-Null
  & robocopy $inner.FullName $Dir /E /XF config.js sms-proxy.env voice.env secrets.h .sms-counter.json sms-recipients.json /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { Fail "Das Kopieren der Dateien ist fehlgeschlagen (Code $LASTEXITCODE)." }
  Ok "Dateien installiert."
} finally {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------- 4. Konfiguration und Start ----------
Say "4/4  Konfiguration"
Push-Location $Dir
try {
  $setupArgs = @("setup.js")
  if ($NonInteractive) { $setupArgs += "--yes" }
  if ($update -or $NonInteractive) { } # setup.js beruehrt vorhandene Dateien nicht, ohne zu fragen
  & node @setupArgs
  if ($LASTEXITCODE -ne 0) { Fail "Der Konfigurationsassistent ist fehlgeschlagen." }
  Write-Host ""
  Ok "Installation abgeschlossen in: $Dir"
  Write-Host ""
  Write-Host "  Zum spaeteren Neustart: Doppelklick auf Starten.bat in diesem Ordner," -ForegroundColor Gray
  Write-Host "  oder in PowerShell:  cd `"$Dir`" ; node start.js" -ForegroundColor Gray
  Write-Host ""
  if (-not $NoStart -and -not $NonInteractive) {
    if (Ask-YesNo "Projekt jetzt starten?") { & node start.js }
  }
} finally { Pop-Location }
