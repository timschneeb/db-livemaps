/* Zuglage – Live-Karte. Vanilla JS + Leaflet. */

const CAT_COLORS = {
  S: "#008d4f",
  RB: "#e2001a",
  IC: "#8a1538",
  BUS: "#7c3aed",
  OTHER: "#64748b",
};

const CAT_LABELS = {
  S: "S-Bahn",
  RB: "Regionalbahn",
  RE: "Regionalexpress",
  IC: "Fernverkehr",
  ICE: "Fernverkehr",
  EC: "Fernverkehr",
  BUS: "Bus / SEV",
};

const CATS = [
  { key: "all", label: "Alle" },
  { key: "S", label: "S-Bahn" },
  { key: "RB", label: "RB / RE" },
  { key: "IC", label: "IC / ICE" },
  { key: "BUS", label: "Bus" },
  { key: "OTHER", label: "Sonstige" },
];

/* Auf GitHub Pages liegt nur das Frontend; API und Feed laufen weiter auf
   db-map.timschneeberger.me. Lokal und auf dem Backend bleiben die Pfade
   relativ. `?api=https://…` eignet sich zum Testen einer anderen API. */
const API_BASE = (
  new URLSearchParams(location.search).get("api") ||
  (location.hostname.endsWith("github.io") ? "https://db-map.timschneeberger.me" : "")
).replace(/\/+$/, "");

function apiUrl(path) {
  return API_BASE ? `${API_BASE}${path}` : path;
}

