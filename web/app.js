/**
 * Geofencing-LoRaWAN-Demo – Logik der Seite (reines HTML/JS, ohne Build).
 * Abhängig von: Leaflet (L), MQTT.js (mqtt) und window.CONFIG (config.js).
 */
(function () {
  "use strict";

  // ---------- Konstanten ----------
  const TRAIL_MAX = 5000;            // maximale Anzahl der für die Strecke gespeicherten Positionen
  const TRAIL_SEGMENTS_MAX = 200;    // darüber wird die Linie ausgedünnt (jeder k-te Punkt), damit alles flüssig bleibt
  const TRAIL_DOTS_MAX = 80;         // einzelne Punkte werden nur gezeichnet, wenn es wenige sind
  const TRAIL_STORAGE_KEY = "geofence-trail-window-v1";   // angezeigte Dauer, im Browser gespeichert
  const HYSTERESIS_M = 5;            // Hysterese der Erkennung (Meter)
  const DOWNLINK_MIN_MS = 60000;     // höchstens ein Downlink-Versand alle 60 s
  const LOG_MAX = 200;               // im Protokoll behaltene Zeilen
  const MIN_VERTICES = 3;            // Mindestanzahl der Punkte für eine Zone
  const ZONE_STORAGE_KEY = "geofence-zone-v1";   // im Browser gespeicherte Zone (gemeinsam mit simulate.html)
  const SHAPE_NAMES = { 3: "Dreieck", 4: "Viereck", 5: "Fünfeck", 6: "Sechseck", 7: "Siebeneck", 8: "Achteck", 9: "Neuneck", 10: "Zehneck" };
  const COLOR_IN = "#2e9e4f", COLOR_OUT = "#d62d2d", COLOR_UNKNOWN = "#3b82f6";

  const $ = (id) => document.getElementById(id);
  const cfg = window.CONFIG;

  // ---------- Protokoll ----------
  /** Fügt oben im Protokoll eine Zeile mit Zeitstempel hinzu (textContent: keine HTML-Einschleusung möglich). */
  function log(message, level) {
    const li = document.createElement("li");
    const t = document.createElement("span");
    t.className = "t";
    t.textContent = new Date().toLocaleTimeString("de-DE");
    const m = document.createElement("span");
    m.className = level || "";
    m.textContent = message;
    li.append(t, m);
    const ol = $("log");
    ol.prepend(li);
    while (ol.children.length > LOG_MAX) ol.lastChild.remove();
  }

  /** Aktualisiert das Kopfzeilen-Abzeichen und die MQTT-Zeile der Seitenleiste. */
  function setMqttStatus(text, kind) {
    const badge = $("mqtt-badge");
    badge.textContent = (cfg && cfg.RECEIVE_MODE === "mqtt" ? "MQTT" : "Datenstrom") + ": " + text;
    badge.className = "badge badge-" + (kind || "off");
    $("p-mqtt").textContent = text;
  }

  // ---------- Prüfungen beim Start ----------
  if (!cfg) {
    setMqttStatus("config.js nicht gefunden", "err");
    log("config.js fehlt oder ist ungültig: Legen Sie web/config.js an (siehe Kopf der Datei).", "err");
    return;
  }
  if (typeof L === "undefined") {
    setMqttStatus("Leaflet nicht geladen", "err");
    log("Leaflet konnte nicht vom CDN geladen werden (Internetverbindung?).", "err");
    return;
  }

  // ---------- Zustand ----------
  let zonePoints = [];       // GPS-Punkte der Zone in Eingabereihenfolge (L.LatLng)
  let autoOrder = true;      // Punkte nach Winkel um die Mitte verbinden (vermeidet Überkreuzungen)
  let editing = false;       // Bearbeitungsmodus der Zone (außerhalb ist die Zone statisch)
  let center = L.latLng(cfg.DEFAULT_CENTER[0], cfg.DEFAULT_CENTER[1]);   // Mitte der Zone (Mittelwert der Punkte)
  let lastPos = null;        // letzte Position (L.LatLng)
  let lastTime = null;       // Uhrzeit der letzten Position (Date)
  let inside = null;         // true / false, null = unbekannt
  let trail = [];            // frühere Positionen: { p: L.LatLng, t: Uhrzeit in ms }
  let demo = false;          // Offline-Demo-Modus

  // ---------- Karte ----------
  const map = L.map("map").setView(center, 15);
  // Konfigurierbarer Kartenhintergrund (config.js: TILE_URL, TILE_SUBDOMAINS, TILE_ATTRIBUTION)
  const tiles = L.tileLayer(cfg.TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    subdomains: cfg.TILE_SUBDOMAINS !== undefined ? cfg.TILE_SUBDOMAINS : "abc",
    attribution: cfg.TILE_ATTRIBUTION || "&copy; Mitwirkende von <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a>"
  }).addTo(map);
  // Lehnt der Kachelserver die Anfragen ab (z. B. 403 „Access blocked“), melden wir das nur einmal
  let tileErrorShown = false;
  tiles.on("tileerror", () => {
    if (tileErrorShown) return;
    tileErrorShown = true;
    log("Die Kartenkacheln konnten nicht geladen werden (Kachelserver gesperrt oder offline?). Ändern Sie TILE_URL in config.js und drücken Sie dann Strg+F5.", "warn");
  });

  // Die Höhe der Karte folgt der rechten Seitenleiste (die mit den Texten variiert): Leaflet muss benachrichtigt werden
  // Solange der Benutzer die Karte nicht berührt hat, bleibt die Zone eingerahmt: Der anfängliche Ausschnitt kann berechnet werden,
  // bevor die Karte ihre endgültige Größe hat (Layout, Schriften), was die Zone winzig ließ
  // und die Kacheln nur um sie herum geladen wurden.
  let userMoved = false;
  ["pointerdown", "wheel", "touchstart"].forEach((ev) => $("map").addEventListener(ev, () => { userMoved = true; }, { passive: true }));
  function fitZone() {
    if (zonePoints.length) map.fitBounds(L.latLngBounds(zonePoints), { padding: [40, 40], maxZoom: 17, animate: false });
  }
  function refreshMapSize() {
    map.invalidateSize();
    if (!userMoved) fitZone();
  }
  if (window.ResizeObserver) new ResizeObserver(refreshMapSize).observe($("map"));
  window.addEventListener("load", refreshMapSize);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refreshMapSize);

  const zonePoly = L.polygon([], { color: COLOR_UNKNOWN, weight: 3, fillOpacity: 0.15 }).addTo(map);
  const zoneHint = L.polyline([], { color: COLOR_UNKNOWN, weight: 2, dashArray: "6 6" }).addTo(map);   // vorläufige Linie (1 oder 2 Punkte)
  const vertexLayer = L.layerGroup().addTo(map);   // nummerierte Markierungen der Zonenpunkte
  const trailLayer = L.layerGroup().addTo(map);   // Strecke des Sensors (Segmente, Punkte)

  // ---------- Strecke des Sensors ----------
  // Die Segmente sind orange mit weißem Rand; je älter, desto durchsichtiger:
  // So ist die Bewegungsrichtung ablesbar. Die angezeigte Dauer wird in der Seitenleiste eingestellt (10 s bis „gesamte Strecke“).
  let trailWindowS = 0;      // 0 = gesamte Strecke
  let trailSig = "";         // Signatur der letzten Zeichnung (vermeidet unnötiges Neuzeichnen)

  function fmtDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + " s";
    if (s < 3600) return Math.floor(s / 60) + " min " + String(s % 60).padStart(2, "0") + " s";
    return Math.floor(s / 3600) + " h " + String(Math.floor((s % 3600) / 60)).padStart(2, "0") + " min";
  }

  function trailPoints() {
    if (!trailWindowS) return trail;
    const limit = Date.now() - trailWindowS * 1000;
    return trail.filter((e) => e.t >= limit);
  }

  /** Zeichnet die Strecke des gewählten Zeitraums. force = true zeichnet auch dann neu, wenn sich nichts geändert hat. */
  function renderTrail(force) {
    const pts = trailPoints();
    const now = Date.now();
    // Zusammenfassung unter der Auswahl (bei jedem Aufruf aktualisiert: das Alter ändert sich mit der Zeit)
    let dist = 0;
    for (let i = 1; i < pts.length; i++) dist += map.distance(pts[i - 1].p, pts[i].p);
    $("p-trail-info").textContent = pts.length
      ? pts.length + (pts.length > 1 ? " Positionen" : " Position") + " · " + Math.round(dist) + " m zurückgelegt · seit " + fmtDuration(now - pts[0].t)
      : "Keine Position in diesem Zeitraum.";

    const sig = pts.length + "|" + (pts.length ? pts[0].t + "|" + pts[pts.length - 1].t : "");
    if (!force && sig === trailSig) return;
    trailSig = sig;

    trailLayer.clearLayers();
    if (!pts.length) return;

    // Ausdünnung: höchstens TRAIL_SEGMENTS_MAX gezeichnete Segmente
    let draw = pts;
    if (pts.length > TRAIL_SEGMENTS_MAX + 1) {
      const k = Math.ceil(pts.length / TRAIL_SEGMENTS_MAX);
      draw = pts.filter((e, i) => i % k === 0 || i === pts.length - 1);
    }
    const n = draw.length - 1;
    for (let i = 0; i < n; i++) {
      const a = draw[i].p, b = draw[i + 1].p;
      const op = 0.6 + 0.4 * ((i + 1) / n);   // neu = deckend, alt etwas blasser (die Linie bleibt lesbar)
      L.polyline([a, b], { color: "#ffffff", weight: 9, opacity: op * 0.85, lineCap: "round", interactive: false }).addTo(trailLayer);
      L.polyline([a, b], { color: "#f97316", weight: 5, opacity: op, lineCap: "round", interactive: false }).addTo(trailLayer);
    }
    // Punkte: Uhrzeit beim Darüberfahren; der erste (Beginn des angezeigten Zeitraums) ist grün
    if (pts.length <= TRAIL_DOTS_MAX) {
      pts.forEach((e, i) => {
        const first = i === 0 && pts.length > 1;
        L.circleMarker(e.p, { radius: first ? 6 : 4, color: "#ffffff", weight: 2, fillColor: first ? "#22a45d" : "#f97316", fillOpacity: 1 })
          .bindTooltip((first ? (trailWindowS ? "Beginn des Zeitraums · " : "Start · ") : "") + new Date(e.t).toLocaleTimeString("de-DE"))
          .addTo(trailLayer);
      });
    }
  }

  /** Speichert die gewählte Dauer (wenn der Browser es erlaubt) und zeichnet neu. */
  function setTrailWindow(seconds) {
    trailWindowS = seconds;
    try { localStorage.setItem(TRAIL_STORAGE_KEY, String(seconds)); } catch (e) { /* Speicher nicht verfügbar */ }
    renderTrail(true);
  }
  $("trail-window").addEventListener("change", (e) => setTrailWindow(Number(e.target.value)));
  $("btn-trail-clear").addEventListener("click", () => { trail = []; renderTrail(true); log("Strecke gelöscht.", ""); });
  try {
    const saved = Number(localStorage.getItem(TRAIL_STORAGE_KEY));
    if (Number.isFinite(saved) && Array.from($("trail-window").options).some((o) => Number(o.value) === saved)) {
      trailWindowS = saved;
      $("trail-window").value = String(saved);
    }
  } catch (e) { /* Speicher nicht verfügbar: standardmäßig „gesamte Strecke“ */ }
  setInterval(() => renderTrail(false), 1000);   // zu alte Positionen verlassen den angezeigten Zeitraum
  // Sensor: verschiebbare Markierung (nur im Demo-Modus aktiv) mit einem runden Symbol in CSS
  const marker = L.marker(center, {
    draggable: false,
    zIndexOffset: 1000,   // der Sensor bleibt über den Zonenpunkten
    icon: L.divIcon({ className: "sensor-icon", iconSize: [22, 22], iconAnchor: [11, 11] }),
    title: "Sensor (im Demo-Modus ziehen)"
  });
  // Den Sensor mit der Maus ziehen = neue simulierte Position, laufend ausgewertet
  marker.on("drag", (e) => {
    if (demo) handlePosition(e.latlng.lat, e.latlng.lng, new Date(), "Maus");
  });
  // Das Loslassen der Taste erzeugt einen Klick auf die Karte: Wir ignorieren ihn, um nicht versehentlich einen Punkt hinzuzufügen
  let lastDragEnd = 0;
  marker.on("dragend", () => { lastDragEnd = Date.now(); });

  function fmtLatLng(p) { return p.lat.toFixed(6) + ", " + p.lng.toFixed(6); }

  // ---------- Zone: durch GPS-Punkte definiertes Polygon ----------
  // 3 Punkte = Dreieck, 4 = Viereck, 5 = Fünfeck usw. Das Polygon entsteht, indem die Punkte
  // in automatischer Reihenfolge (Winkel um die Mitte) verbunden werden; das ergibt eine Form ohne Überkreuzung, egal in welcher Reihenfolge eingegeben wurde.

  const toXY = (p, ref) => ({ x: (p.lng - ref.lng) * 111320 * Math.cos(ref.lat * Math.PI / 180), y: (p.lat - ref.lat) * 110574 });

  function validPoint(a) {
    return Array.isArray(a) && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Math.abs(a[0]) <= 90 && Math.abs(a[1]) <= 180;
  }

  function centroidOf(pts) {
    let la = 0, ln = 0;
    pts.forEach((p) => { la += p.lat; ln += p.lng; });
    return L.latLng(la / pts.length, ln / pts.length);
  }

  /** Ring des Polygons: nach Winkel um die Mitte sortierte Punkte (automatische Reihenfolge) oder Eingabereihenfolge. */
  function orderedRing() {
    if (!autoOrder || zonePoints.length < 4) return zonePoints.slice();
    const c = centroidOf(zonePoints);
    const k = Math.cos(c.lat * Math.PI / 180);
    const ang = (p) => Math.atan2(p.lat - c.lat, (p.lng - c.lng) * k);
    return zonePoints.slice().sort((a, b) => ang(a) - ang(b));
  }

  /** Wahr, wenn sich zwei nicht benachbarte Seiten kreuzen (nur mit der Eingabereihenfolge möglich). */
  function hasSelfIntersection(ring) {
    const ref = centroidOf(ring);
    const xy = ring.map((p) => toXY(p, ref));
    const n = xy.length;
    const ccw = (a, b, c) => (c.y - a.y) * (b.x - a.x) - (b.y - a.y) * (c.x - a.x);
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        if (j === i + 1 || (i === 0 && j === n - 1)) continue;   // benachbarte Seiten
        const a = xy[i], b = xy[(i + 1) % n], c = xy[j], d = xy[(j + 1) % n];
        if (ccw(a, c, d) * ccw(b, c, d) < 0 && ccw(a, b, c) * ccw(a, b, d) < 0) return true;
      }
    }
    return false;
  }

  function distToSegment(a, b) {   // Abstand vom Ursprung zur Strecke [a, b]
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    let t = l2 ? (-a.x * dx - a.y * dy) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(a.x + t * dx, a.y + t * dy);
  }

  /** Vorzeichenbehafteter Abstand zum Polygonrand in Metern: positiv innen, negativ außen. */
  function signedDistanceM(pos) {
    const pts = orderedRing().map((p) => toXY(p, pos));   // die Position ist der Ursprung (0, 0)
    let insideRing = false, best = Infinity;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      // Strahlwurf nach +x: Wir zählen die gekreuzten Seiten
      if ((a.y > 0) !== (b.y > 0) && ((b.x - a.x) * (0 - a.y) / (b.y - a.y) + a.x) > 0) insideRing = !insideRing;
      best = Math.min(best, distToSegment(a, b));
    }
    return insideRing ? best : -best;
  }

  function zoneIsValid() { return zonePoints.length >= MIN_VERTICES; }

  /** Beschreibung: „Viereck (4 Punkte)“, Warnung, wenn sich die Seiten kreuzen. */
  function zoneInfoText() {
    const n = zonePoints.length;
    if (n === 0) return "Kein Punkt. Klicken Sie auf „Zone bearbeiten“ und dann auf die Karte, um Punkte zu setzen.";
    if (n < MIN_VERTICES) return n + (n > 1 ? " Punkte" : " Punkt") + ": Für eine Zone sind mindestens " + MIN_VERTICES + " nötig.";
    let t = (SHAPE_NAMES[n] || n + "-Eck") + " (" + n + " Punkte)";
    if (hasSelfIntersection(orderedRing())) t += " ⚠ Seiten kreuzen sich: Aktivieren Sie die automatische Reihenfolge.";
    return t;
  }

  function vertexIcon(i) {
    return L.divIcon({ className: "vertex-icon" + (editing ? " editing" : ""), html: "<span>" + (i + 1) + "</span>", iconSize: [24, 24], iconAnchor: [12, 12] });
  }

  /** Speichert die Zone im Browser (gemeinsam mit tools/simulate.html, gleicher Ursprung). */
  function saveZone() {
    try {
      localStorage.setItem(ZONE_STORAGE_KEY, JSON.stringify({ points: zonePoints.map((p) => [p.lat, p.lng]), auto: autoOrder }));
    } catch (e) { /* Speicher nicht verfügbar: Die Zone gilt nur für diese Sitzung */ }
  }

  /** Vom Benutzer gespeicherte Zone, sonst die aus config.js (DEFAULT_ZONE), sonst ein Quadrat um DEFAULT_CENTER. */
  function loadZone() {
    try {
      const s = JSON.parse(localStorage.getItem(ZONE_STORAGE_KEY) || "null");
      if (s && Array.isArray(s.points) && s.points.every(validPoint)) return { points: s.points, auto: s.auto !== false };
    } catch (e) { /* unlesbare Daten: ignorieren */ }
    return defaultZone();
  }

  function defaultZone() {
    if (Array.isArray(cfg.DEFAULT_ZONE) && cfg.DEFAULT_ZONE.every(validPoint)) return { points: cfg.DEFAULT_ZONE, auto: true };
    const c = cfg.DEFAULT_CENTER, r = Number(cfg.DEFAULT_RADIUS) || 500;
    const dLat = r / 111320, dLng = r / (111320 * Math.cos(c[0] * Math.PI / 180));
    return { points: [[c[0] + dLat, c[1] - dLng], [c[0] + dLat, c[1] + dLng], [c[0] - dLat, c[1] + dLng], [c[0] - dLat, c[1] - dLng]], auto: true };
  }

  /** Zeichnet die Zone neu. rebuild = true erstellt die nummerierten Markierungen neu (Hinzufügen, Löschen, Bearbeitungsmodus). */
  function renderZone(rebuild) {
    const ring = orderedRing();
    if (zonePoints.length) center = centroidOf(zonePoints);
    zonePoly.setLatLngs(zoneIsValid() ? ring : []);
    zoneHint.setLatLngs(!zoneIsValid() && zonePoints.length > 1 ? zonePoints : []);

    if (rebuild) {
      vertexLayer.clearLayers();
      zonePoints.forEach((p, i) => {
        const m = L.marker(p, { icon: vertexIcon(i), draggable: editing, keyboard: false, title: "Punkt " + (i + 1) });
        m.on("drag", (e) => { zonePoints[i] = e.latlng; renderZone(false); });
        m.on("dragend", () => { lastDragEnd = Date.now(); saveZone(); });
        m.on("contextmenu", () => { if (editing) removePoint(i); });   // Rechtsklick = Punkt löschen
        vertexLayer.addLayer(m);
      });
    }

    $("p-zone-info").textContent = zoneInfoText();
    $("p-zone-info").classList.toggle("warn", zoneIsValid() && hasSelfIntersection(ring));
    const ta = $("zone-points");
    if (document.activeElement !== ta) ta.value = zonePoints.map(fmtLatLng).join("\n");
    evaluate();
    scheduleCenterPlace();
  }

  function addPoint(latlng) {
    zonePoints.push(latlng);
    saveZone();
    log("Punkt " + zonePoints.length + " hinzugefügt: " + fmtLatLng(latlng), "");
    renderZone(true);
  }

  function removePoint(i) {
    zonePoints.splice(i, 1);
    saveZone();
    log("Punkt " + (i + 1) + " gelöscht (" + zonePoints.length + (zonePoints.length === 1 ? " verbleibend" : " verbleibende") + ").", "");
    renderZone(true);
  }

  /** Ersetzt alle Punkte (Import, Zurücksetzen) und passt den Kartenausschnitt an. */
  function setZone(points, auto, why) {
    zonePoints = points.map((a) => L.latLng(a[0], a[1]));
    autoOrder = auto;
    $("opt-auto-order").checked = auto;
    inside = null;   // neue Zone: Der Zustand innen / außen wird neu berechnet
    saveZone();
    renderZone(true);
    userMoved = false;   // eine neue Zone wird eingerahmt
    fitZone();
    log(why + ": " + zonePoints.length + (zonePoints.length > 1 ? " Punkte" : " Punkt") + ".", "ok");
  }

  /** Liest „Breitengrad, Längengrad“ Zeile für Zeile (Trennzeichen: Komma, Semikolon, Leerzeichen, Tabulator). */
  function parsePoints(text) {
    const pts = [], bad = [];
    text.split(/\r?\n/).forEach((line, idx) => {
      const s = line.trim();
      if (!s) return;
      const parts = s.split(/[;,\s]+/).filter(Boolean).map(Number);
      if (parts.length === 2 && validPoint(parts)) pts.push(parts);
      else bad.push(idx + 1);
    });
    return { pts, bad };
  }

  /** Schaltet den Bearbeitungsmodus ein oder aus: außerhalb dieses Modus ist die Zone statisch. */
  function setEditing(on) {
    editing = on;
    $("btn-edit").textContent = on ? "Bearbeitung beenden" : "Zone bearbeiten";
    $("btn-edit").classList.toggle("on", on);
    ["btn-undo", "btn-clear", "btn-apply", "btn-reset", "opt-auto-order"].forEach((id) => { $(id).disabled = !on; });
    $("zone-points").readOnly = !on;
    $("edit-hint").hidden = !on;
    $("map").classList.toggle("editing", on);
    renderZone(true);
  }

  map.on("click", (e) => {
    if (!editing || Date.now() - lastDragEnd < 400) return;   // Zone ist außerhalb des Bearbeitungsmodus statisch
    addPoint(e.latlng);
  });
  $("btn-edit").addEventListener("click", () => setEditing(!editing));
  $("btn-undo").addEventListener("click", () => { if (zonePoints.length) removePoint(zonePoints.length - 1); });
  $("btn-clear").addEventListener("click", () => {
    zonePoints = [];
    inside = null;
    saveZone();
    log("Alle Punkte der Zone wurden gelöscht.", "warn");
    renderZone(true);
  });
  $("btn-apply").addEventListener("click", () => {
    const { pts, bad } = parsePoints($("zone-points").value);
    if (bad.length) { log("Ungültige Koordinaten, Zeilen: " + bad.join(", ") + " (Format „48.8566, 2.3522“). Es wurde nichts übernommen.", "err"); return; }
    setZone(pts, autoOrder, "Koordinaten übernommen");
  });
  $("btn-reset").addEventListener("click", () => { const d = defaultZone(); setZone(d.points, d.auto, "Standardzone (config.js) wiederhergestellt"); });
  $("opt-auto-order").addEventListener("change", (e) => { autoOrder = e.target.checked; saveZone(); inside = null; renderZone(true); });

  // ---------- Aus einer Adresse gezeichnete Zone (Nominatim /search) + Radius ----------
  // Die eingegebene Adresse wird an Nominatim (OpenStreetMap) gesendet; die Zone ist ein Polygon aus 24 Punkten um den gefundenen Punkt.
  const NOMINATIM_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
  const ADDR_RADIUS_MIN = 50, ADDR_RADIUS_MAX = 5000, CIRCLE_POINTS = 24;
  let addrCenter = null;   // [lat, lng] des zuletzt gefundenen Punkts

  function circleZone(c, radius) {
    const dLat = radius / 111320, dLng = radius / (111320 * Math.cos(c[0] * Math.PI / 180));
    const pts = [];
    for (let i = 0; i < CIRCLE_POINTS; i++) {
      const a = (2 * Math.PI * i) / CIRCLE_POINTS;
      pts.push([c[0] + dLat * Math.sin(a), c[1] + dLng * Math.cos(a)]);
    }
    return pts;
  }
  function addrRadius() {
    const r = Number($("addr-radius").value);
    return Number.isFinite(r) ? Math.min(ADDR_RADIUS_MAX, Math.max(ADDR_RADIUS_MIN, Math.round(r))) : 500;
  }
  /** Zeichnet die Zone um den gefundenen Punkt mit dem gewählten Radius (neu). */
  function applyAddrZone(why) {
    if (!addrCenter) return;
    setZone(circleZone(addrCenter, addrRadius()), true, why + " (Radius " + addrRadius() + " m)");
  }
  function chooseAddr(item) {
    addrCenter = [item.lat, item.lng];
    $("addr-result").textContent = "Punkt gesetzt: " + item.name;
    applyAddrZone("Zone um die Adresse gezeichnet");
  }

  async function searchAddress(q) {
    const btn = $("btn-addr"), out = $("addr-result"), box = $("addr-choices");
    box.textContent = "";
    btn.disabled = true;
    out.textContent = "Suche läuft …";
    try {
      const url = NOMINATIM_SEARCH_URL + "?format=jsonv2&limit=5&accept-language=de&q=" + encodeURIComponent(q);
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const list = (await r.json()).map((o) => ({ lat: Number(o.lat), lng: Number(o.lon), name: String(o.display_name || "") }))
        .filter((o) => validPoint([o.lat, o.lng]));
      if (!list.length) { out.textContent = "Adresse nicht gefunden. Fügen Sie die Stadt oder das Land hinzu."; return; }
      chooseAddr(list[0]);
      if (list.length > 1) {
        const lab = document.createElement("span");
        lab.className = "hint";
        lab.textContent = "Weitere Ergebnisse:";
        box.append(lab);
        list.slice(1).forEach((o) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn-secondary";
          b.textContent = o.name;
          b.addEventListener("click", () => chooseAddr(o));
          box.append(b);
        });
      }
    } catch (e) {
      out.textContent = "Suche nicht möglich: " + e.message + " (Internetverbindung?).";
    } finally {
      btn.disabled = false;
    }
  }
  $("addr-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("addr-input").value.trim();
    if (q.length < 3) { $("addr-result").textContent = "Geben Sie mindestens 3 Zeichen ein."; return; }
    searchAddress(q);
  });
  // Radius: Feld und Regler bleiben synchron und zeichnen die Zone neu, sobald ein Punkt gesetzt ist
  function onRadius(src) {
    const r = src === "range" ? Number($("addr-radius-range").value) : addrRadius();
    $("addr-radius").value = r;
    $("addr-radius-range").value = r;
    if (addrCenter) applyAddrZone("Radius geändert");
  }
  $("addr-radius").addEventListener("change", () => onRadius("num"));
  $("addr-radius-range").addEventListener("input", () => onRadius("range"));

  // ---------- Echte Orte: Adresse, Stadt (Nominatim) und Kreuzung (Overpass) ----------
  // Diese beiden öffentlichen OpenStreetMap-Dienste erhalten die Koordinaten des Sensors: siehe docs/PROJEKTERKLAERUNG.md.
  const NOMINATIM_URL = "https://nominatim.openstreetmap.org/reverse";
  const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
  const GEO_MIN_MS = 1100;            // Nominatim: höchstens 1 Anfrage pro Sekunde
  const GEO_MOVE_M = 25;              // die Adresse wird erst nach 25 m Bewegung erneut abgefragt
  const JUNCTION_MIN_MS = 8000;       // Overpass: höchstens eine Anfrage alle 8 s
  const JUNCTION_MOVE_M = 40;
  const JUNCTION_RADIUS_M = 150;      // Kreuzungen werden im Umkreis von 150 m gesucht
  const geoCache = new Map();         // „lat,lng“ auf 4 Nachkommastellen gerundet (~11 m) -> Text
  let geoChain = Promise.resolve();   // Warteschlange: jeweils nur eine Nominatim-Anfrage
  let geoLastAt = 0;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  /** Formatiert eine Nominatim-Adresse: „Straße Nr. - Viertel · PLZ Ort · Land“. */
  function formatPlace(data) {
    const a = data.address || {};
    const road = [a.house_number, a.road || a.pedestrian || a.footway || a.path || a.cycleway].filter(Boolean).join(" ");
    const area = a.neighbourhood || a.city_block || a.suburb || a.quarter;
    const city = a.city || a.town || a.village || a.municipality || a.county;
    const line2 = [area, [a.postcode, city].filter(Boolean).join(" "), a.country].filter(Boolean).join(" · ");
    return [road, line2].filter(Boolean).join(" - ") || data.display_name || "unbekannter Ort";
  }

  /** Umgekehrte Geokodierung mit Zwischenspeicher und begrenzter Taktung; die Promise wird bei einem Netzwerkfehler abgelehnt. */
  function geocode(lat, lng) {
    const key = lat.toFixed(4) + "," + lng.toFixed(4);
    if (geoCache.has(key)) return Promise.resolve(geoCache.get(key));
    const job = geoChain.then(async () => {
      const wait = geoLastAt + GEO_MIN_MS - Date.now();
      if (wait > 0) await sleep(wait);
      geoLastAt = Date.now();
      const url = NOMINATIM_URL + "?format=jsonv2&addressdetails=1&zoom=18&accept-language=de&lat=" + lat + "&lon=" + lng;
      const r = await fetch(url);
      if (!r.ok) throw new Error("HTTP " + r.status);
      const text = formatPlace(await r.json());
      geoCache.set(key, text);
      return text;
    });
    geoChain = job.catch(() => {});   // ein Fehler blockiert die folgenden Anfragen nicht
    return job;
  }

  /**
   * Sucht die nächste Kreuzung anhand der Overpass-Antwort (benannte Straßen um den Punkt):
   * eine Kreuzung ist ein Knoten, den mindestens zwei Straßen mit verschiedenen Namen teilen.
   * Gibt { names, dist } oder null zurück.
   */
  function nearestJunction(osm, pos) {
    const nodes = {};
    const namesAt = {};
    (osm.elements || []).forEach((e) => { if (e.type === "node") nodes[e.id] = e; });
    (osm.elements || []).forEach((e) => {
      if (e.type !== "way" || !e.tags || !e.tags.name) return;
      e.nodes.forEach((id) => { (namesAt[id] = namesAt[id] || new Set()).add(e.tags.name); });
    });
    let best = null;
    Object.keys(namesAt).forEach((id) => {
      if (namesAt[id].size < 2 || !nodes[id]) return;
      const d = map.distance(pos, L.latLng(nodes[id].lat, nodes[id].lon));
      if (d <= JUNCTION_RADIUS_M && (!best || d < best.dist)) best = { names: Array.from(namesAt[id]).slice(0, 3), dist: d };
    });
    return best;
  }

  let junctionLastPos = null, junctionLastAt = 0;

  async function updateJunction(pos, seq) {
    if (junctionLastPos && map.distance(junctionLastPos, pos) < JUNCTION_MOVE_M) return;
    if (Date.now() - junctionLastAt < JUNCTION_MIN_MS) return;
    junctionLastPos = pos;
    junctionLastAt = Date.now();
    const q = "[out:json][timeout:10];way(around:" + JUNCTION_RADIUS_M + "," + pos.lat + "," + pos.lng +
      ")[highway][name];out body;>;out skel qt;";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(OVERPASS_URL + "?data=" + encodeURIComponent(q), { signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = nearestJunction(await r.json(), pos);
      if (seq !== placeSeq) return;   // veraltete Antwort
      $("p-junction").textContent = j
        ? j.names.join(" × ") + " (in " + Math.round(j.dist) + " m)"
        : "keine Kreuzung im Umkreis von " + JUNCTION_RADIUS_M + " m";
    } catch (e) {
      if (seq === placeSeq) $("p-junction").textContent = "nicht verfügbar (" + (e.name === "AbortError" ? "Zeitüberschreitung" : e.message) + ")";
    } finally {
      clearTimeout(timer);
    }
  }

  let placeSeq = 0, placeTimer = null, placeLastPos = null;

  /** Plant die Suche nach dem Ort des Sensors (wartet 0,7 s ohne Bewegung, nützlich beim Ziehen). */
  function schedulePlace() {
    if (placeTimer) clearTimeout(placeTimer);
    placeTimer = setTimeout(updatePlace, 700);
  }

  async function updatePlace() {
    placeTimer = null;
    if (!lastPos) return;
    const pos = lastPos;
    const seq = ++placeSeq;
    if (!placeLastPos || map.distance(placeLastPos, pos) >= GEO_MOVE_M) {
      placeLastPos = pos;
      $("p-place").textContent = "Suche …";
      try {
        const text = await geocode(pos.lat, pos.lng);
        if (seq === placeSeq) $("p-place").textContent = text;
      } catch (e) {
        if (seq === placeSeq) $("p-place").textContent = "nicht verfügbar (" + e.message + ")";
      }
    }
    updateJunction(pos, seq);
  }

  let centerTimer = null;
  function scheduleCenterPlace() {
    if (centerTimer) clearTimeout(centerTimer);
    centerTimer = setTimeout(async () => {
      centerTimer = null;
      const c = center;
      try {
        const text = await geocode(c.lat, c.lng);
        if (c === center) $("p-center-place").textContent = "Ort: " + text;
      } catch (e) {
        if (c === center) $("p-center-place").textContent = "Ort der Mitte nicht verfügbar (" + e.message + ")";
      }
    }, 700);
  }

  // ---------- Ton (Web Audio API) ----------
  // Chrome verbietet den Ton, solange der Benutzer nicht auf DIESE Seite geklickt hat (die Seite neu laden oder nur
  // in einem anderen Tab wie simulate.html klicken genügt nicht): Der Tonstatus wird daher ständig angezeigt.
  let audioCtx = null;
  let pendingBeep = null;   // letzter angeforderter Piepton, während der Ton blockiert war: wird nach der Freigabe wiedergegeben

  function audioRunning() { return !!audioCtx && audioCtx.state === "running"; }

  /** Aktualisiert die „Ton“-Anzeige der Kopfzeile, die Schaltfläche in den Optionen und den Hinweis im Alarmbanner. */
  function updateSoundUi() {
    const ok = audioRunning();
    const pill = $("sound-pill");
    pill.textContent = ok ? "🔊 Ton aktiv" : "🔇 Ton aus: hier klicken";
    pill.className = "sound-pill " + (ok ? "sound-on" : "sound-off");
    $("btn-sound").textContent = ok ? "Ton aktiv ✓" : "Ton aktivieren";
    $("btn-sound").classList.toggle("on", ok);
    $("alert-sound-hint").hidden = ok;
  }

  /** Erstellt / entsperrt den Audiokontext. Aus einer Benutzergeste heraus aufrufen (Klick, Taste). */
  async function unlockAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { log("Web Audio API in diesem Browser nicht verfügbar.", "err"); return false; }
      audioCtx = new Ctx();
      audioCtx.onstatechange = updateSoundUi;   // der Browser kann den Ton auch später wieder anhalten
    }
    try { await audioCtx.resume(); } catch (e) { log("Ton vom Browser blockiert: " + e.message, "err"); }
    updateSoundUi();
    if (!audioRunning()) return false;
    // Während der Ton blockiert war, lief ein Alarm: Wir melden ihn jetzt
    if (pendingBeep) {
      const p = pendingBeep;
      pendingBeep = null;
      if (!$(p.bannerId).hidden) beep(p.n, p.freq);
    }
    return true;
  }

  // Die Schaltfläche in den Optionen und die Anzeige in der Kopfzeile aktivieren den Ton und spielen einen Test-Piepton
  async function soundButton() {
    if (await unlockAudio()) { beep(1); log("Ton aktiviert (Test-Piepton).", "ok"); }
    else log("Der Ton konnte nicht aktiviert werden (PC-Lautstärke, stummgeschalteter Tab oder Chrome-Einstellung).", "err");
  }
  $("btn-sound").addEventListener("click", soundButton);
  $("sound-pill").addEventListener("click", soundButton);

  // Entsperrt den Ton auch beim ersten Klick oder der ersten Taste irgendwo auf der Seite;
  // die Listener bleiben bestehen, solange der Ton nicht wirklich aktiv ist.
  function autoUnlock() {
    unlockAudio().then((ok) => {
      if (ok) {
        document.removeEventListener("pointerdown", autoUnlock);
        document.removeEventListener("keydown", autoUnlock);
      }
    });
  }
  document.addEventListener("pointerdown", autoUnlock);
  document.addEventListener("keydown", autoUnlock);
  updateSoundUi();

  /**
   * Spielt n Pieptöne (standardmäßig 880 Hz); ist der Ton blockiert, wird das deutlich gemeldet (Anzeige, Banner, Protokoll)
   * und der Piepton wird wiederholt, sobald der Benutzer auf die Seite klickt.
   */
  function beep(n, freq) {
    if (!audioRunning()) {
      pendingBeep = { n: n, freq: freq, bannerId: freq ? "return-banner" : "alert-banner" };
      updateSoundUi();
      log("Kein Ton: Chrome blockiert ihn, solange Sie nicht auf diese Seite geklickt haben. Klicken Sie irgendwo (oder auf „Ton aus“).", "warn");
      return;
    }
    for (let i = 0; i < n; i++) {
      const start = audioCtx.currentTime + i * 0.35;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = freq || 880;   // 880 Hz = Austritts-Alarm; höher für die Rückkehr
      gain.gain.setValueAtTime(0.4, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(start);
      osc.stop(start + 0.3);
    }
  }

  // ---------- Virtuelle LED ----------
  let ledOn = false;
  function applyLed(on) {
    ledOn = on;
    $("led").classList.toggle("on", on);
    $("led-text").textContent = on ? "an (Downlink 0x01 gesendet)" : "aus";
  }

  // ---------- SMS-Alarme (über den kleinen lokalen Proxy tools/sms-proxy.js) ----------
  // Die Seite hat weder den Vonage-Schlüssel noch die Nummern: Sie meldet dem Proxy nur „Austritt“ oder „Rückkehr“ mit der Position.
  const SMS_URL = String(cfg.SMS_PROXY_URL || "").replace(/\/$/, "");
  const SMS_STORAGE_KEY = "geofence-sms-v2";   // v2: Die Rückkehr-SMS ist standardmäßig aktiviert

  // „localhost“ kann je nach Browser 127.0.0.1 (IPv4) oder ::1 (IPv6) bedeuten: Antwortet die konfigurierte Adresse nicht,
  // probiert die Seite die beiden anderen aus und merkt sich die, die funktioniert.
  const SMS_BASES = (() => {
    if (!SMS_URL) return [];
    let port = "";
    try { port = new URL(SMS_URL).port; } catch (e) { return [SMS_URL]; }
    const list = [SMS_URL];
    if (port) list.push("http://127.0.0.1:" + port, "http://[::1]:" + port);
    return Array.from(new Set(list));
  })();
  let smsBase = SMS_BASES[0];

  /** Ruft den Proxy auf; opts ist eine Funktion (das Zeitlimit muss bei jedem Versuch neu erstellt werden). */
  async function smsFetch(path, opts) {
    let lastErr;
    for (const base of [smsBase].concat(SMS_BASES.filter((b) => b !== smsBase))) {
      try {
        const r = await fetch(base + path, opts());
        smsBase = base;
        return r;
      } catch (e) { lastErr = e; }
    }
    throw lastErr;
  }

  const smsErrorText = (e) => (e && e.name === "TimeoutError" ? "Zeitüberschreitung" : (e && e.message) || String(e));

  /** Zeigt den Status des Proxys: verbunden (Testmodus oder echt, verbleibende SMS) oder offline, mit der Ursache. */
  async function refreshSmsStatus() {
    const el = $("p-sms-status");
    if (!SMS_URL) { el.textContent = "Deaktiviert: SMS_PROXY_URL ist in config.js leer."; el.className = "hint sms-off"; return; }
    try {
      const r = await smsFetch("/health", () => ({ cache: "no-store", signal: AbortSignal.timeout(3000) }));
      const j = await r.json();
      el.textContent = "Proxy verbunden · " + (j.dryRun ? "TESTMODUS (keine echte SMS gesendet)" : j.recipients + " Empfänger, " + j.remainingToday + "/" + j.dailyMax + " SMS heute übrig");
      el.className = "hint " + (j.dryRun ? "sms-test" : "sms-ok");
    } catch (e) {
      const where = location.protocol === "file:"
        ? "Seite als einfache Datei geöffnet: öffnen Sie stattdessen http://localhost:8080/web/"
        : "Seite geöffnet auf " + location.origin;
      el.textContent = "Proxy offline (" + smsErrorText(e) + ") · " + where + " · starten Sie „node tools/sms-proxy.js“ im Projektordner.";
      el.className = "hint sms-off";
    }
  }

  // ----- Empfängernummern (vom Proxy verwaltet; die Seite sieht nur die letzten 3 Ziffern) -----
  function renderNumbers(j) {
    const ul = $("sms-numbers");
    ul.textContent = "";
    j.numbers.forEach((n, i) => {
      const li = document.createElement("li");
      const t = document.createElement("span");
      t.textContent = "+ " + n;
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-secondary";
      b.textContent = "Entfernen";
      b.disabled = j.numbers.length < 2;
      b.title = j.numbers.length < 2 ? "Fügen Sie zuerst die neue Nummer hinzu und entfernen Sie dann diese" : "";
      b.addEventListener("click", () => editNumbers({ action: "remove", index: i }));
      li.append(t, b);
      ul.append(li);
    });
    if (!j.numbers.length) { const li = document.createElement("li"); li.textContent = "Keine Nummer: Testmodus."; ul.append(li); }
    $("btn-sms-add").disabled = j.numbers.length >= j.max;
  }
  async function loadNumbers() {
    if (!SMS_URL) return;
    try {
      const r = await smsFetch("/recipients", () => ({ cache: "no-store", signal: AbortSignal.timeout(3000) }));
      if (r.ok) renderNumbers(await r.json());
    } catch (e) { /* Proxy offline: Der Status wird weiter oben schon angezeigt */ }
  }
  async function editNumbers(body) {
    const msg = $("sms-num-msg");
    try {
      const r = await smsFetch("/recipients", () => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { msg.textContent = "Nicht gespeichert: " + (j.error || "HTTP " + r.status); msg.className = "hint sms-off"; return; }
      renderNumbers(j);
      msg.textContent = body.action === "add" ? "Nummer hinzugefügt: Sie erhält die nächsten Alarme." : "Nummer entfernt.";
      msg.className = "hint sms-ok";
      log(msg.textContent, "ok");
      $("sms-add-input").value = "";
      refreshSmsStatus();
    } catch (e) {
      msg.textContent = "SMS-Proxy nicht erreichbar (" + smsErrorText(e) + "): Starten Sie „node tools/sms-proxy.js“.";
      msg.className = "hint sms-off";
    }
  }
  $("sms-add-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("sms-add-input").value.trim();
    if (!/^\+?[\d\s().-]{7,20}$/.test(v)) { $("sms-num-msg").textContent = "Ungültige Nummer: nur Ziffern, mit Landesvorwahl (z. B. +49 151 2345 6789)."; $("sms-num-msg").className = "hint sms-off"; return; }
    editNumbers({ action: "add", number: v });
  });

  /** Zeigt das Ergebnis des letzten Versands direkt unter der Schaltfläche (sichtbar, ohne bis zum Protokoll zu scrollen) und im Protokoll. */
  function smsResult(text, level) {
    const el = $("p-sms-result");
    el.textContent = text;
    el.className = "hint " + (level === "ok" ? "sms-ok" : level === "err" ? "sms-off" : "sms-test");
    log(text, level);
  }

  /** Fordert beim Proxy den Versand einer SMS an und protokolliert das Ergebnis. event: "exit", "return" oder "test". */
  async function sendSms(event, distanceM, first, retry) {
    if (!SMS_URL) { smsResult("SMS deaktiviert: SMS_PROXY_URL ist in config.js leer.", "warn"); return; }
    const body = { event: event };
    if (lastPos) { body.lat = lastPos.lat; body.lng = lastPos.lng; }
    if (Number.isFinite(distanceM)) body.distanceM = distanceM;
    if (first) body.first = true;   // erste Position bereits außerhalb der Zone: Die SMS sagt „befindet sich außerhalb seiner Zone“
    const btn = $("btn-sms-test");
    if (event === "test") { btn.disabled = true; btn.textContent = "Wird gesendet …"; smsResult("Test-SMS wird gesendet …", "warn"); }
    try {
      const r = await smsFetch("/alert", () => ({
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
      }));
      const j = await r.json().catch(() => ({}));
      if (j.dryRun) smsResult("SMS im Testmodus (nichts wird gesendet): " + j.text, "warn");
      else if (r.ok && j.ok) {
        smsResult("SMS von Vonage für " + j.results.length + " Empfänger angenommen · " + j.remainingToday + " heute übrig. Zustellprüfung in 15 s …", "ok");
        scheduleDeliveryCheck(0);
      }
      else if (r.status === 429 && event !== "test" && /zu kurz nacheinander/.test(j.error || "") && !retry) {
        // Schutz des Proxys (eine SMS alle 30 s): Der Alarm geht nicht verloren, er wird gesendet, sobald die Wartezeit abgelaufen ist
        const wait = (Number((/(\d+) s/.exec(j.error) || [])[1]) || 30) + 1;
        smsResult("SMS „" + (event === "exit" ? "Austritt" : "Rückkehr") + "“ um " + wait + " s verzögert (Limit: eine SMS alle 30 s).", "warn");
        setTimeout(() => {
          const stillTrue = event === "exit" ? inside === false : inside === true;
          if (stillTrue) sendSms(event, distanceM, first, true);
          else log("SMS „" + (event === "exit" ? "Austritt" : "Rückkehr") + "“ abgebrochen: Die Lage hat sich inzwischen geändert.", "warn");
        }, wait * 1000);
      }
      else smsResult("SMS nicht gesendet (HTTP " + r.status + "): " + (j.error || JSON.stringify(j.results || j).slice(0, 250)), "err");
    } catch (e) {
      smsResult("SMS-Proxy nicht erreichbar (" + smsErrorText(e) + ") von " + location.origin + " aus: Starten Sie „node tools/sms-proxy.js“.", "err");
    } finally {
      btn.disabled = false;
      btn.textContent = "Test-SMS senden";
    }
    refreshSmsStatus();
  }

  /** Bei jedem Alarm aufgerufen: beachtet die Kontrollkästchen und sendet im Demo-Modus nichts Echtes. */
  function maybeSendSms(event, distanceM, first) {
    if (event === "exit" && !$("opt-sms").checked) return;
    if (event === "return" && !$("opt-sms-return").checked) return;
    if (demo) { log("[DEMO] Simulierte SMS: " + (event === "exit" ? "Zone verlassen" : "Rückkehr in die Zone") + " (nichts wird gesendet).", "warn"); return; }
    sendSms(event, distanceM, first);
  }

  /**
   * „Angenommen“ von Vonage heißt nicht „empfangen“: Die Nachricht kann danach noch abgelehnt werden (gesperrtes Land, Absender
   * abgelehnt …). Nach jedem echten Versand fragt die Seite daher das Vonage-Protokoll ab (über den Proxy) und zeigt das tatsächliche
   * Ergebnis unter der Test-Schaltfläche. Gibt "ok", "err" oder "pending" zurück (noch keine Antwort des Netzbetreibers).
   */
  async function checkSmsDelivery() {
    try {
      const r = await smsFetch("/delivery", () => ({ cache: "no-store", signal: AbortSignal.timeout(15000) }));
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) { smsResult("Zustellung: Prüfung nicht möglich (" + (j.error || "HTTP " + r.status) + ").", "err"); return "err"; }
      if (!j.records.length) { smsResult("Zustellung: Vonage hat noch keinen Versand erfasst (das Protokoll kann einige Minuten nachhinken).", "warn"); return "pending"; }
      const last = j.records[0];
      const delivered = last.errorCode === "0" || last.status === "delivered";
      const state = delivered ? "ok" : last.errorCode ? "err" : "pending";
      smsResult("Zustellung der letzten SMS (Absender „" + last.from + "“): " + last.explanation +
        (last.errorCode && last.errorCode !== "0" ? " [Code " + last.errorCode + "]" : ""), state === "ok" ? "ok" : state === "err" ? "err" : "warn");
      return state;
    } catch (e) {
      smsResult("Zustellung: Proxy nicht erreichbar (" + smsErrorText(e) + ").", "err");
      return "err";
    }
  }

  let deliveryTimer = null;
  /** Prüft die Zustellung 15 s nach dem Versand, dann noch zweimal (30 s Abstand), solange der Netzbetreiber nicht geantwortet hat. */
  function scheduleDeliveryCheck(attempt) {
    clearTimeout(deliveryTimer);
    deliveryTimer = setTimeout(async () => {
      const state = await checkSmsDelivery();
      if (state === "pending" && attempt < 2) scheduleDeliveryCheck(attempt + 1);
    }, attempt === 0 ? 15000 : 30000);
  }

  $("btn-sms-test").addEventListener("click", () => sendSms("test"));
  function saveSmsPrefs() {
    try { localStorage.setItem(SMS_STORAGE_KEY, JSON.stringify({ exit: $("opt-sms").checked, back: $("opt-sms-return").checked })); } catch (e) { /* Speicher nicht verfügbar */ }
  }
  $("opt-sms").addEventListener("change", saveSmsPrefs);
  $("opt-sms-return").addEventListener("change", saveSmsPrefs);
  try {
    const p = JSON.parse(localStorage.getItem(SMS_STORAGE_KEY) || "null");
    if (p) { $("opt-sms").checked = p.exit !== false; $("opt-sms-return").checked = p.back !== false; }
  } catch (e) { /* Einstellungen unlesbar: Standardwerte */ }
  setInterval(refreshSmsStatus, 30000);
  refreshSmsStatus();
  loadNumbers();

  // ---------- Zonenerkennung ----------
  /**
   * Vorzeichenbehafteter Abstand zum Polygonrand (positiv innen, negativ außen), mit 5 m Hysterese:
   * - innen -> außen nur, wenn die Position mehr als 5 m AUSSERHALB des Rands liegt;
   * - außen -> innen nur, wenn die Position mehr als 5 m INNERHALB des Rands liegt.
   * Ein Alarm wird nur bei einer ZUSTANDSÄNDERUNG ausgelöst (oder wenn die allererste
   * bekannte Position schon außerhalb der Zone ist). Ohne gültige Zone (weniger als 3 Punkte) gibt es keinen Alarm.
   */
  function evaluate() {
    const valid = zoneIsValid();
    zonePoly.setStyle({ color: !valid || inside === null ? COLOR_UNKNOWN : inside ? COLOR_IN : COLOR_OUT });
    zoneHint.setStyle({ color: COLOR_UNKNOWN });
    $("p-center").textContent = zonePoints.length ? "Mitte: " + fmtLatLng(center) : "Mitte: -";

    if (!valid) {
      inside = null;
      $("alert-banner").hidden = true;
      $("p-dist").textContent = "-";
      $("p-zone").textContent = "NICHT DEFINIERT";
      $("p-zone").className = "badge badge-off";
      return;
    }
    if (!lastPos) {
      $("p-zone").textContent = "UNBEKANNT";
      $("p-zone").className = "badge badge-off";
      return;
    }

    const sd = signedDistanceM(lastPos);
    let nowInside;
    if (inside === null) nowInside = sd >= 0;
    else if (inside) nowInside = !(sd < -HYSTERESIS_M);
    else nowInside = sd > HYSTERESIS_M;

    if (nowInside !== inside) {
      const first = inside === null;
      inside = nowInside;
      onStateChange(nowInside, first, Math.abs(sd));
    }

    zonePoly.setStyle({ color: inside ? COLOR_IN : COLOR_OUT });
    $("p-dist").textContent = Math.round(Math.abs(sd)) + " m vom Rand, " + (sd >= 0 ? "innerhalb" : "außerhalb");
    const z = $("p-zone");
    z.textContent = inside ? "DRINNEN" : "DRAUSSEN";
    z.className = "badge " + (inside ? "badge-ok" : "badge-err");
  }

  let returnTimer = null;   // blendet das Rückkehr-Banner nach einigen Sekunden aus

  function hideReturnBanner() {
    if (returnTimer) { clearTimeout(returnTimer); returnTimer = null; }
    $("return-banner").hidden = true;
  }

  function onStateChange(nowInside, first, d) {
    if (!nowInside) {
      hideReturnBanner();
      $("alert-banner").hidden = false;
      log("ALARM: Gerät AUSSERHALB der Zone, " + Math.round(d) + " m vom Rand" + (first ? " (erste Position)" : ""), "alert");
      beep(3);
      requestLed(true);
      maybeSendSms("exit", d, first);
    } else {
      $("alert-banner").hidden = true;
      log(first ? "Erste Position: in der Zone (" + Math.round(d) + " m vom Rand)" : "Rückkehr in die Zone (" + Math.round(d) + " m vom Rand)", "ok");
      if (!first) {
        // Echte Rückkehr (nicht die erste Position): grünes Banner 10 s + zwei hohe Pieptöne
        $("return-banner").hidden = false;
        returnTimer = setTimeout(hideReturnBanner, 10000);
        beep(2, 1320);
        maybeSendSms("return", d);
      }
      if (!first && $("opt-return").checked) requestLed(false);
    }
  }

  // ---------- Neue Position ----------
  function handlePosition(lat, lng, when, source) {
    const dragging = source === "Maus";   // beim Ziehen verwaltet Leaflet die Markierung bereits
    lastPos = L.latLng(lat, lng);
    lastTime = when;
    // Beim Ziehen wird der Strecke nur alle 5 m ein Punkt hinzugefügt, um sie nicht zu überlasten
    if (!dragging || !trail.length || map.distance(trail[trail.length - 1].p, lastPos) > 5) {
      trail.push({ p: lastPos, t: when.getTime() });
      if (trail.length > TRAIL_MAX) trail.shift();
      renderTrail(true);
    }
    if (!map.hasLayer(marker)) marker.addTo(map);
    if (!dragging) {
      marker.setLatLng(lastPos);
      if (!map.getBounds().contains(lastPos)) map.panTo(lastPos);
    }

    $("p-pos").textContent = fmtLatLng(lastPos);
    $("p-time").textContent = when.toLocaleTimeString("de-DE") + " (" + source + ")";
    evaluate();
    schedulePlace();
  }

  /** Setzt Spur, Zonenzustand und LED zurück (Moduswechsel). */
  function resetState() {
    lastPos = null; lastTime = null; inside = null; trail = [];
    renderTrail(true);
    if (map.hasLayer(marker)) map.removeLayer(marker);
    $("alert-banner").hidden = true;
    hideReturnBanner();
    $("p-pos").textContent = "keine";
    $("p-time").textContent = "-";
    placeSeq++; placeLastPos = null; junctionLastPos = null;   // macht laufende Ortssuchen ungültig
    $("p-place").textContent = "-";
    $("p-junction").textContent = "-";
    $("p-dist").textContent = "-";
    $("p-zone").textContent = "UNBEKANNT";
    $("p-zone").className = "badge badge-off";
    if (deferredTimer) { clearTimeout(deferredTimer); deferredTimer = null; }
    applyLed(false);
    evaluate();
  }

  // ---------- Downlink (HTTP, Ersatz MQTT) ----------
  let lastAttemptAt = 0;       // Zeitpunkt des letzten Sendeversuchs
  let deferredTimer = null;    // wegen der 60-s-Grenze verzögerter Versand
  let desiredLed = false;      // zuletzt angeforderter LED-Zustand

  function setMethod(text) { $("p-method").textContent = text; }

  /** Fordert den LED-Zustand an; beachtet die Grenze von einem Versand pro 60 s (bei Bedarf verzögert). */
  function requestLed(on) {
    desiredLed = on;
    if (deferredTimer) { clearTimeout(deferredTimer); deferredTimer = null; }

    if (demo) {
      // Demo-Modus: kein echter Versand, die virtuelle LED folgt direkt
      applyLed(on);
      setMethod("simuliert (Demo)");
      log("[DEMO] simulierter Downlink: " + (on ? "0x01 (AQ==)" : "0x00 (AA==)"), "warn");
      return;
    }
    if (on === ledOn) return;   // bereits im gewünschten Zustand

    const wait = lastAttemptAt + DOWNLINK_MIN_MS - Date.now();
    if (wait > 0) {
      log("Downlink " + (on ? "0x01" : "0x00") + " um " + Math.ceil(wait / 1000) + " s verzögert (Grenze: 1 Versand / 60 s)", "warn");
      deferredTimer = setTimeout(() => { deferredTimer = null; requestLed(desiredLed); }, wait);
      return;
    }
    sendDownlink(on);
  }

  /** Sendet den Downlink: zuerst per HTTP; blockiert der Browser (CORS/Netzwerk), Ersatz über MQTT. */
  async function sendDownlink(on) {
    lastAttemptAt = Date.now();
    const label = on ? "0x01" : "0x00";
    const body = { downlinks: [{ frm_payload: on ? "AQ==" : "AA==", f_port: 2, priority: "HIGH" }] };

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(cfg.DOWNLINK_URL, {
        method: "POST",
        headers: { "Authorization": "Bearer " + cfg.API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal
      });
      setMethod("HTTP");
      let detail = "";
      if (!r.ok) {
        try { detail = " - " + (await r.text()).slice(0, 200); } catch (e) { /* Antworttext unlesbar */ }
      }
      log("Downlink " + label + " (HTTP): Code " + r.status + " " + r.statusText + detail, r.ok ? "ok" : "err");
      if (r.ok) applyLed(on);
    } catch (e) {
      if (e.name === "AbortError") {
        log("Downlink " + label + " (HTTP): keine Antwort nach 15 s.", "err");
      } else {
        // Ein TypeError von fetch = CORS- oder Netzwerkblockade (der Browser unterscheidet das nicht)
        log("HTTP-Downlink blockiert (CORS oder Netzwerk): " + e.message + " -> Ersatz über MQTT", "warn");
        publishViaMqtt(on, body, label);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /** Ersatz: veröffentlicht dasselbe JSON auf dem MQTT-Topic down/push. */
  function publishViaMqtt(on, body, label) {
    const topic = "v3/" + cfg.MQTT_USER + "/devices/" + cfg.DEVICE_ID + "/down/push";
    if (!client || !client.connected) {
      setMethod("Fehler (MQTT nicht verbunden)");
      log("Downlink " + label + " nicht möglich: MQTT nicht verbunden.", "err");
      return;
    }
    client.publish(topic, JSON.stringify(body), { qos: 0 }, (err) => {
      if (err) {
        setMethod("MQTT-Fehler");
        log("Downlink " + label + " (MQTT): Veröffentlichung fehlgeschlagen: " + err.message, "err");
      } else {
        setMethod("MQTT");
        log("Downlink " + label + " (MQTT) veröffentlicht auf " + topic, "ok");
        applyLed(on);
      }
    });
  }

  // ---------- MQTT ----------
  let client = null;       // aktueller MQTT.js-Client
  let connSeq = 0;         // macht alte Clients bei einem Moduswechsel ungültig
  let retryTimer = null;

  /** Möglichst genaue Fehlermeldung (der Browser verbirgt oft die Ursache eines WebSocket-Fehlers). */
  function describeError(err) {
    if (err && err.message) return err.message;
    if (err && err.type) return "WebSocket-Ereignis '" + err.type + "' ohne Details (der Browser verbirgt die Ursache: siehe F12 > Konsole / Netzwerk)";
    return String(err);
  }

  let eventsCtrl = null;   // AbortController des HTTP-Ereignisstroms

  /** Beendet den laufenden Empfang (MQTT oder Ereignisstrom). */
  function stopMqtt() {
    connSeq++;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (client) { client.end(true); client = null; }
    if (eventsCtrl) { eventsCtrl.abort(); eventsCtrl = null; }
  }

  /** Startet den Empfang der Uplinks gemäß CONFIG.RECEIVE_MODE (standardmäßig "events", oder "mqtt"). */
  function connectMqtt() {
    stopMqtt();
    if (!cfg.API_KEY || cfg.API_KEY === "TA-CLE-API") {
      setMqttStatus("API-Schlüssel nicht eingetragen", "err");
      log("Der API-Schlüssel ist noch TA-CLE-API: Ersetzen Sie ihn in web/config.js (oder nutzen Sie den Demo-Modus).", "err");
      return;
    }
    if (cfg.RECEIVE_MODE === "mqtt") {
      if (typeof mqtt === "undefined") {
        setMqttStatus("MQTT.js nicht geladen", "err");
        log("MQTT.js konnte nicht vom CDN geladen werden (Internetverbindung?).", "err");
        return;
      }
      tryUrl(0, connSeq);
    } else {
      eventsLoop(connSeq);
    }
  }

  // ---------- Empfang über den HTTP-Ereignisstrom (ohne MQTT) ----------
  /** Verarbeitet einen dekodierten Uplink (gemeinsam für Ereignisstrom und MQTT). */
  function onUplink(uplinkMessage, receivedAt) {
    const dp = uplinkMessage && uplinkMessage.decoded_payload;
    if (dp && Number.isFinite(dp.ack) && typeof window.__handleTextAck === "function") { window.__handleTextAck(dp.ack); return; }
    if (!dp || !Number.isFinite(dp.lat) || !Number.isFinite(dp.lng)) {
      log("Uplink ohne dekodierte lat/lng empfangen (Uplink-Formatter des Geräts?).", "warn");
      return;
    }
    let when = receivedAt ? new Date(receivedAt) : new Date();
    if (isNaN(when.getTime())) when = new Date();
    log("Uplink empfangen: lat " + dp.lat + ", lng " + dp.lng, "");
    handlePosition(dp.lat, dp.lng, when, "uplink");
  }

  /**
   * Öffnet fortlaufend einen POST-Strom /api/v3/events (JSON Zeile für Zeile), auf die Anwendung gefiltert,
   * und verarbeitet die Ereignisse "as.up.data.forward" (an die Anwendung weitergeleiteter Uplink).
   * Wird der Strom getrennt, öffnet er sich nach 5 s neu, außer bei Fehler 401/403/404 (erneutes Versuchen ist sinnlos).
   */
  async function eventsLoop(seq) {
    const url = new URL(cfg.DOWNLINK_URL).origin + "/api/v3/events";
    const seenOther = {};   // bereits gemeldete unerwartete Ereignisnamen
    const seenIds = new Set();     // bereits verarbeitete Ereignisse (vermeidet Duplikate nach einem Nachholen)
    let lastEventTime = null;      // Uhrzeit (Server) des zuletzt empfangenen Ereignisses: dient als Wiederaufnahmepunkt
    let firstOpenAt = null;        // lokale Uhrzeit der ersten Öffnung des Stroms
    let afterSupported = true;     // wird false, wenn der Server den Parameter "after" ablehnt
    let announced = false;         // die Meldung „Strom geöffnet“ wird nur einmal geschrieben
    while (seq === connSeq) {
      const ctrl = new AbortController();
      eventsCtrl = ctrl;
      let delayMs = 5000;          // Wartezeit vor dem Wiederöffnen (verkürzt, wenn der Server sauber schließt)
      if (!announced) setMqttStatus("Verbindung zum Ereignisstrom …", "warn");
      try {
        const body = { identifiers: [{ application_ids: { application_id: cfg.APP_ID } }] };
        // Wiederöffnen: Der Server schließt den Strom etwa alle 15 s; wir fordern die Ereignisse erneut an,
        // die seit dem letzten empfangenen aufgetreten sind, damit während der Unterbrechung nichts verloren geht.
        if (afterSupported && firstOpenAt !== null) {
          body.after = lastEventTime || new Date(firstOpenAt - 5000).toISOString();
        }
        const r = await fetch(url, {
          method: "POST",
          headers: { "Authorization": "Bearer " + cfg.API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctrl.signal
        });
        if (!r.ok) {
          let detail = "";
          try { detail = " - " + (await r.text()).slice(0, 250); } catch (e) { /* Antworttext unlesbar */ }
          if (r.status === 400 && body.after) {
            afterSupported = false;   // der Server akzeptiert "after" nicht: Wir machen ohne Nachholen weiter
            log("Nachhol-Parameter abgelehnt (HTTP 400" + detail + "): Wiederöffnen ohne Nachholen.", "warn");
            continue;
          }
          log("Ereignisstrom: HTTP " + r.status + " " + r.statusText + detail, "err");
          if (r.status === 401 || r.status === 403 || r.status === 404) {
            setMqttStatus("abgelehnt (HTTP " + r.status + ")", "err");
            if (r.status === 403) log("403: Fügen Sie dem Schlüssel das Recht „Read application traffic (uplink and downlink)“ hinzu (und bei Bedarf „View devices in application“).", "warn");
            if (r.status === 401) log("401: API-Schlüssel ungültig oder widerrufen.", "warn");
            return;   // kein neuer Versuch
          }
          throw new Error("HTTP " + r.status);
        }
        setMqttStatus("Ereignisstrom aktiv", "ok");
        if (firstOpenAt === null) firstOpenAt = Date.now();
        if (!announced) {
          announced = true;
          log("Ereignisstrom geöffnet: Warten auf Uplinks (Simulate uplink / simulate.html).", "ok");
        }

        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (seq === connSeq) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let obj;
            try { obj = JSON.parse(line); } catch (e) { continue; }   // unvollständige Zeile oder kein JSON
            if (obj.error) { log("Ereignisstrom: " + JSON.stringify(obj.error).slice(0, 250), "err"); continue; }
            const ev = obj.result;
            if (!ev || !ev.name) continue;
            // Duplikate (ein Nachholen kann ein bereits verarbeitetes Ereignis erneut liefern)
            const id = ev.unique_id || (ev.name + "|" + ev.time);
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            if (seenIds.size > 500) seenIds.clear();
            if (ev.time) lastEventTime = ev.time;
            const um = ev.data && ev.data.uplink_message;
            if (ev.name === "as.up.data.forward" && um) {
              onUplink(um, um.received_at || ev.time);
            } else if (um && !seenOther[ev.name]) {
              seenOther[ev.name] = true;
              log("Ereignis ignoriert (unerwarteter Name): " + ev.name, "warn");
            }
          }
        }
        // Normales Schließen durch den Server (etwa alle 15 s): fast sofortiges Wiederöffnen
        delayMs = 300;
      } catch (e) {
        if (seq !== connSeq || e.name === "AbortError") return;   // gewollter Stopp
        log("Ereignisstrom unterbrochen: " + e.message + " (neuer Versuch in 5 s)", "err");
        setMqttStatus("Strom unterbrochen: " + e.message, "err");
      }
      await new Promise((res) => { retryTimer = setTimeout(res, delayMs); });
    }
  }

  /** Probiert die URL mit Index i; geht zur nächsten über, wenn der Server nicht erreichbar ist. */
  function tryUrl(i, seq) {
    const urls = cfg.MQTT_WS_URLS;
    const url = urls[i];
    const topic = "v3/" + cfg.MQTT_USER + "/devices/" + cfg.DEVICE_ID + "/up";
    let connected = false, reachedServer = false, advanced = false;

    setMqttStatus("Verbindung zu " + url + " …", "warn");
    log("MQTT-Verbindung: " + url, "");

    const c = mqtt.connect(url, {
      username: cfg.MQTT_USER,
      password: cfg.API_KEY,
      protocolVersion: 4,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
      clean: true,
      clientId: "geofence-web-" + Math.random().toString(16).slice(2, 10)
    });
    client = c;

    // Wechselt zur nächsten URL (oder beginnt nach 5 s von vorn)
    function next() {
      if (advanced || seq !== connSeq) return;
      advanced = true;
      c.end(true);
      if (i + 1 < urls.length) {
        tryUrl(i + 1, seq);
      } else {
        setMqttStatus("Fehler bei allen URLs, neuer Versuch in 5 s", "err");
        log("Keine WebSocket-URL hat geantwortet. Neuer Versuch in 5 s.", "err");
        retryTimer = setTimeout(() => { if (seq === connSeq) tryUrl(0, seq); }, 5000);
      }
    }

    c.on("connect", () => {
      if (seq !== connSeq) return;
      connected = true;
      setMqttStatus("verbunden (" + url + ")", "ok");
      log("MQTT verbunden. Abonnement auf " + topic, "ok");
      c.subscribe(topic, { qos: 0 }, (err, granted) => {
        if (err) log("Abonnement abgelehnt: " + err.message, "err");
        else if (granted && granted[0] && granted[0].qos === 128) log("Abonnement vom Broker abgelehnt (Rechte des API-Schlüssels?)", "err");
        else log("Abonnement aktiv.", "ok");
      });
    });

    c.on("error", (err) => {
      if (seq !== connSeq) return;
      const txt = describeError(err);
      // Ein numerischer Code = MQTT-Antwort (CONNACK): Der Server ist erreichbar, lehnt aber ab (Zugangsdaten, Rechte)
      if (err && typeof err.code === "number") reachedServer = true;
      log("MQTT-Fehler auf " + url + ": " + txt, "err");
      setMqttStatus("Fehler: " + txt, "err");
    });

    c.on("close", () => {
      if (seq !== connSeq || advanced) return;
      if (!connected && !reachedServer) next();            // URL nicht erreichbar: nächster Versuch
      else if (connected) setMqttStatus("getrennt, Wiederverbindung in 5 s", "warn");
    });

    c.on("message", (t, payload) => {
      if (seq !== connSeq) return;
      let msg;
      try { msg = JSON.parse(payload.toString()); }
      catch (e) { log("MQTT-Nachricht ohne JSON ignoriert.", "warn"); return; }
      const dp = msg && msg.uplink_message && msg.uplink_message.decoded_payload;
      if (!dp || !Number.isFinite(dp.lat) || !Number.isFinite(dp.lng)) {
        log("Uplink ohne dekodierte lat/lng empfangen (Uplink-Formatter des Geräts?).", "warn");
        return;
      }
      const iso = msg.received_at || (msg.uplink_message && msg.uplink_message.received_at);
      let when = iso ? new Date(iso) : new Date();
      if (isNaN(when.getTime())) when = new Date();
      log("Uplink empfangen: lat " + dp.lat + ", lng " + dp.lng, "");
      handlePosition(dp.lat, dp.lng, when, "uplink");
    });
  }

  // ---------- Offline-Demo-Modus ----------
  $("opt-demo").addEventListener("change", (e) => {
    demo = e.target.checked;
    resetState();
    // Entfernt man die Markierung von der Karte, bleibt die Option "draggable" auf true und marker.dragging wird entfernt:
    // Wir setzen sie auf false zurück und aktivieren das Ziehen nur im Demo-Modus, sobald die Markierung wieder gesetzt ist.
    marker.options.draggable = false;
    if (demo) {
      stopMqtt();
      setMqttStatus("offline (Demo-Modus)", "warn");
      log("Demo-Modus aktiviert: Ziehen Sie den Sensor mit der Maus (oder Pfeiltasten). Kein echter Versand.", "warn");
      handlePosition(center.lat, center.lng, new Date(), "Demo");
      marker.dragging.enable();
    } else {
      log("Demo-Modus deaktiviert: zurück zum echten Empfang.", "");
      connectMqtt();
    }
  });

  /** Verschiebt das Schein-Gerät um `meters` Meter nach Norden (dy) und Osten (dx). */
  function moveDemo(dxMeters, dyMeters) {
    const dLat = dyMeters / 111320;
    const dLng = dxMeters / (111320 * Math.cos(lastPos.lat * Math.PI / 180));
    handlePosition(lastPos.lat + dLat, lastPos.lng + dLng, new Date(), "Demo");
  }

  document.addEventListener("keydown", (e) => {
    if (!demo || !lastPos) return;
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;  // die Eingabe nicht stören
    const step = e.shiftKey ? 100 : 20;
    const moves = { ArrowUp: [0, step], ArrowDown: [0, -step], ArrowLeft: [-step, 0], ArrowRight: [step, 0] };
    const mv = moves[e.key];
    if (!mv) return;
    e.preventDefault();
    moveDemo(mv[0], mv[1]);
  });

  // ---------- Sprachnachrichten (Chat mit dem Gerät) ----------
  // Das Audio läuft über das Relay des lokalen Servers (tools/voice-relay.js, per HTTP/WLAN), nie über LoRaWAN.
  // LoRaWAN dient nur dazu, das Gerät zu benachrichtigen: Downlink Port 5, ein Byte, mit derselben Grenze von einem Versand pro Minute.
  const VOICE_URL = "/api/voice";
  const DICTEE_MAX_MS = 10000;   // 10 s wie beim Gerät (Testphase); die Dauer wird später erhöht
  const BASE_TITLE = document.title;
  const voice = { msgs: new Map(), lastId: 0, ready: false, es: null, urls: new Map(), playing: null, notifyPending: false, notifyTimer: null, retention: 7 };

  // SVG-Symbole (fester Text des Codes: keine Daten von außen fließen hier ein)
  const svg = (d) => '<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path d="' + d + '"/></svg>';
  const ICON = {
    play: svg("M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"),
    pause: svg("M7 4.5h3.5v15H7zm6.5 0H17v15h-3.5z"),
    tick: svg("M9.2 16.2 4.9 11.9 3.5 13.3l5.7 5.7L20.5 7.7 19.1 6.3z"),
    ticks: svg("M1.6 13.3 7.3 19l1.4-1.4-5.7-5.7zM22.2 6.3 11.6 16.9 9.4 14.7 8 16.1l3.6 3.6L23.6 7.7zM16.7 6.3 9.9 13.1l1.4 1.4 6.8-6.8z"),
    back: svg("M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"),
    stop: svg("M6 6h12v12H6z"),
    mic: svg("M12 14.5a3.5 3.5 0 0 0 3.5-3.5V5.5a3.5 3.5 0 0 0-7 0V11a3.5 3.5 0 0 0 3.5 3.5zm6-3.5a6 6 0 0 1-12 0H4.5a7.5 7.5 0 0 0 6.75 7.46V21h1.5v-2.54A7.5 7.5 0 0 0 19.5 11z"),
    clock: svg("M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16zm.5-13H11v6l5.2 3.1.8-1.3-4.5-2.7z"),
    alert: svg("M12 2 1 21h22L12 2zm1 15h-2v-2h2v2zm0-4h-2V9h2v4z"),
    cross: svg("M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z")
  };
  const dayLabel = (iso) => {
    const d = new Date(iso), t = new Date();
    const same = (a, b) => a.toDateString() === b.toDateString();
    const y = new Date(t); y.setDate(t.getDate() - 1);
    return same(d, t) ? "Heute" : same(d, y) ? "Gestern" : d.toLocaleDateString("de-DE", { day: "numeric", month: "long" });
  };
  const clock = (sec) => { const t = Math.round(sec); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };
  const hhmm = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  /** Aufruf des Relays (gleicher Ursprung wie die Seite). */
  function vFetch(path, opts) {
    const o = Object.assign({ cache: "no-store" }, opts);
    o.headers = Object.assign({ "X-From": "page" }, o.headers);
    return fetch(VOICE_URL + path, o);
  }
  function voiceStatus(text, level) {
    const el = $("voice-status");
    el.textContent = text;
    el.className = "hint " + (level === "ok" ? "sms-ok" : level === "err" ? "sms-off" : "sms-test");
  }
  function voiceMsg(text, level) {
    const el = $("voice-msg");
    el.textContent = text;
    el.className = "hint" + (level === "err" ? " sms-off" : level === "ok" ? " sms-ok" : "");
  }

  /** Anzahl der noch nicht angehörten Nachrichten des Patienten: Abzeichen „neu“ und Titel des Tabs. */
  function updateVoiceBadge() {
    let n = 0;
    voice.msgs.forEach((m) => { if (m.from === "device" && !m.heard) n++; });
    const b = $("voice-badge");
    b.hidden = n === 0;
    b.textContent = n > 1 ? n + " neue" : "neu";
    document.title = (n ? "(" + n + ") " : "") + BASE_TITLE;
  }

  /** Dekorative Schallwelle (feste Höhen, aus der Nachrichten-ID berechnet, wie in WhatsApp). */
  function waveform(id) {
    const w = document.createElement("div");
    w.className = "wa-wave";
    let seed = id * 9301 + 49297;
    for (let i = 0; i < 28; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const bar = document.createElement("i");
      bar.style.height = (20 + Math.round((seed / 233280) * 80)) + "%";
      w.append(bar);
    }
    return w;
  }
  /** Färbt die Welle ein und zeigt die verstrichene Zeit während der Wiedergabe. */
  function playProgress(id, audio) {
    const b = $("voice-chat").querySelector('[data-id="' + id + '"]');
    if (!b) return;
    const bars = b.querySelectorAll(".wa-wave i");
    const d = audio.duration && isFinite(audio.duration) ? audio.duration : (voice.msgs.get(id) || {}).duration || 1;
    const p = Math.min(1, audio.currentTime / d);
    bars.forEach((el, i) => el.classList.toggle("on", i / bars.length < p));
    b.querySelector(".bubble-dur").textContent = clock(audio.currentTime);
  }

  /** Zustand einer Textnachricht: wartend, gesendet, vom Gerät empfangen, laut gesprochen oder fehlgeschlagen. */
  function textState(m) {
    const isText = m.kind === "text";
    if (m.heard) return { icon: ICON.ticks, cls: "read", title: isText ? "vom Gerät laut gesprochen" : "vom Gerät angehört" };
    if (m.delivered) return { icon: ICON.ticks, cls: "", title: "vom Gerät empfangen" };
    if (m.lora === "sim") return { icon: ICON.tick, cls: "", title: "an den simulierten Sensor zugestellt (TTN: keine LoRaWAN-Sitzung)" };
    if (m.lora === "failed") return { icon: ICON.alert, cls: "fail", title: "nicht gesendet" };
    if (m.lora === "queued") return { icon: ICON.clock, cls: "", title: "wartet auf Versand (Grenze: ein Downlink pro Minute)" };
    return { icon: ICON.tick, cls: "", title: "per LoRaWAN gesendet" };
  }

  /** Zeichnet den Chat neu: Patient links, wir rechts. */
  function renderChat() {
    const box = $("voice-chat");
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    box.textContent = "";
    const list = Array.from(voice.msgs.values()).sort((a, b) => a.id - b.id);
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "chat-empty";
      p.textContent = "Keine Nachricht.";
      box.append(p);
    }
    let lastDay = "";
    for (const m of list) {
      const day = dayLabel(m.at);
      if (day !== lastDay) { const c = document.createElement("div"); c.className = "chat-day"; c.textContent = day; box.append(c); lastDay = day; }
      const mine = m.from === "page";
      const b = document.createElement("div");
      b.className = "bubble " + (mine ? "mine" : "theirs") + (!mine && !m.heard ? " fresh" : "") + (m.id === voice.popId ? " pop" : "");
      b.dataset.id = m.id;
      if (m.kind === "text") {
        // Textnachricht (per LoRaWAN gesendet, vom Gerät laut gesprochen)
        const t = document.createElement("div");
        t.className = "bubble-text";
        t.textContent = m.text;
        const meta = document.createElement("div");
        meta.className = "bubble-meta bubble-meta-text";
        const via = document.createElement("span");
        via.className = "bubble-via";
        via.textContent = "LoRaWAN · " + utf8Len(m.text) + " Byte" + (mine ? " · Nr. " + seqOf(m.id) : "");
        const time = document.createElement("span");
        time.className = "bubble-time";
        time.textContent = hhmm(m.at);
        if (mine) {
          const st = textState(m);
          const tk = document.createElement("span");
          tk.className = "ticks " + st.cls;
          tk.innerHTML = st.icon;
          tk.title = st.title;
          time.append(tk);
        }
        meta.append(via, time);
        b.append(t, meta);
        box.append(b);
        continue;
      }
      const body = document.createElement("div");
      body.className = "bubble-body";
      const play = document.createElement("button");
      const isPlaying = voice.playing && voice.playing.id === m.id;
      play.type = "button";
      play.className = "bubble-play";
      play.innerHTML = isPlaying ? ICON.pause : ICON.play;
      play.setAttribute("aria-label", (isPlaying ? "Wiedergabe stoppen: " : "Anhören: ") + "Sprachnachricht von " + hhmm(m.at));
      play.addEventListener("click", () => playVoice(m.id));
      body.append(play, waveform(m.id));
      if (!mine && !m.heard) { const dot = document.createElement("span"); dot.className = "wa-unplayed"; dot.title = "Noch nicht angehört"; body.append(dot); }
      // Untere Zeile: Dauer links; Uhrzeit und Haken rechts (✓ gesendet, ✓✓ empfangen, blaue ✓✓ angehört)
      const meta = document.createElement("div");
      meta.className = "bubble-meta";
      const dur = document.createElement("span");
      dur.className = "bubble-dur";
      dur.textContent = clock(m.duration);
      const time = document.createElement("span");
      time.className = "bubble-time";
      time.textContent = hhmm(m.at);
      if (mine) {
        const st = textState(m);
        const t = document.createElement("span");
        t.className = "ticks " + st.cls;
        t.innerHTML = st.icon;
        t.title = st.title;
        time.append(t);
      }
      meta.append(dur, time);
      b.append(body, meta);
      box.append(b);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
    updateVoiceBadge();
  }

  /** Sanfter Empfangston; der Zonenalarm hat Vorrang (kein Ton, solange er angezeigt wird). */
  function voiceChime() {
    if (!audioRunning() || !$("alert-banner").hidden) return;
    [523, 659].forEach((f, i) => {
      const t = audioCtx.currentTime + i * 0.16;
      const osc = audioCtx.createOscillator(), g = audioCtx.createGain();
      osc.type = "sine"; osc.frequency.value = f;
      g.gain.setValueAtTime(0.18, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
      osc.connect(g).connect(audioCtx.destination);
      osc.start(t); osc.stop(t + 0.25);
    });
  }

  /** Fügt eine Nachricht hinzu oder aktualisiert sie; `live` = live empfangen (Ton, Protokoll), nicht beim Laden des Verlaufs. */
  function addVoice(m, live) {
    const known = voice.msgs.has(m.id);
    if (!known) { voice.popId = m.id; setTimeout(() => { if (voice.popId === m.id) voice.popId = 0; }, 600); }
    voice.msgs.set(m.id, Object.assign(voice.msgs.get(m.id) || {}, m));
    if (m.id > voice.lastId) voice.lastId = m.id;
    renderChat();
    if (!known && live && m.from === "device") {
      voiceChime();
      log("Sprachnachricht des Patienten empfangen (" + clock(m.duration) + ")", "ok");
      voiceMsg("Neue Sprachnachricht des Patienten (" + clock(m.duration) + ").", "ok");
      if (m.kind !== "text") autoPlay(m.id);
    }
  }

  /** Automatische Wiedergabe einer live empfangenen Sprachnachricht; läuft schon eine, kommt sie in die Warteschlange. */
  function autoPlay(id) {
    if (voice.playing) { voice.autoQueue = (voice.autoQueue || []).concat(id); return; }
    playVoice(id, true);
  }

  /** Wiedergabe einer Nachricht (mit dem Header X-From abgerufen); das Anhören einer Nachricht des Patienten sendet die Bestätigung. */
  function stopPlayback() {
    if (!voice.playing) return;
    voice.playing.audio.pause();
    voice.playing = null;
  }
  async function playVoice(id, auto) {
    const m = voice.msgs.get(id);
    if (!m) return;
    if (voice.playing && voice.playing.id === id) { stopPlayback(); renderChat(); return; }
    stopPlayback();
    try {
      let url = voice.urls.get(id);
      if (!url) {
        const r = await vFetch("/" + id + "/audio");
        if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 404 ? " (Nachricht gelöscht?)" : ""));
        url = URL.createObjectURL(await r.blob());
        voice.urls.set(id, url);
      }
      const a = new Audio(url);
      voice.playing = { id: id, audio: a };
      a.onended = () => {
        if (voice.playing && voice.playing.audio === a) voice.playing = null;
        renderChat();
        const next = (voice.autoQueue || []).shift();
        if (next && !voice.playing) playVoice(next, true);
      };
      a.ontimeupdate = () => playProgress(id, a);
      await a.play();
      renderChat();
      if (m.from === "device" && !m.heard) ackVoice(id);
    } catch (e) {
      voice.playing = null;
      renderChat();
      voiceMsg(auto && e.name === "NotAllowedError" ? "Der Browser blockiert die automatische Wiedergabe: Klicken Sie einmal auf die Seite und dann auf ▶, um anzuhören." : "Wiedergabe nicht möglich: " + e.message, "err");
    }
  }
  async function ackVoice(id) {
    try {
      const r = await vFetch("/" + id + "/ack", { method: "POST" });
      if (r.ok) addVoice(await r.json(), false);
    } catch (e) { /* die Bestätigung wird beim nächsten Anhören erneut gesendet */ }
  }

  // ----- TEXT-Nachrichten zum Gerät: LoRaWAN (Downlink Port 4), das Gerät spricht sie laut aus -----
  // Die Stimme läuft nie über LoRaWAN: Wir senden den Text (höchstens 49 Byte, Grenze eines EU868-Downlinks) und das Gerät liest ihn
  // mit einer Sprachsynthese vor. Gleiche Grenze wie bei der LED: ein Downlink pro Minute, die Texte warten in einer Warteschlange.
  const TEXT_MAX_BYTES = 49;
  const LORA_PORT_TEXT = 4;
  const LORA_PORT_VOICE = 5;   // Downlink von einem Byte: „eine Sprachnachricht wartet auf dem Relay“
  const lora = { queue: [], timer: null, warned: false };
  const utf8Len = (t) => new TextEncoder().encode(t).length;
  const seqOf = (id) => ((id - 1) % 255) + 1;   // Nummer 1 bis 255, an das Gerät gesendet und in dessen Bestätigung zurückgegeben (Uplink Port 3)

  /** Benachrichtigt den Simulator (und jeden anderen Abonnenten), dass dieser Text gerade per LoRaWAN gesendet wurde. */
  /** Gibt die Anzahl der simulierten Geräte (Sensor-Seite, Simulator) zurück, die die Benachrichtigung erhalten haben, oder 0, wenn das Relay nicht erreichbar ist. */
  function relayNotify(id) {
    return vFetch("/notify?id=" + id, { method: "POST" }).then((r) => r.ok ? r.json() : null).then((j) => (j && j.sensors) || 0).catch(() => 0);
  }

  function setLora(id, state) {
    const m = voice.msgs.get(id);
    if (m) { m.lora = state; renderChat(); }
  }

  /** Nutzlast des Downlinks in Base64: [Nummer] + UTF-8-Text (siehe ttn/downlink_encoder.js). */
  function textPayload(id, text) {
    const enc = new TextEncoder().encode(text);
    const bytes = new Uint8Array(enc.length + 1);
    bytes[0] = seqOf(id);
    bytes.set(enc, 1);
    let s = "";
    bytes.forEach((b) => { s += String.fromCharCode(b); });
    return btoa(s);
  }

  /** Nutzlast und Port des Downlinks einer Nachricht: Text oder einfaches Signal für eine Sprachnachricht (das Audio läuft über das WLAN des Geräts). */
  function downlinkOf(id, m) {
    return m.kind === "text" ? { payload: textPayload(id, m.text), port: LORA_PORT_TEXT, label: "Text" } : { payload: btoa(String.fromCharCode(1)), port: LORA_PORT_VOICE, label: "Signal für Sprachnachricht" };
  }

  function queueText(id) {
    lora.queue.push(id);
    pumpTexts();
  }

  /** Sendet den nächsten Text, wenn die Grenze von einem Downlink pro Minute es erlaubt; ein wartender LED-Befehl hat Vorrang. */
  function pumpTexts() {
    if (lora.timer) { clearTimeout(lora.timer); lora.timer = null; }
    if (!lora.queue.length) return;
    if (demo) {
      // Demo-Modus: Nichts wird ins Netz gesendet, der Simulator erhält die Benachrichtigung
      while (lora.queue.length) {
        const id = lora.queue.shift();
        const m = voice.msgs.get(id);
        setMethod("simuliert (Demo)");
        log("[DEMO] simulierter Downlink: " + (m && m.kind === "text" ? "Text „" + m.text + "“ (Port " + LORA_PORT_TEXT + ")" : "Signal für Sprachnachricht (Port " + LORA_PORT_VOICE + ")"), "warn");
        setLora(id, "sent");
        relayNotify(id);
      }
      voiceMsg("[Demo] Nachricht simuliert gesendet: Nichts geht ins Netz.", "ok");
      return;
    }
    const wait = lastAttemptAt + DOWNLINK_MIN_MS - Date.now();
    if (wait > 0 || deferredTimer) {
      const delay = Math.max(wait, 0) + (deferredTimer ? 1500 : 0);
      voiceMsg("Nachricht wartet: LoRaWAN erlaubt nur einen Downlink pro Minute (Versand in " + Math.ceil(delay / 1000) + " s).");
      if (!lora.warned) { lora.warned = true; log("Text wartet auf Versand: Grenze von einem Downlink pro Minute (" + lora.queue.length + " Nachricht(en) in der Warteschlange)", "warn"); }
      lora.timer = setTimeout(() => { lora.timer = null; pumpTexts(); }, delay);
      return;
    }
    lora.warned = false;
    sendTextDownlink(lora.queue.shift()).then(() => pumpTexts());
  }

  async function sendTextDownlink(id) {
    const m = voice.msgs.get(id);
    if (!m) return;
    lastAttemptAt = Date.now();
    const dl = downlinkOf(id, m);
    if (!cfg.API_KEY || cfg.API_KEY === "TA-CLE-API") {
      setLora(id, "failed");
      log("Text nicht gesendet: Der API-Schlüssel ist noch TA-CLE-API (web/config.js).", "err");
      voiceMsg("Nachricht nicht gesendet: API-Schlüssel fehlt in web/config.js.", "err");
      return;
    }
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(cfg.DOWNLINK_URL, {
        method: "POST",
        headers: { "Authorization": "Bearer " + cfg.API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ downlinks: [{ frm_payload: dl.payload, f_port: dl.port, priority: "NORMAL" }] }),
        signal: ctrl.signal
      });
      let detail = "";
      if (!r.ok) { try { detail = " - " + (await r.text()).slice(0, 300); } catch (e) { /* Antworttext unlesbar */ } }
      log("Downlink " + dl.label + " (HTTP, Port " + dl.port + "): Code " + r.status + " " + r.statusText + (r.ok ? "" : detail.slice(0, 120)), r.ok ? "ok" : "err");
      if (r.ok) {
        setLora(id, "sent");
        relayNotify(id);
        voiceMsg(m.kind === "text" ? "Text per LoRaWAN gesendet: Das Gerät empfängt ihn beim nächsten Austausch (etwa 30 s) und spricht ihn dann laut aus." : "Sprachnachricht gesendet: Das Gerät wird per LoRaWAN benachrichtigt (etwa 30 s) und lädt dann das Audio per WLAN herunter.", "ok");
      } else if (/no_device_session/.test(detail)) {
        // Kein echtes Gerät ist dem Netz beigetreten: Ist eine Sensor-Seite (simuliertes Gerät) geöffnet, wird ihr die Nachricht über das Relay zugestellt
        lastAttemptAt = 0;   // TTN hat abgelehnt: Nichts wurde gefunkt, also keine Minute Wartezeit vor der nächsten Nachricht
        const sensors = await relayNotify(id);
        if (sensors > 0) {
          setLora(id, "sim");
          log("TTN hat keine LoRaWAN-Sitzung (kein echtes Gerät): Nachricht über das Relay an den simulierten Sensor zugestellt.", "warn");
          voiceMsg("Nachricht an den simulierten Sensor zugestellt. Noch kein echtes Gerät ist dem LoRaWAN-Netz beigetreten: TTN hat daher nichts übertragen („no_device_session“).", "ok");
        } else {
          setLora(id, "failed");
          voiceMsg("Text nicht gesendet: Das Gerät ist dem LoRaWAN-Netz noch nicht beigetreten (keine Sitzung, „no_device_session“). Öffnen Sie die Sensor-Seite (tools/sensor.html), um das Gerät zu simulieren, oder warten Sie auf die erste Verbindung (OTAA-Join).", "err");
        }
      } else {
        setLora(id, "failed");
        voiceMsg("Text nicht gesendet: The Things Stack hat mit " + r.status + " geantwortet.", "err");
      }
    } catch (e) {
      setLora(id, "failed");
      log("Text-Downlink nicht möglich: " + (e.name === "AbortError" ? "keine Antwort nach 15 s" : e.message), "err");
      voiceMsg("Text nicht gesendet: Netzwerk nicht erreichbar.", "err");
    } finally { clearTimeout(timeout); }
  }

  /** Das Gerät hat den Text gesprochen: Es sendet die Nummer als Uplink zurück (Port 3, als { ack } dekodiert) -> blaue Haken. */
  function handleTextAck(seq) {
    let found = null;
    voice.msgs.forEach((m) => { if (m.kind === "text" && !m.heard && seqOf(m.id) === seq) found = m; });
    if (!found) { log("Bestätigung des Geräts (Nr. " + seq + ") ohne wartende Nachricht.", "warn"); return; }
    log("Das Gerät hat die Nachricht laut gesprochen: „" + found.text + "“", "ok");
    // Die Seite übernimmt hier gegenüber dem Relay die Rolle des Geräts, wie der Simulator
    vFetch("/" + found.id + "/ack", { method: "POST", headers: { "X-From": "device" } }).then((r) => r.ok ? r.json() : null).then((j) => { if (j) addVoice(j, false); }).catch(() => {});
  }
  window.__handleTextAck = handleTextAck;   // von onUplink aufgerufen (weiter oben definiert)

  // ----- Eingabefeld: Text per Tastatur oder Diktat mit der Mikrofon-Schaltfläche -----
  function updateComposer() {
    const v = $("wa-input").value;
    const n = utf8Len(v.trim());
    const c = $("wa-count");
    c.textContent = n + "/" + TEXT_MAX_BYTES + " Byte";
    c.classList.toggle("over", n > TEXT_MAX_BYTES);
    const has = v.trim().length > 0;
    if (barMode === "idle") {
      $("btn-send").hidden = !has;
      $("btn-voice").hidden = has;   // Text eingegeben: Senden-Schaltfläche; sonst: Mikrofon der Sprachnachricht
    }
    $("btn-send").disabled = !voice.ready || n > TEXT_MAX_BYTES;
  }
  /** Modus der Leiste: "idle" (Eingabe), "dict" (Diktat des Textes) oder "vrec" (Aufnahme einer Sprachnachricht). */
  let barMode = "idle";
  function setBarMode(mode) {
    barMode = mode;
    const rec = mode !== "idle";
    $("wa-rec-info").hidden = !rec;
    $("wa-compose").hidden = rec;
    if (rec) { $("btn-send").hidden = true; $("btn-voice").hidden = true; }
    $("rec-hint").textContent = mode === "vrec" ? "Sprechen Sie, höchstens 10 s" : "Sprechen Sie: Der Text wird geschrieben";
    $("btn-rec-ok").textContent = mode === "vrec" ? "Senden" : "Fertig";
    $("voice-timer").textContent = "0:00";
    updateComposer();
  }

  async function sendText() {
    const input = $("wa-input");
    const text = input.value.replace(/\s+/g, " ").trim();
    if (!text || !voice.ready) return;
    if (utf8Len(text) > TEXT_MAX_BYTES) { voiceMsg("Nachricht zu lang für LoRaWAN: " + utf8Len(text) + " Byte, höchstens " + TEXT_MAX_BYTES + " (Umlaute und ß zählen doppelt).", "err"); return; }
    $("btn-send").disabled = true;
    try {
      const r = await vFetch("", { method: "POST", headers: { "Content-Type": "text/plain; charset=utf-8" }, body: text });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      addVoice({ id: j.id, at: j.at, from: "page", kind: "text", text: j.text, duration: 0, delivered: false, heard: false, lora: "queued" }, false);
      input.value = "";
      updateComposer();
      log("Textnachricht gespeichert (" + j.bytes + " Byte): Versand per LoRaWAN", "ok");
      queueText(j.id);
    } catch (e) {
      log("Nachricht nicht gespeichert: " + e.message, "err");
      voiceMsg("Nachricht nicht gesendet: " + e.message, "err");
    } finally { updateComposer(); }
  }
  $("wa-input").addEventListener("input", updateComposer);
  $("wa-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); sendText(); } });
  $("btn-send").addEventListener("click", sendText);

  // ----- Diktat (Web Speech API von Chrome): Klick startet, erneuter Klick beendet -----
  const speechRec = () => window.SpeechRecognition || window.webkitSpeechRecognition;   // beim Klick gelesen
  let dict = null;

  function dictationError(code) {
    if (code === "not-allowed" || code === "service-not-allowed") return "Mikrofon abgelehnt. Klicken Sie in Chrome auf das Symbol links von der Adresse, erlauben Sie das Mikrofon für diese Seite und versuchen Sie es erneut.";
    if (code === "no-speech") return "Keine Sprache erkannt: Sprechen Sie deutlich ins Mikrofon.";
    if (code === "audio-capture") return "Kein Mikrofon erkannt. Schließen Sie ein Mikrofon oder Headset an und versuchen Sie es erneut.";
    if (code === "network") return "Das Diktat von Chrome braucht Internet (der Spracherkennungsdienst läuft online). Schreiben Sie die Nachricht mit der Tastatur.";
    return "Diktat nicht möglich (" + code + "). Schreiben Sie die Nachricht mit der Tastatur.";
  }
  /** Ein Klick startet das Diktat, ein zweiter beendet es (die Schaltfläche muss nicht gehalten werden). */
  function setTalkUi(state) {
    setBarMode(state === "rec" ? "dict" : "idle");
  }

  /**
   * Chrome beendet eine Erkennungssitzung von selbst nach einer kurzen Pause (einige Sekunden ohne Sprache) oder nach einer
   * gewissen Zeit. Solange Sie nicht erneut auf das Mikrofon geklickt haben, starten wir die Erkennung neu und behalten den bereits diktierten Text.
   */
  function startDictation() {
    if (dict || vrec || !voice.ready) return;
    if (!speechRec()) { voiceMsg("Das Diktat gibt es in diesem Browser nicht (nutzen Sie Chrome): Schreiben Sie die Nachricht mit der Tastatur.", "err"); return; }
    const s = { r: null, cancel: false, stopping: false, base: $("wa-input").value.trim(), committed: $("wa-input").value.trim(), t0: Date.now(), timer: null, failed: false, quick: 0 };
    dict = s;

    function finish() {
      clearInterval(s.timer);
      dict = null;
      setTalkUi("idle");
      if (s.cancel) { $("wa-input").value = s.base; updateComposer(); voiceMsg("Diktat abgebrochen."); return; }
      updateComposer();
      if (!s.failed) voiceMsg($("wa-input").value.trim() ? "Lesen Sie den Text noch einmal, korrigieren Sie ihn bei Bedarf und drücken Sie dann auf Senden." : "Keine Sprache erkannt: Sprechen Sie, oder schreiben Sie die Nachricht mit der Tastatur.");
    }

    function begin() {
      const r = new (speechRec())();
      const started = Date.now();
      s.r = r;
      r.lang = "de-DE";
      r.interimResults = true;
      r.continuous = true;
      r.onresult = (e) => {
        let t = "";
        for (let i = 0; i < e.results.length; i++) t += e.results[i][0].transcript;
        $("wa-input").value = (s.committed ? s.committed + " " : "") + t.trim();
        updateComposer();
      };
      r.onerror = (e) => {
        if (e.error === "no-speech" || e.error === "aborted") return;   // Stille oder Neustart: Wir hören weiter zu
        s.failed = true;
        s.stopping = true;
        voiceMsg(dictationError(e.error), "err");
      };
      r.onend = () => {
        if (s.stopping || s.cancel) { finish(); return; }
        // Unerwartetes Ende der Sitzung: Wir behalten den Text und starten neu (außer sie scheitert fortlaufend)
        s.committed = $("wa-input").value.trim();
        s.quick = Date.now() - started < 400 ? s.quick + 1 : 0;
        if (s.quick >= 3) { s.failed = true; voiceMsg("Das Diktat bricht ständig ab: Prüfen Sie Mikrofon und Internetverbindung, oder schreiben Sie mit der Tastatur.", "err"); finish(); return; }
        setTimeout(() => { if (dict !== s) return; try { begin(); } catch (err) { s.failed = true; voiceMsg("Diktat unterbrochen: " + err.message, "err"); finish(); } }, 150);
      };
      r.start();
    }

    try { begin(); } catch (e) { dict = null; voiceMsg("Diktat nicht möglich: " + e.message, "err"); return; }
    setTalkUi("rec");
    voiceMsg("Sprechen Sie … höchstens 10 s: Klicken Sie erneut auf das Mikrofon, um früher zu beenden. Der Text erscheint im Eingabefeld.");
    s.timer = setInterval(() => {
      const ms = Date.now() - s.t0;
      $("voice-timer").textContent = clock(ms / 1000);
      if (ms >= DICTEE_MAX_MS) stopDictation(false);
    }, 200);
  }
  function stopDictation(cancel) {
    if (!dict) return;
    dict.stopping = true;
    if (cancel) { dict.cancel = true; try { dict.r.abort(); } catch (e) { /* bereits gestoppt */ } return; }
    try { dict.r.stop(); } catch (e) { /* bereits gestoppt */ }
  }

  // Mikrofon-Schaltfläche: Ein Klick startet, ein Klick beendet; „Abbrechen“ oder Esc bricht das Diktat ab
  $("btn-talk").addEventListener("click", () => { if (dict) stopDictation(false); else startDictation(); });
  $("btn-dict-cancel").addEventListener("click", () => { if (vrec) stopVoiceRecord(true); else stopDictation(true); });
  $("btn-rec-ok").addEventListener("click", () => { if (vrec) stopVoiceRecord(false); else stopDictation(false); });
  document.addEventListener("keydown", (e) => { if (e.key !== "Escape") return; if (dict) stopDictation(true); else if (vrec) stopVoiceRecord(true); });

  // ----- Sprachnachricht für das Gerät: WAV-Aufnahme 8 kHz mono (vom Gerät unverändert abgespielt, ohne Umwandlung) -----
  // Das Audio geht an das Sprach-Relay; das Gerät wird per LoRaWAN-Downlink von einem Byte (Port 5) benachrichtigt und lädt es dann per WLAN herunter.
  const VOCAL_MAX_MS = 10000, VOCAL_MIN_MS = 600, WAV_HZ = 8000;
  let vrec = null;

  /** Float32 mono (Originalfrequenz) -> WAV PCM 16 Bit 8 kHz: Mittelwert je Fenster, also ohne grobe Spiegelfrequenzen. */
  function wavFromFloats(chunks, inRate) {
    let total = 0;
    chunks.forEach((c) => { total += c.length; });
    const ratio = inRate / WAV_HZ;
    const n = Math.floor(total / ratio);
    const flat = new Float32Array(total);
    let off = 0;
    chunks.forEach((c) => { flat.set(c, off); off += c.length; });
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const w = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, WAV_HZ, true); v.setUint32(28, WAV_HZ * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(total, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let k = a; k < b; k++) sum += flat[k];
      const x = Math.max(-1, Math.min(1, sum / (b - a)));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function micErrorText(e) {
    const n = e && e.name;
    if (n === "NotAllowedError" || n === "SecurityError") return "Mikrofon abgelehnt: Erlauben Sie es für diese Seite (Symbol links von der Adresse in Chrome) und versuchen Sie es erneut.";
    if (n === "NotFoundError") return "Kein Mikrofon erkannt.";
    if (n === "NotReadableError") return "Mikrofon nicht verfügbar (von einer anderen Anwendung benutzt).";
    return "Mikrofon nicht nutzbar: " + ((e && e.message) || e);
  }

  async function startVoiceRecord() {
    if (vrec || dict || !voice.ready) return;
    if (!window.isSecureContext || !navigator.mediaDevices || !(window.AudioContext || window.webkitAudioContext)) { voiceMsg("Mikrofon nicht verfügbar: Öffnen Sie die Seite mit Chrome unter http://localhost:8080/web/.", "err"); return; }
    const s = { stream: null, ctx: null, node: null, chunks: [], t0: 0, timer: null };
    vrec = s;
    try { s.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (e) { vrec = null; voiceMsg(micErrorText(e), "err"); return; }
    try {
      s.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = s.ctx.createMediaStreamSource(s.stream);
      s.node = s.ctx.createScriptProcessor(4096, 1, 1);
      s.node.onaudioprocess = (e) => { s.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
      const mute = s.ctx.createGain();
      mute.gain.value = 0;   // der Prozessor muss mit dem Ausgang verbunden sein, um zu laufen, aber wir hören uns nicht selbst
      src.connect(s.node); s.node.connect(mute); mute.connect(s.ctx.destination);
    } catch (e) { s.stream.getTracks().forEach((t) => t.stop()); vrec = null; voiceMsg("Aufnahme nicht möglich: " + e.message, "err"); return; }
    s.t0 = Date.now();
    setBarMode("vrec");
    voiceMsg("Aufnahme … klicken Sie zum Beenden auf „Senden“ (höchstens 10 s).");
    s.timer = setInterval(() => {
      const ms = Date.now() - s.t0;
      $("voice-timer").textContent = clock(Math.min(ms, VOCAL_MAX_MS) / 1000);
      if (ms >= VOCAL_MAX_MS) stopVoiceRecord(false);
    }, 100);
  }

  async function stopVoiceRecord(cancel) {
    const s = vrec;
    if (!s) return;
    vrec = null;
    clearInterval(s.timer);
    const ms = Math.min(Date.now() - s.t0, VOCAL_MAX_MS);
    const rate = s.ctx.sampleRate;
    try { s.node.disconnect(); } catch (e) { /* bereits getrennt */ }
    s.stream.getTracks().forEach((t) => t.stop());
    s.ctx.close().catch(() => {});
    setBarMode("idle");
    if (cancel) { voiceMsg("Aufnahme abgebrochen."); return; }
    if (ms < VOCAL_MIN_MS) { voiceMsg("Sprachnachricht zu kurz."); return; }
    $("btn-voice").disabled = true;
    try {
      const blob = wavFromFloats(s.chunks, rate);
      const r = await vFetch("", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
      voice.urls.set(j.id, URL.createObjectURL(blob));   // das Anhören unserer eigenen Nachricht lädt nichts erneut herunter
      addVoice({ id: j.id, at: j.at, from: "page", duration: j.duration, delivered: false, heard: false, lora: "queued" }, false);
      log("Sprachnachricht gespeichert (" + clock(j.duration) + "): Das Gerät wird per LoRaWAN benachrichtigt", "ok");
      queueText(j.id);
    } catch (e) {
      log("Sprachnachricht nicht gespeichert: " + e.message, "err");
      voiceMsg("Sprachnachricht nicht gesendet: " + e.message, "err");
    } finally { $("btn-voice").disabled = !voice.ready; }
  }
  $("btn-voice").addEventListener("click", () => { if (vrec) stopVoiceRecord(false); else startVoiceRecord(); });


  // ----- Verbindung zum Relay: Verlauf, dann Ereignisstrom -----
  async function loadVoiceHistory() {
    const r = await vFetch("?since=" + voice.lastId);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      const err = new Error(r.status === 503 ? (j.error || "Sprachnachrichten deaktiviert") : "HTTP " + r.status);
      err.status = r.status;
      throw err;
    }
    const j = await r.json();
    voice.retention = j.retentionDays || voice.retention;
    $("voice-privacy").textContent = "Eine Stimme ist ein sensibles personenbezogenes Datum. Die Aufnahmen bleiben auf diesem Computer (Ordner data/voice/), werden nach " +
      voice.retention + (voice.retention > 1 ? " Tagen" : " Tag") + " gelöscht und an keinen Dritten gesendet. Ausnahme: Das Diktat (Mikrofon-Schaltfläche) nutzt den Spracherkennungsdienst von Chrome, der das Gesagte an Google sendet; um zu 100 % lokal zu bleiben, schreiben Sie mit der Tastatur.";
    const first = voice.lastId === 0;
    j.messages.forEach((m) => addVoice(m, !first));
    if (first) {
      const n = j.messages.filter((m) => m.from === "device" && !m.heard).length;
      if (n) log(n + " Sprachnachricht(en) des Patienten noch nicht angehört.", "warn");
    }
  }

  function openVoiceStream() {
    if (voice.es) voice.es.close();
    const es = new EventSource(VOICE_URL + "/stream");
    voice.es = es;
    es.addEventListener("open", async () => {
      voiceStatus("Sprach-Relay verbunden", "ok");
      try { await loadVoiceHistory(); } catch (e) { /* der Strom bleibt offen, die Liste wird bei der nächsten Wiederverbindung nachgeladen */ }
    });
    es.addEventListener("message", (e) => { try { addVoice(JSON.parse(e.data), true); } catch (err) { /* Ereignis unlesbar */ } });
    es.addEventListener("update", (e) => { try { addVoice(JSON.parse(e.data), false); } catch (err) { /* Ereignis unlesbar */ } });
    es.addEventListener("error", () => voiceStatus("Sprachstrom unterbrochen, Wiederverbindung …", "err"));
  }

  async function voiceInit() {
    $("voice-status").className = "hint";
    if (location.protocol === "file:") {
      voiceStatus("Sprach-Relay nicht verfügbar: Seite als einfache Datei geöffnet. Öffnen Sie http://localhost:8080/web/ nach „node start.js“.", "err");
      return;
    }
    try {
      await loadVoiceHistory();
      voice.ready = true;
      $("btn-talk").disabled = false;
      $("btn-voice").disabled = false;
      updateComposer();
      renderChat();
      voiceStatus("Sprach-Relay verbunden", "ok");
      openVoiceStream();
    } catch (e) {
      if (e.status === 503) { voiceStatus("Sprachnachrichten deaktiviert (VOICE_ENABLED=0 in tools/voice.env).", "err"); return; }
      const why = e.status === 404 || e.status === 501 || e.status === 405
        ? "dieser Server hat kein Sprach-Relay: Starten Sie „node start.js“"
        : (e.message === "Failed to fetch" ? "Relay nicht erreichbar" : e.message);
      voiceStatus("Sprach-Relay offline (" + why + "). Neuer Versuch in 10 s.", "err");
      setTimeout(voiceInit, 10000);
    }
  }

  // ---------- Start ----------
  window.addEventListener("beforeunload", stopMqtt);
  evaluate();
  // Laden der Zone (gespeichert oder Standard), Karte darauf eingestellt, Zone gesperrt (statisch)
  {
    const z = loadZone();
    zonePoints = z.points.map((a) => L.latLng(a[0], a[1]));
    autoOrder = z.auto;
    $("opt-auto-order").checked = autoOrder;
    setEditing(false);
    fitZone();
  }
  log("Seite bereit. Zone: " + zoneInfoText(), "");
  scheduleCenterPlace();
  connectMqtt();
  voiceInit();
})();
