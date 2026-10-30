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

const map = L.map("map", { zoomControl: false, preferCanvas: true })
  .setView([51.16, 10.45], 6);

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

L.control.zoom({ position: "bottomright" }).addTo(map);

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
    <div class="pop-hint" id="hint-${esc(p.id)}">${
      state.routeId === p.id ? "Strecke angezeigt" : "Strecke wird geladen …"
    }</div>`;
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
  setHint("Strecke wird geladen …");

  try {
    const res = await fetch(`/api/geometry/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error((await res.json()).detail || `HTTP ${res.status}`);
    const geo = await res.json();
    if (state.routeId !== id) return;
    drawRoute(geo.coordinates, colorFor(p || {}));
    setHint(`${geo.coordinates.length} Streckenpunkte`);
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
  if (z <= 6) return 3.2;
  if (z <= 8) return 4.2;
  if (z <= 10) return 5.2;
  return 6;
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
    m.bindTooltip(() => tooltipFor(state.positions.get(p.id) || p), {
      direction: "top", offset: [0, -4], opacity: 0.9,
    });
    m.bindPopup(() => popupHtml(state.positions.get(p.id)), {
      closeButton: false, offset: [0, -2], maxWidth: 280,
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
  let evus = new Set();
  const recvAt = Date.now();

  for (const p of positions) {
    p._at = recvAt;
    state.positions.set(p.id, p);
    if (!matches(p)) continue;
    seen.add(p.id);
    ensureMarker(p);
    if (p.op) evus.add(p.op);
    updateTrail(p);
  }

  for (const [id, marker] of state.markers) {
    if (!seen.has(id)) {
      markersLayer.removeLayer(marker);
      state.markers.delete(id);
      const line = state.trailLines.get(id);
      if (line) { trailsLayer.removeLayer(line); state.trailLines.delete(id); }
    }
  }
  for (const id of state.trails.keys()) {
    if (!state.positions.has(id)) state.trails.delete(id);
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
}

/* ------------------------------------------------------------------ */
/* Spuren                                                              */
/* ------------------------------------------------------------------ */

function updateTrail(p) {
  const trail = state.trails.get(p.id) || [];
  const last = trail[trail.length - 1];
  if (!last || Math.abs(last[0] - p.lat) > 1e-4 || Math.abs(last[1] - p.lon) > 1e-4) {
    trail.push([p.lat, p.lon]);
    if (trail.length > 30) trail.shift();
    state.trails.set(p.id, trail);
  }
  if (!state.filter.trails) return;

  let line = state.trailLines.get(p.id);
  if (!line) {
    line = L.polyline(trail, {
      renderer: canvasRenderer, color: colorFor(p), weight: 2, opacity: 0.4,
      interactive: false,
    }).addTo(trailsLayer);
    state.trailLines.set(p.id, line);
  } else if (trail.length > 1) {
    line.setLatLngs(trail);
    line.setStyle({ color: colorFor(p) });
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
function renderOperators(positions) {
  const counts = new Map();
  for (const p of positions) {
    if (p.op) counts.set(p.op, (counts.get(p.op) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const key = sorted.map(([n]) => n).join("|");
  if (key === operatorKey) return;
  operatorKey = key;
  const current = el.operator.value;
  el.operator.innerHTML = '<option value="">Alle EVUs</option>';
  for (const [name, n] of sorted) {
    const o = document.createElement("option");
    o.value = name;
    o.textContent = `${name} (${n})`;
    el.operator.appendChild(o);
  }
  if ([...el.operator.options].some((o) => o.value === current)) {
    el.operator.value = current;
  } else {
    state.filter.op = "";
  }
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
    fetch(`/api/geometry/${encodeURIComponent(id)}`)
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
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

let socket = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);

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
        el.rate.textContent = msg.stats.msg_per_s ?? "–";
        if (msg.stats.connected === false) setStatus("lost", "Feed getrennt");
        else setStatus("live", "live verbunden");
      }
      applySnapshot(msg.positions || []);
    }
  };

  socket.onclose = () => {
    setStatus("lost", "Verbindung verloren – neu verbinden …");
    setTimeout(connect, 2500);
  };

  socket.onerror = () => socket.close();
}

/* ------------------------------------------------------------------ */
/* Stammdaten                                                          */
/* ------------------------------------------------------------------ */

async function loadCatalog(retry = 0) {
  try {
    const res = await fetch("/api/catalog");
    const data = await res.json();
    if (data.lines && data.lines.length) {
      buildColorIndex(data.lines);
      reprocess();
      return;
    }
  } catch { /* ignore */ }
  if (retry < 10) setTimeout(() => loadCatalog(retry + 1), 4000);
}

async function loadRegions(retry = 0) {
  try {
    const res = await fetch("/api/regions");
    const data = await res.json();
    state.adminToRegion = data.adminToRegion || {};
    const names = Object.keys(data.regions || {}).sort();
    if (names.length) {
      el.region.innerHTML = '<option value="">Ganz Deutschland</option>';
      for (const n of names) {
        const o = document.createElement("option");
        o.value = n;
        o.textContent = n.replaceAll("_", " ");
        el.region.appendChild(o);
      }
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

el.region.addEventListener("change", () => {
  state.filter.region = el.region.value;
  state.fitPending = Boolean(el.region.value);
  reprocess();
});

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
  if (!el.trails.checked) clearTrails();
  else reprocess();
});

el.panelToggle.addEventListener("click", () => el.panel.classList.toggle("open"));

map.on("zoomend", () => {
  const r = radiusForZoom();
  for (const m of state.markers.values()) m.setRadius(r);
});

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
/* Start                                                               */
/* ------------------------------------------------------------------ */

renderChips([]);
connect();
loadCatalog();
loadRegions();