function websocketUrl() {
  if (API_BASE) {
    const base = new URL(API_BASE);
    const proto = base.protocol === "https:" ? "wss" : "ws";
    return `${proto}://${base.host}/ws`;
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}

const map = L.map("map", { zoomControl: false, preferCanvas: true })
  .setView([51.16, 10.45], 6);

/* Nur auf Geräten mit echten Hover-Eingaben Tooltips anbinden. */
const canHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

/* CARTO Positron (light) – kostenloser Key, max. 5 Mio. Kacheln/Monat. */
const CARTO_KEY = "cb1_4yqg_1_dacebb987b5343904b8ec78b";
L.tileLayer(
  `https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png?key=${CARTO_KEY}`,
  {
    maxZoom: 20,
    detectRetina: true,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }
).addTo(map);

L.control.zoom({ position: "bottomleft" }).addTo(map);

const routePane = map.createPane("routes");
/* Unter der Marker-Leinwand (overlayPane = 400), damit der angefahrene
   Zug immer sichtbar bleibt; die Strecke ist nur Dekoration. */
routePane.style.zIndex = 350;
routePane.style.pointerEvents = "none";
const routeRenderer = L.svg({ pane: "routes" });

const canvasRenderer = L.canvas({ padding: 0.45 });
const markersLayer = L.layerGroup().addTo(map);
const trailsLayer = L.layerGroup().addTo(map);

/* Dünne Linien aller Züge – eigene Ebene unter der ausgewählten Strecke. */
const thinPane = map.createPane("thinroutes");
thinPane.style.zIndex = 340;
thinPane.style.pointerEvents = "none";
const thinRenderer = L.canvas({ pane: "thinroutes", padding: 0.35 });
const thinLayer = L.layerGroup().addTo(map);

/* Spuren – unter den Markern, aber über den dünnen Linien. */
const trailPane = map.createPane("trails");
trailPane.style.zIndex = 345;
trailPane.style.pointerEvents = "none";
const trailRenderer = L.canvas({ pane: "trails", padding: 0.4 });

/* Eigener Standort – unter den Markern und ohne Klickfänger. Sonst legt
   Leaflet für den Genauigkeitskreis eine zweite Leinwand über die Marker
   und schluckt alle Klicks. */
const locationPane = map.createPane("location");
locationPane.style.zIndex = 390;
locationPane.style.pointerEvents = "none";
const locationRenderer = L.canvas({ pane: "location" });

/* Zugnamen und Geschwindigkeit – über den Markern, aber ohne Klicks zu
   fangen. Wird als eigene Leinwand gezeichnet, damit hunderte Labels nicht
   als DOM-Elemente an jedem Marker hängen. */
const labelPane = map.createPane("labels");
labelPane.style.zIndex = 405;
labelPane.style.pointerEvents = "none";
const labelCanvas = document.createElement("canvas");
labelCanvas.className = "train-labels leaflet-zoom-hide";
labelPane.appendChild(labelCanvas);
const labelCtx = labelCanvas.getContext("2d");

const state = {
  positions: new Map(),
  markers: new Map(),
  trails: new Map(),
  trailLines: new Map(),
  routeLayer: null,
  routeId: null,
  colorExact: new Map(),
  colorByLine: new Map(),
  adminToRegion: {},
  filter: { cat: "all", q: "", op: "", region: "", sensor: false, trails: false, allLines: false },
  thinLines: new Map(),
  geoCache: new Map(),
  geoQueue: [],
  geoQueued: new Set(),
  geoFailed: new Set(),
  geoActive: 0,
  lastCatsUpdate: 0,
  fitPending: false,
};

const $ = (id) => document.getElementById(id);
const el = {
  status: $("status"),
  shown: $("stat-shown"),
  rate: $("stat-rate"),
  evus: $("stat-evus"),
  search: $("search"),
  cats: $("cats"),
  operator: $("operator"),
  region: $("region"),
  sensor: $("sensorOnly"),
  allLines: $("allLines"),
  allLinesCount: $("allLinesCount"),
  trails: $("trails"),
  panel: $("panel"),
  panelToggle: $("panel-toggle"),
};

/* ------------------------------------------------------------------ */
/* Filter                                                              */
/* ------------------------------------------------------------------ */

function categoryGroup(p) {
  const c = (p.cat || "").toUpperCase();
  if (c === "S") return "S";
  if (c.startsWith("RB") || c.startsWith("RE")) return "RB";
  if (c.includes("ICE") || c === "IC" || c === "EC") return "IC";
  if (c === "BUS" || c === "SEV") return "BUS";
  return "OTHER";
}

function matches(p) {
  const f = state.filter;
  if (f.cat !== "all" && categoryGroup(p) !== f.cat) return false;
  if (f.sensor && p.src !== "SENSOR") return false;
  if (f.op && p.op !== f.op) return false;
  if (f.region) {
    const regions = (p.adm || []).map((a) => state.adminToRegion[a]);
    if (!regions.includes(f.region)) return false;
  }
  if (f.q) {
    const hay = `${p.line || ""} ${p.op || ""} ${p.orig || ""} ${p.dest || ""}`.toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Farben                                                              */
/* ------------------------------------------------------------------ */

function buildColorIndex(lines) {
  state.colorExact.clear();
  state.colorByLine.clear();
  for (const l of lines || []) {
    if (!l.line || !l.color) continue;
    state.colorByLine.set(l.line, l.color);
    for (const a of l.admins || []) state.colorExact.set(`${a}|${l.line}`, l.color);
  }
}

function readableColor(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  if (s < 0.25 || l > 0.72 || l < 0.2) return null; // grau/zu hell/zu dunkel
  return hex;
}

function colorFor(p) {
  for (const a of p.adm || []) {
    const c = readableColor(state.colorExact.get(`${a}|${p.line}`));
    if (c) return c;
  }
  return CAT_COLORS[categoryGroup(p)] || CAT_COLORS.OTHER;
}

function textOn(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#0f172a" : "#ffffff";
}

/* ------------------------------------------------------------------ */
/* Popup + Strecke                                                     */
/* ------------------------------------------------------------------ */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function ageLabel(p) {
  // Alter seit dem letzten Snapshot weiterlaufen lassen, damit die Anzeige
  // im offenen Popup jede Sekunde tickt, ohne auf neue Daten zu warten.
  const sec = Math.max(0, (p.age || 0) + (Date.now() - (p._at || Date.now())) / 1000);
  if (sec < 2) return "gerade eben";
  if (sec < 60) return `vor ${Math.round(sec)} s`;
  return `vor ${Math.round(sec / 60)} min`;
}

function popupHtml(p) {
  if (!p) return "";
  const color = colorFor(p);
  return `
    <div class="pop-head">
      <span class="pop-line" style="background:${color};color:${textOn(color)}">${esc(p.line || p.cat || "?")}</span>
      <span class="pop-title">${esc(CAT_LABELS[p.cat] || p.cat || "Zug")}</span>
    </div>
    <div class="pop-op">${esc(p.op || "unbekanntes EVU")}</div>
    <div class="pop-route">${esc(p.orig || "?")} <span style="color:#94a3b8">→</span> ${esc(p.dest || "?")}</div>
    <div class="pop-meta">
      <span class="pop-speed" ${p.spd == null ? "hidden" : ""}>${p.spd != null ? `${esc(p.spd)} km/h` : ""}</span>
      <span>${p.src === "SENSOR" ? "GPS" : "geschätzt"}</span>
      <span class="pop-age" data-id="${esc(p.id)}">${ageLabel(p)}</span>
    </div>
    <div class="pop-hint" id="hint-${esc(p.id)}"></div>`;
}

async function loadRoute(id) {
  if (state.routeId === id) return;
  state.routeId = id;
  const p = state.positions.get(id);

  const setHint = (text, isError = false) => {
    const hint = document.getElementById(`hint-${id}`);
    if (!hint) return;
    hint.className = "pop-hint" + (isError ? " err" : "");
    hint.textContent = text;
  };
  setHint("");

  try {
    const res = await fetch(apiUrl(`/api/geometry/${encodeURIComponent(id)}`));
    if (!res.ok) throw new Error((await res.json()).detail || `HTTP ${res.status}`);
    const geo = await res.json();
    if (state.routeId !== id) return;
    drawRoute(geo.coordinates, colorFor(p || {}));
  } catch (err) {
    if (state.routeId === id) state.routeId = null;
    setHint(`Keine Streckendaten (${err.message})`, true);
  }
}

function clearRoute() {
  if (state.routeLayer) {
    map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  state.routeId = null;
}

function drawRoute(coords, color) {
  if (state.routeLayer) {
    map.removeLayer(state.routeLayer);
    state.routeLayer = null;
  }
  if (!coords || !coords.length) return;
  const latlngs = coords.map(([lon, lat]) => [lat, lon]);
  const group = L.layerGroup();
  L.polyline(latlngs, {
    pane: "routes", renderer: routeRenderer, color: "#ffffff", weight: 7, opacity: 0.65, interactive: false,
  }).addTo(group);
  L.polyline(latlngs, {
    pane: "routes", renderer: routeRenderer, color, weight: 3.5, opacity: 0.55, interactive: false,
  }).addTo(group);
  group.addTo(map);
  state.routeLayer = group;
}

/* ------------------------------------------------------------------ */
/* Marker                                                              */
/* ------------------------------------------------------------------ */

function tooltipFor(p) {
  return `${p.line || "?"} · ${p.op || ""}`;
}

function radiusForZoom() {
  const z = map.getZoom();
  if (z <= 6) return 4.2;
  if (z <= 8) return 5.2;
  if (z <= 10) return 6.2;
  return 7.2;
}

/* ------------------------------------------------------------------ */
/* Zugnamen an den Punkten                                             */
/* ------------------------------------------------------------------ */

/* Erst ab dieser Stufe ist genug Platz zwischen den Punkten, und erst
   dann sind die Namen überhaupt lesbar. */
const LABEL_MIN_ZOOM = 7;
const LABEL_MAX = 90;
const LABEL_FONT_NAME = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
const LABEL_FONT_SPEED = '500 10px system-ui, -apple-system, "Segoe UI", sans-serif';
let labelFrame = 0;

function scheduleLabels() {
  if (labelFrame) return;
  labelFrame = requestAnimationFrame(() => {
    labelFrame = 0;
    drawLabels();
  });
}

function drawLabels() {
  const size = map.getSize();
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const pw = Math.round(size.x * dpr);
  const ph = Math.round(size.y * dpr);
  if (labelCanvas.width !== pw || labelCanvas.height !== ph) {
    labelCanvas.width = pw;
    labelCanvas.height = ph;
    labelCanvas.style.width = `${size.x}px`;
    labelCanvas.style.height = `${size.y}px`;
  }
  L.DomUtil.setPosition(labelCanvas, map.containerPointToLayerPoint([0, 0]));
  labelCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  labelCtx.clearRect(0, 0, size.x, size.y);
  if (map.getZoom() < LABEL_MIN_ZOOM) return;

  const cx = size.x / 2;
  const cy = size.y / 2;
  const items = [];
  for (const p of state.positions.values()) {
    if (!matches(p)) continue;
    const pt = map.latLngToContainerPoint([p.lat, p.lon]);
    if (pt.x < -20 || pt.y < -20 || pt.x > size.x + 20 || pt.y > size.y + 20) continue;
    items.push({ p, x: pt.x, y: pt.y, d: (pt.x - cx) ** 2 + (pt.y - cy) ** 2 });
  }
  /* In der Mitte zuerst, damit bei Platzmangel die sichtbarsten Namen
     gewinnen und nicht zufällig die am Kartenrand. */
  items.sort((a, b) => a.d - b.d);

  const boxes = [];
  let drawn = 0;
  const r = radiusForZoom();

  labelCtx.textBaseline = "middle";
  labelCtx.lineJoin = "round";

  for (const it of items) {
    if (drawn >= LABEL_MAX) break;
    const name = it.p.line || it.p.cat || "Zug";
    const speed = it.p.spd != null ? `${it.p.spd} km/h` : "";

    labelCtx.font = LABEL_FONT_NAME;
    const nameW = labelCtx.measureText(name).width;
    labelCtx.font = LABEL_FONT_SPEED;
    const speedW = speed ? labelCtx.measureText(speed).width : 0;
    const boxW = Math.max(nameW, speedW) + 6;
    const boxH = speed ? 23 : 14;

    /* Rechts neben den Punkt; wenn dort kein Platz ist, nach links. */
    let x = it.x + r + 5;
    if (x + boxW > size.x - 4) x = it.x - r - 5 - boxW;
    if (x < 2) continue;
    const y = it.y - boxH / 2;

    /* Genug Platz heißt: kein anderer Zug und kein anderes Label im Weg. */
    let blocked = false;
    for (const other of items) {
      if (other === it) continue;
      if (other.x > x - 3 && other.x < x + boxW + 3 &&
          other.y > y - 3 && other.y < y + boxH + 3) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    if (boxes.some((b) =>
      x < b.x + b.w + 3 && x + boxW + 3 > b.x &&
      y < b.y + b.h + 3 && y + boxH + 3 > b.y)) continue;

    boxes.push({ x, y, w: boxW, h: boxH });
    drawn++;

    /* Weißer Halo hält den Namen auch auf hellen Karten lesbar.
       Die Geschwindigkeit steht in einer zweiten, kleineren Zeile darunter. */
    const tx = x + 3;
    const nameY = speed ? it.y - 5.5 : it.y;
    labelCtx.font = LABEL_FONT_NAME;
    labelCtx.lineWidth = 3;
    labelCtx.strokeStyle = "rgba(255, 255, 255, 0.92)";
    labelCtx.strokeText(name, tx, nameY);
    labelCtx.fillStyle = "#0f172a";
    labelCtx.fillText(name, tx, nameY);
    if (speed) {
      labelCtx.font = LABEL_FONT_SPEED;
      labelCtx.strokeText(speed, tx, it.y + 6);
      labelCtx.fillStyle = "#475569";
      labelCtx.fillText(speed, tx, it.y + 6);
    }
  }
}

function ensureMarker(p) {
  let m = state.markers.get(p.id);
  if (!m) {
    m = L.circleMarker([p.lat, p.lon], {
      renderer: canvasRenderer,
      radius: radiusForZoom(),
      weight: 1.6,
      color: "#ffffff",
      fillColor: colorFor(p),
      fillOpacity: 0.95,
    });
    if (canHover) {
      m.bindTooltip(() => tooltipFor(state.positions.get(p.id) || p), {
        direction: "top", offset: [0, -4], opacity: 0.9,
      });
    }
    m.bindPopup(() => popupHtml(state.positions.get(p.id)), {
      closeButton: false, offset: [0, -2], maxWidth: 280,
    });
    /* Auf Touch-Geräten öffnet der Tap sonst Tooltip und Popup gleichzeitig.
       Leaflet öffnet den Tooltip per eigenem Click-Handler; deshalb verzögert
       schließen, damit er nach dem Popup nicht wieder erscheint. */
    m.on("popupopen", () => {
      m.closeTooltip();
      setTimeout(() => m.closeTooltip(), 0);
    });
    m.on("click", () => loadRoute(p.id));
    m.addTo(markersLayer);
    state.markers.set(p.id, m);
  }
  m.setLatLng([p.lat, p.lon]);
  const stale = p.age > 240 ? 0.35 : p.age > 90 ? 0.6 : 1;
  m.setStyle({ fillColor: colorFor(p), opacity: stale, fillOpacity: 0.95 * stale });
  return m;
}

function applySnapshot(positions) {
  const seen = new Set();
  const live = new Set();
  let evus = new Set();
  const recvAt = Date.now();

  for (const p of positions) {
    p._at = recvAt;
    live.add(p.id);
    state.positions.set(p.id, p);
    if (!matches(p)) continue;
    seen.add(p.id);
    ensureMarker(p);
    if (p.op) evus.add(p.op);
    updateTrail(p);
  }

  /* Fahrten, die nicht mehr im Snapshot stehen, komplett entfernen.
     Sonst wachsen Marker-/Spur-Speicher unbegrenzt und alte Spuren
     bleiben als Geister auf der Karte. */
  for (const [id, marker] of state.markers) {
    if (!seen.has(id)) {
      markersLayer.removeLayer(marker);
      state.markers.delete(id);
      const line = state.trailLines.get(id);
      if (line) { trailsLayer.removeLayer(line); state.trailLines.delete(id); }
    }
  }
  for (const id of [...state.positions.keys()]) {
    if (live.has(id)) continue;
    state.positions.delete(id);
    state.trails.delete(id);
    const line = state.trailLines.get(id);
    if (line) { trailsLayer.removeLayer(line); state.trailLines.delete(id); }
  }

  el.shown.textContent = seen.size;
  el.evus.textContent = evus.size;

  if (state.fitPending && seen.size) {
    const points = [...seen].map((id) => {
      const p = state.positions.get(id);
      return [p.lat, p.lon];
    });
    map.fitBounds(L.latLngBounds(points).pad(0.15), { animate: true });
    state.fitPending = false;
  }

  const now = Date.now();
  if (now - state.lastCatsUpdate > 2500) {
    state.lastCatsUpdate = now;
    renderChips(positions);
    renderOperators(positions);
  }
  syncThinLines();
  refreshPopupMeta();
  scheduleLabels();
}

/* ------------------------------------------------------------------ */
/* Spuren                                                              */
/* ------------------------------------------------------------------ */

const TRAIL_MAX_POINTS = 60;
let trailPollTimer = null;

function trailStyle(p) {
  return {
    pane: "trails",
    renderer: trailRenderer,
    color: colorFor(p),
    weight: 2,
    opacity: 0.55,
    interactive: false,
  };
}

function updateTrail(p) {
  const trail = state.trails.get(p.id) || [];
  const last = trail[trail.length - 1];
  if (!last || Math.abs(last[0] - p.lat) > 1e-4 || Math.abs(last[1] - p.lon) > 1e-4) {
    trail.push([p.lat, p.lon]);
    if (trail.length > TRAIL_MAX_POINTS) trail.shift();
    state.trails.set(p.id, trail);
  }
  if (!state.filter.trails) return;

  let line = state.trailLines.get(p.id);
  if (!line) {
    if (trail.length < 2) return;
    line = L.polyline(trail, trailStyle(p)).addTo(trailsLayer);
    state.trailLines.set(p.id, line);
  } else {
    line.setLatLngs(trail);
    line.setStyle(trailStyle(p));
  }
}

/* Der Server haelt die Spur-Historie (letzte 15 Minuten). Damit sind Spuren
   sofort nach dem Laden sichtbar und lang genug fuer den Ueberblickszoom. */
async function loadTrails() {
  if (!state.filter.trails) return;
  try {
    const res = await fetch(apiUrl("/api/trails"));
    if (!res.ok) return;
    const data = await res.json();
    for (const [id, pts] of Object.entries(data.trails || {})) {
      if (!Array.isArray(pts) || pts.length < 2) continue;
      const trail = pts
        .filter((c) => Array.isArray(c) && c.length >= 2)
        .map(([lat, lon]) => [lat, lon]);
      const p = state.positions.get(id);
      if (p) {
        const tail = trail[trail.length - 1];
        if (tail[0] !== p.lat || tail[1] !== p.lon) trail.push([p.lat, p.lon]);
      }
      state.trails.set(id, trail.slice(-TRAIL_MAX_POINTS));
    }
  } catch { /* Spuren sind optional */ }
  if (state.filter.trails) syncTrailLines();
}

function syncTrailLines() {
  if (!state.filter.trails) return;
  for (const [id, line] of state.trailLines) {
    const p = state.positions.get(id);
    const trail = state.trails.get(id);
    if (!p || !matches(p) || !trail || trail.length < 2) {
      trailsLayer.removeLayer(line);
      state.trailLines.delete(id);
    }
  }
  for (const [id, p] of state.positions) {
    const trail = state.trails.get(id);
    if (!matches(p) || !trail || trail.length < 2) continue;
    updateTrail(p);
  }
}

function startTrailPolling() {
  stopTrailPolling();
  trailPollTimer = setInterval(loadTrails, 20000);
}

function stopTrailPolling() {
  if (trailPollTimer) {
    clearInterval(trailPollTimer);
    trailPollTimer = null;
  }
}

function clearTrails() {
  trailsLayer.clearLayers();
  state.trailLines.clear();
}

/* ------------------------------------------------------------------ */
/* UI                                                                  */
/* ------------------------------------------------------------------ */

function renderChips(positions) {
  const counts = { all: 0, S: 0, RB: 0, IC: 0, BUS: 0, OTHER: 0 };
  for (const p of positions) {
    counts.all += 1;
    counts[categoryGroup(p)] += 1;
  }
  el.cats.innerHTML = "";
  for (const c of CATS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (state.filter.cat === c.key ? " active" : "");
    b.innerHTML = `${c.label}<span class="n">${counts[c.key] ?? 0}</span>`;
    b.addEventListener("click", () => {
      state.filter.cat = c.key;
      el.cats.querySelectorAll(".chip").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      reprocess();
    });
    el.cats.appendChild(b);
  }
}

let operatorKey = "";
let pendingOperators = null;

function dropdownMayBeOpen() {
  if (document.activeElement === el.operator || document.activeElement === el.region) return true;
  // Auf Mobilgeräten kann der native Auswahldialog offen sein, ohne dass
  // zuverlässig ein Fokus-Event ankommt. Solange das Panel sichtbar ist,
  // bleiben die Listen deshalb unverändert.
  return window.matchMedia("(max-width: 860px)").matches && el.panel.classList.contains("open");
}

function applyOperators(sorted, key) {
  const current = el.operator.value;
  const values = new Set(sorted.map(([name]) => name));

  for (const option of [...el.operator.options]) {
    if (option.value && !values.has(option.value)) option.remove();
  }

  const existing = new Map([...el.operator.options].map((o) => [o.value, o]));
  for (const [name, n] of sorted) {
    let option = existing.get(name);
    if (!option) {
      option = document.createElement("option");
      option.value = name;
      existing.set(name, option);
    }
    const text = `${name} (${n})`;
    if (option.textContent !== text) option.textContent = text;
  }

  for (const [name] of sorted) el.operator.appendChild(existing.get(name));

  if ([...el.operator.options].some((o) => o.value === current)) {
    el.operator.value = current;
  } else {
    el.operator.value = "";
    state.filter.op = "";
  }
  operatorKey = key;
  pendingOperators = null;
}

function renderOperators(positions) {
  const counts = new Map();
  for (const p of positions) {
    if (p.op) counts.set(p.op, (counts.get(p.op) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const key = sorted.map(([n]) => n).join("|");
  if (key === operatorKey) {
    pendingOperators = null;
    return;
  }
  // Während der native Auswahldialog offen ist, keine Optionen anfassen:
  // Chromium schließt oder verwirrt den Dialog, wenn sich die Liste ändert.
  if (dropdownMayBeOpen()) {
    pendingOperators = { sorted, key };
    return;
  }
  applyOperators(sorted, key);
}

function flushOperators() {
  if (!pendingOperators || dropdownMayBeOpen()) return;
  const { sorted, key } = pendingOperators;
  applyOperators(sorted, key);
}

function reprocess() {
  applySnapshot([...state.positions.values()]);
}

/* ------------------------------------------------------------------ */
/* Linien aller Züge (dünn)                                            */
/* ------------------------------------------------------------------ */

const GEO_MAX_ACTIVE = 3;
const GEO_MAX_POINTS = 260;

function simplifyLatLngs(coords) {
  const step = Math.max(1, Math.ceil(coords.length / GEO_MAX_POINTS));
  const out = [];
  for (let i = 0; i < coords.length; i += step) {
    const c = coords[i];
    if (Array.isArray(c) && c.length >= 2) out.push([c[1], c[0]]);
  }
  const last = coords[coords.length - 1];
  if (Array.isArray(last) && last.length >= 2) {
    const tail = out[out.length - 1];
    if (!tail || tail[0] !== last[1] || tail[1] !== last[0]) out.push([last[1], last[0]]);
  }
  return out;
}

function updateThinCount() {
  const n = state.thinLines.size;
  const pending = state.geoActive + state.geoQueue.length;
  el.allLinesCount.textContent = n || pending ? `${n}${pending ? " …" : ""}` : "";
}

function addThinLine(id) {
  if (!state.filter.allLines || state.thinLines.has(id)) return;
  const p = state.positions.get(id);
  const latlngs = state.geoCache.get(id);
  if (!p || !latlngs || !latlngs.length || !matches(p)) return;
  const line = L.polyline(latlngs, {
    renderer: thinRenderer,
    pane: "thinroutes",
    color: colorFor(p),
    weight: 1.1,
    opacity: 0.45,
    interactive: false,
    smoothFactor: 1.6,
  });
  line.addTo(thinLayer);
  state.thinLines.set(id, line);
}

function pumpThin() {
  while (state.geoActive < GEO_MAX_ACTIVE && state.geoQueue.length) {
    const id = state.geoQueue.shift();
    state.geoActive++;
    fetch(apiUrl(`/api/geometry/${encodeURIComponent(id)}`))
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((geo) => {
        state.geoCache.set(id, simplifyLatLngs(geo.coordinates || []));
        addThinLine(id);
      })
      .catch(() => state.geoFailed.add(id))
      .finally(() => {
        state.geoActive--;
        state.geoQueued.delete(id);
        updateThinCount();
        pumpThin();
      });
  }
  updateThinCount();
}

function enqueueThinLines() {
  if (!state.filter.allLines) return;
  for (const [id, p] of state.positions) {
    if (state.geoCache.has(id) || state.geoQueued.has(id) || state.geoFailed.has(id)) continue;
    if (!matches(p)) continue;
    state.geoQueue.push(id);
    state.geoQueued.add(id);
  }
  pumpThin();
}

function syncThinLines() {
  if (!state.filter.allLines) return;
  for (const [id, line] of state.thinLines) {
    const p = state.positions.get(id);
    if (!p || !matches(p)) {
      thinLayer.removeLayer(line);
      state.thinLines.delete(id);
    }
  }
  for (const [id, p] of state.positions) {
    if (state.geoCache.has(id) && matches(p)) addThinLine(id);
  }
  enqueueThinLines();
  updateThinCount();
}

function clearThinLines() {
  thinLayer.clearLayers();
  state.thinLines.clear();
  state.geoQueue.length = 0;
  state.geoQueued.clear();
  updateThinCount();
}

function setStatus(kind, text) {
  el.status.textContent = text;
  el.status.className = kind || "";
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

let socket = null;

function connect() {
  socket = new WebSocket(websocketUrl());

  socket.onopen = () => {
    setStatus("live", "live verbunden");
    setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) socket.send("ping");
    }, 25000);
  };

  socket.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === "snapshot" || msg.type === "hello") {
      if (msg.stats) {
        el.rate.textContent = msg.stats.msg_per_s ?? "…";
        // Datenfluss ist das verlaesslichste Signal: paho reconnectet
        // teils ohne erneutes on_connect, dann haengt das Flag auf false.
        const flowing = msg.stats.last_message_age != null && msg.stats.last_message_age < 30;
        if (msg.stats.connected || flowing) setStatus("live", "live verbunden");
        else setStatus("lost", "Feed getrennt");
      }
      applySnapshot(msg.positions || []);
    }
  };

  socket.onclose = () => {
    setStatus("lost", "Verbindung verloren");
    setTimeout(connect, 2500);
  };

  socket.onerror = () => socket.close();
}

/* ------------------------------------------------------------------ */
/* Stammdaten                                                          */
/* ------------------------------------------------------------------ */

async function loadCatalog(retry = 0) {
  try {
    const res = await fetch(apiUrl("/api/catalog"));
    const data = await res.json();
    if (data.lines && data.lines.length) {
      buildColorIndex(data.lines);
      reprocess();
      return;
    }
  } catch { /* ignore */ }
  if (retry < 10) setTimeout(() => loadCatalog(retry + 1), 4000);
}

let pendingRegions = null;

function applyRegions(names) {
  const current = el.region.value;
  el.region.innerHTML = '<option value="">Ganz Deutschland</option>';
  for (const n of names) {
    const o = document.createElement("option");
    o.value = n;
    o.textContent = n.replaceAll("_", " ");
    el.region.appendChild(o);
  }
  if (current && [...el.region.options].some((o) => o.value === current)) {
    el.region.value = current;
  }
  pendingRegions = null;
}

function flushRegions() {
  if (!pendingRegions || dropdownMayBeOpen()) return;
  applyRegions(pendingRegions);
}

async function loadRegions(retry = 0) {
  try {
    const res = await fetch(apiUrl("/api/regions"));
    const data = await res.json();
    state.adminToRegion = data.adminToRegion || {};
    const names = Object.keys(data.regions || {}).sort();
    if (names.length) {
      // Nicht in eine bereits geöffnete Auswahlliste hineinschreiben.
      if (dropdownMayBeOpen()) pendingRegions = names;
      else applyRegions(names);
      return;
    }
  } catch { /* ignore */ }
  if (retry < 10) setTimeout(() => loadRegions(retry + 1), 5000);
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

el.search.addEventListener("input", () => {
  state.filter.q = el.search.value.trim().toLowerCase();
  reprocess();
});

el.operator.addEventListener("change", () => {
  state.filter.op = el.operator.value;
  reprocess();
});
el.operator.addEventListener("blur", flushOperators);

el.region.addEventListener("change", () => {
  state.filter.region = el.region.value;
  state.fitPending = Boolean(el.region.value);
  reprocess();
});
el.region.addEventListener("blur", flushRegions);

el.sensor.addEventListener("change", () => {
  state.filter.sensor = el.sensor.checked;
  reprocess();
});

el.allLines.addEventListener("change", () => {
  state.filter.allLines = el.allLines.checked;
  if (el.allLines.checked) syncThinLines();
  else clearThinLines();
});

el.trails.addEventListener("change", () => {
  state.filter.trails = el.trails.checked;
  if (!el.trails.checked) {
    stopTrailPolling();
    clearTrails();
  } else {
    reprocess();
    loadTrails();
    startTrailPolling();
  }
});

el.panelToggle.addEventListener("click", () => {
  const opening = !el.panel.classList.contains("open");
  if (opening) {
    flushOperators();
    flushRegions();
  }
  el.panel.classList.toggle("open");
  if (!opening) {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    flushOperators();
    flushRegions();
  }
});

map.on("zoomend", () => {
  const r = radiusForZoom();
  for (const m of state.markers.values()) m.setRadius(r);
  scheduleLabels();
});

/* Labels mit der Karte mitschieben (Pan) und bei Größenänderung neu setzen. */
map.on("move resize", scheduleLabels);

map.on("popupclose", () => {
  // Popup geschlossen (Karte angeklickt oder andere Fahrt) -> Strecke weg.
  clearRoute();
});

/* Alter und Geschwindigkeit im offenen Popup aktuell halten: bei jedem
   Snapshot und zusätzlich jede Sekunde (für das Alter). */
function refreshPopupMeta() {
  const ageSpan = document.querySelector(".leaflet-popup .pop-age[data-id]");
  if (!ageSpan) return;
  const p = state.positions.get(ageSpan.dataset.id);
  if (!p) return;
  const text = ageLabel(p);
  if (ageSpan.textContent !== text) ageSpan.textContent = text;

  const speedSpan = ageSpan.closest(".pop-meta")?.querySelector(".pop-speed");
  if (speedSpan) {
    if (p.spd != null) {
      const t = `${p.spd} km/h`;
      if (speedSpan.textContent !== t) speedSpan.textContent = t;
      speedSpan.hidden = false;
    } else {
      speedSpan.hidden = true;
    }
  }
}

setInterval(refreshPopupMeta, 1000);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") map.closePopup();
});

/* ------------------------------------------------------------------ */
/* Eigener Standort                                                    */
/* ------------------------------------------------------------------ */

const locate = { marker: null, circle: null };
let toastTimer = null;

function toast(text, ms = 4500) {
  const t = $("toast");
  if (!t) return;
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

const LocateControl = L.Control.extend({
  options: { position: "topright" },
  onAdd() {
    const wrap = L.DomUtil.create("div", "leaflet-bar locate-control");
    const btn = L.DomUtil.create("button", "", wrap);
    btn.type = "button";
    btn.title = "Zum eigenen Standort";
    btn.setAttribute("aria-label", "Zum eigenen Standort");
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">' +
      '<path fill="currentColor" d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm8.94 3A9.01 ' +
      '9.01 0 0 0 13 3.06V1h-2v2.06A9.01 9.01 0 0 0 3.06 11H1v2h2.06A9.01 9.01 0 0 ' +
      '0 11 20.94V23h2v-2.06A9.01 9.01 0 0 0 20.94 13H23v-2h-2.06zM12 19a7 7 0 1 1 ' +
      '0-14 7 7 0 0 1 0 14z"/></svg>';
    this._btn = btn;
    L.DomEvent.disableClickPropagation(wrap);
    L.DomEvent.disableScrollPropagation(wrap);
    L.DomEvent.on(btn, "click", (e) => {
      L.DomEvent.preventDefault(e);
      goToLocation();
    });
    return wrap;
  },
});

new LocateControl().addTo(map);

function onLocation(pos, { auto = false } = {}) {
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  if (!locate.marker) {
    locate.circle = L.circle([lat, lon], {
      pane: "location",
      renderer: locationRenderer,
      radius: accuracy,
      color: "#2563eb",
      weight: 1,
      opacity: 0.45,
      fillColor: "#2563eb",
      fillOpacity: 0.1,
      interactive: false,
    }).addTo(map);
    locate.marker = L.circleMarker([lat, lon], {
      pane: "location",
      renderer: locationRenderer,
      radius: 7,
      weight: 2.5,
      color: "#ffffff",
      fillColor: "#2563eb",
      fillOpacity: 1,
      interactive: false,
    }).addTo(map);
  } else {
    locate.marker.setLatLng([lat, lon]);
    locate.circle.setLatLng([lat, lon]).setRadius(accuracy);
  }
  map.setView([lat, lon], 10, { animate: !auto });
  if (!auto) toast("Standort gefunden.");
}

function onLocationError(err, { auto = false } = {}) {
  if (auto) return;
  const text =
    err && err.code === 1
      ? "Standortfreigabe wurde verweigert."
      : err && err.code === 3
        ? "Standortbestimmung dauert zu lange."
        : "Standort konnte nicht bestimmt werden.";
  toast(text);
}

function goToLocation({ auto = false } = {}) {
  if (!navigator.geolocation) {
    if (!auto) toast("Dieser Browser unterstützt keine Standortbestimmung.");
    return;
  }
  if (window.isSecureContext === false) {
    if (!auto) toast("Standort braucht HTTPS (oder localhost).");
    return;
  }
  /* Zugauswahl zurücksetzen: Ein offenes Popup folgt seinem Zug und würde
     die Karte sonst gleich wieder dorthin ziehen. Beim automatischen
     Zentrieren nach dem Laden gibt es noch keine Auswahl. */
  if (!auto) {
    map.closePopup();
    clearRoute();
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => onLocation(pos, { auto }),
    (err) => onLocationError(err, { auto }),
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 },
  );
}

/* Nur wenn die Freigabe schon erteilt wurde, ohne Nachfrage zentrieren.
   So erscheint beim ersten Besuch kein ungefragter Berechtigungsdialog. */
async function autoLocateIfGranted() {
  if (!navigator.geolocation || !navigator.permissions) return;
  if (window.isSecureContext === false) return;
  try {
    const permission = await navigator.permissions.query({ name: "geolocation" });
    if (permission.state === "granted") goToLocation({ auto: true });
  } catch { /* Browser kann den Status nicht abfragen */ }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */

renderChips([]);
connect();
loadCatalog();
loadRegions();
autoLocateIfGranted();

