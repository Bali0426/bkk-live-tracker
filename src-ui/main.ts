/**
 * BKK & MÁV Live Tracker – Fő Alkalmazás Modul (Tauri v2 + TypeScript + Leaflet)
 * Támogatott platformok: Windows Desktop & Android Mobile
 */

import L from "leaflet";
import "leaflet/dist/leaflet.css";

import { api } from "./api";
import { getRoundedHull } from "./hull";
import type {
  BkkStop,
  BkkVehicle,
  MavNetworkElement,
  MavTrain,
  SearchIndexItem,
} from "./types";
import {
  buildVagonwebSectionHtml,
  setCurrentVagonwebData,
  switchVagonwebType,
} from "./vagonweb";

declare global {
  interface Window {
    loadAndDrawRoute: (routeId: string, color?: string) => Promise<void>;
    loadAndDrawMavRoute: (
      elviraId: string,
      color?: string,
      trainNumber?: string
    ) => Promise<void>;
    loadMavTrainDetails: (
      elviraId: string,
      trainNumber?: string,
      color?: string
    ) => Promise<void>;
    loadMavStationDetails: (stationName: string) => Promise<void>;
    switchVagonwebType: (wantActual: boolean) => void;
    searchStationOrStop: (query: string) => void;
  }
}

interface AnimatedVehicleEntry {
  marker: L.Marker;
  prevLat: number;
  prevLon: number;
  targetLat: number;
  targetLon: number;
  startTime: number;
  duration: number;
  speed: number;
  bearing: number | null | undefined;
  lastServerTime: number | null | undefined;
  lastRenderTime: number;
  data: BkkVehicle;
}

interface AnimatedTrainEntry {
  marker: L.Marker;
  prevLat: number;
  prevLon: number;
  targetLat: number;
  targetLon: number;
  startTime: number;
  duration: number;
  speed: number;
  bearing: number | null | undefined;
  lastRenderTime: number;
  data: MavTrain;
}

interface StopGroup {
  name: string;
  stops: BkkStop[];
  routesMap: Map<
    string,
    { shortName: string; color: string; textColor: string; type: string }
  >;
  mainColor: string;
  mainType: string;
}

const STATE = {
  map: null as unknown as L.Map,
  tileLayer: null as L.TileLayer | null,
  isLightMode: localStorage.getItem("bkk_theme") === "light",
  vehicleLayer: null as unknown as L.LayerGroup,
  stopsLayer: null as unknown as L.LayerGroup,
  routeLayer: null as unknown as L.LayerGroup,
  networkLayer: null as unknown as L.LayerGroup,
  mavLayer: null as unknown as L.LayerGroup,
  mavNetworkLayer: null as unknown as L.LayerGroup,
  mavStationsLayer: null as unknown as L.LayerGroup,
  vehicleMarkers: new Map<string, AnimatedVehicleEntry>(),
  mavMarkers: new Map<string, AnimatedTrainEntry>(),
  activeRouteId: null as string | null,
  activeMavTrainId: null as string | null,
  activeStopId: localStorage.getItem("bkk_active_stop") || "BKK_F02222",
  apiKey: localStorage.getItem("bkk_api_key") || "",
  refreshIntervalSec: parseInt(
    localStorage.getItem("bkk_refresh_sec") || "5",
    10
  ),
  routeFilter: "",
  typeFilter: null as string | null,
  showStops: false,
  showNetwork: false,
  networkLoaded: false,
  showMav: true,
  mavNetworkLoaded: false,
  mavStationsLoaded: false,
  timerId: null as ReturnType<typeof setInterval> | null,
  hasServerKey: false,
  allVehicles: [] as BkkVehicle[],
  allMavTrains: [] as MavTrain[],
  searchIndex: [] as SearchIndexItem[],
  bkkHubsInitialized: false,
};

document.addEventListener("DOMContentLoaded", async () => {
  initMap();
  initUI();
  startSmoothAnimationLoop();
  await checkServerStatus();
  await refreshAll();
  if (STATE.showMav) {
    loadMavNetwork();
    loadMavStations();
  }
  initStationSearchIndex();
  startAutoRefresh();
});

// ─────────────────────────── Map Initialization ──────────────────────────────

function initMap(): void {
  STATE.map = L.map("map", {
    center: [47.4979, 19.0402],
    zoom: 14,
    zoomControl: true,
  });

  applyMapTheme(STATE.isLightMode);

  STATE.networkLayer = L.layerGroup();
  STATE.mavNetworkLayer = L.layerGroup().addTo(STATE.map);
  STATE.mavStationsLayer = L.layerGroup().addTo(STATE.map);
  STATE.routeLayer = L.layerGroup().addTo(STATE.map);
  STATE.stopsLayer = L.layerGroup().addTo(STATE.map);
  STATE.mavLayer = L.layerGroup().addTo(STATE.map);
  STATE.vehicleLayer = L.layerGroup().addTo(STATE.map);

  let moveTimeout: ReturnType<typeof setTimeout> | null = null;
  STATE.map.on("moveend", () => {
    if (moveTimeout) clearTimeout(moveTimeout);
    moveTimeout = setTimeout(() => {
      fetchVehicles();
      if (STATE.showStops) fetchStops();
      if (STATE.showMav) {
        loadMavNetwork();
        loadMavStations();
      }
    }, 350);
  });

  STATE.map.on("click", () => {
    if (STATE.activeRouteId) {
      STATE.routeLayer.clearLayers();
      STATE.activeRouteId = null;
    }
  });
}

function applyMapTheme(isLight: boolean): void {
  STATE.isLightMode = isLight;
  localStorage.setItem("bkk_theme", isLight ? "light" : "dark");
  document.body.classList.toggle("light-mode", isLight);

  const btn = document.getElementById("theme-toggle-btn");
  if (btn) {
    btn.textContent = isLight ? "🌙" : "☀️";
    btn.title = isLight
      ? "Váltás sötét térképre"
      : "Váltás világos térképre";
  }

  if (STATE.tileLayer) {
    STATE.map.removeLayer(STATE.tileLayer);
  }

  const tileUrl = isLight
    ? "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

  STATE.tileLayer = L.tileLayer(tileUrl, {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a> | Adatok: BKK OpenData & MÁV',
    subdomains: "abcd",
    maxZoom: 20,
  }).addTo(STATE.map);
}

// ─────────────────────────── UI Event Listeners ──────────────────────────────

function initUI(): void {
  const routeFilterInput = document.getElementById(
    "route-filter"
  ) as HTMLInputElement | null;
  const clearFilterBtn = document.getElementById("clear-filter-btn");

  routeFilterInput?.addEventListener("input", (e) => {
    STATE.routeFilter = (e.target as HTMLInputElement).value.trim().toUpperCase();
    renderVehicles();
    renderMavTrains();
  });

  clearFilterBtn?.addEventListener("click", () => {
    if (routeFilterInput) routeFilterInput.value = "";
    STATE.routeFilter = "";
    STATE.typeFilter = null;
    document
      .querySelectorAll(".legend-item")
      .forEach((el) => el.classList.remove("active"));
    renderVehicles();
    renderMavTrains();
  });

  document.querySelectorAll(".legend-item").forEach((item) => {
    item.addEventListener("click", () => {
      const type = item.getAttribute("data-type");
      if (STATE.typeFilter === type) {
        STATE.typeFilter = null;
        item.classList.remove("active");
      } else {
        STATE.typeFilter = type;
        document
          .querySelectorAll(".legend-item")
          .forEach((el) => el.classList.remove("active"));
        item.classList.add("active");
      }
      renderVehicles();
      renderMavTrains();
    });
  });

  const toggleMavBtn = document.getElementById("toggle-mav-btn");
  toggleMavBtn?.addEventListener("click", () => {
    STATE.showMav = !STATE.showMav;
    toggleMavBtn.classList.toggle("active", STATE.showMav);
    if (STATE.showMav) {
      STATE.map.addLayer(STATE.mavNetworkLayer);
      STATE.map.addLayer(STATE.mavStationsLayer);
      STATE.map.addLayer(STATE.mavLayer);
      fetchMavTrains();
      loadMavNetwork();
      loadMavStations();
    } else {
      STATE.map.removeLayer(STATE.mavNetworkLayer);
      STATE.map.removeLayer(STATE.mavStationsLayer);
      STATE.map.removeLayer(STATE.mavLayer);
    }
  });

  const toggleStopsBtn = document.getElementById("toggle-stops-btn");
  toggleStopsBtn?.addEventListener("click", () => {
    STATE.showStops = !STATE.showStops;
    toggleStopsBtn.classList.toggle("active", STATE.showStops);
    if (STATE.showStops) {
      fetchStops();
    } else {
      STATE.stopsLayer.clearLayers();
    }
  });

  const toggleNetworkBtn = document.getElementById("toggle-network-btn");
  toggleNetworkBtn?.addEventListener("click", async () => {
    STATE.showNetwork = !STATE.showNetwork;
    toggleNetworkBtn.classList.toggle("active", STATE.showNetwork);
    if (STATE.showNetwork) {
      STATE.map.addLayer(STATE.networkLayer);
      if (!STATE.networkLoaded) {
        await loadTransitNetwork();
      }
    } else {
      STATE.map.removeLayer(STATE.networkLayer);
    }
  });

  document.getElementById("refresh-btn")?.addEventListener("click", () => {
    refreshAll();
  });

  document.getElementById("theme-toggle-btn")?.addEventListener("click", () => {
    applyMapTheme(!STATE.isLightMode);
  });

  const loadStopBtn = document.getElementById("load-stop-btn");
  const customStopInput = document.getElementById(
    "custom-stop-input"
  ) as HTMLInputElement | null;

  loadStopBtn?.addEventListener("click", () => {
    const val = customStopInput?.value.trim() || "";
    if (val) {
      selectStop(val.startsWith("BKK_") ? val : `BKK_${val}`);
    }
  });

  customStopInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadStopBtn?.click();
  });

  document.getElementById("copy-url-btn")?.addEventListener("click", () => {
    const urlText = `http://127.0.0.1:8000/api/departures/${STATE.activeStopId}?limit=5`;
    navigator.clipboard.writeText(urlText);
    const btn = document.getElementById("copy-url-btn");
    if (btn) {
      btn.textContent = "✓";
      setTimeout(() => (btn.textContent = "📋"), 1500);
    }
  });

  const modal = document.getElementById("settings-modal");
  const apiKeyInput = document.getElementById(
    "api-key-input"
  ) as HTMLInputElement | null;
  const intervalInput = document.getElementById(
    "refresh-interval-input"
  ) as HTMLInputElement | null;

  document.getElementById("settings-btn")?.addEventListener("click", () => {
    if (apiKeyInput) apiKeyInput.value = STATE.apiKey;
    if (intervalInput) intervalInput.value = String(STATE.refreshIntervalSec);
    modal?.classList.remove("hidden");
  });

  document.getElementById("close-modal-btn")?.addEventListener("click", () => {
    modal?.classList.add("hidden");
  });

  document.getElementById("save-settings-btn")?.addEventListener("click", () => {
    STATE.apiKey = apiKeyInput?.value.trim() || "";
    STATE.refreshIntervalSec = Math.max(
      2,
      Math.min(120, parseInt(intervalInput?.value || "5", 10) || 5)
    );
    localStorage.setItem("bkk_api_key", STATE.apiKey);
    localStorage.setItem("bkk_refresh_sec", String(STATE.refreshIntervalSec));
    modal?.classList.add("hidden");
    startAutoRefresh();
    refreshAll();
  });

  updateDiyLinks(STATE.activeStopId);
  initSearchUI();
}

// ─────────────────────────── Search Bar & Index ──────────────────────────────

async function initStationSearchIndex(): Promise<void> {
  try {
    const mavData = await api.getMavStations();
    (mavData.stations || []).forEach((st) => {
      STATE.searchIndex.push({
        id: `MAV_${st.name}`,
        name: st.name,
        type: "MAV",
        subType: "Vasútállomás (MÁV)",
        lat: st.lat,
        lon: st.lon,
        routes: ["MÁV"],
      });
    });
  } catch (e) {
    console.warn("MÁV állomások indexelése sikertelen:", e);
  }

  try {
    const bkkData = await api.getStops({
      lat: 47.4979,
      lon: 19.0402,
      latSpan: 0.08,
      lonSpan: 0.12,
      apiKey: STATE.apiKey,
    });
    indexBkkStopsIntoSearch(bkkData.stops || []);
    STATE.bkkHubsInitialized = true;
  } catch (e) {
    console.warn("BKK megállók előindexelése sikertelen:", e);
  }
}

function indexBkkStopsIntoSearch(stops: BkkStop[]): void {
  const existingNames = new Set(
    STATE.searchIndex
      .filter((i) => i.type === "BKK")
      .map((i) => i.name.toLowerCase())
  );

  const grouped = new Map<
    string,
    {
      id: string;
      name: string;
      latSum: number;
      lonSum: number;
      count: number;
      routes: Set<string>;
      color: string;
      type: string;
    }
  >();

  stops.forEach((s) => {
    const key = s.name.trim();
    if (!grouped.has(key)) {
      grouped.set(key, {
        id: s.stopId,
        name: key,
        latSum: 0,
        lonSum: 0,
        count: 0,
        routes: new Set<string>(),
        color: s.color || "#3B82F6",
        type: s.type || "BUS",
      });
    }
    const g = grouped.get(key)!;
    g.latSum += s.lat;
    g.lonSum += s.lon;
    g.count += 1;
    (s.routes || []).forEach((r) => g.routes.add(r.shortName));
    if (s.type === "SUBWAY") {
      g.type = "SUBWAY";
      g.color = s.color;
    } else if (s.type === "TRAM" && g.type !== "SUBWAY") {
      g.type = "TRAM";
      g.color = s.color;
    }
  });

  grouped.forEach((g) => {
    if (existingNames.has(g.name.toLowerCase())) return;
    const typeLabels: Record<string, string> = {
      SUBWAY: "Metróállomás",
      TRAM: "Villamosmegálló",
      RAIL: "HÉV / Vasút",
      TROLLEYBUS: "Trolimegálló",
      BUS: "BKK Megálló",
    };
    STATE.searchIndex.push({
      id: g.id,
      name: g.name,
      type: "BKK",
      subType: typeLabels[g.type] || "BKK Megálló",
      lat: g.latSum / g.count,
      lon: g.lonSum / g.count,
      routes: Array.from(g.routes).slice(0, 8),
      color: g.color,
    });
  });
}

function normalizeStr(str: string): string {
  return (str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function initSearchUI(): void {
  const input = document.getElementById(
    "station-search-input"
  ) as HTMLInputElement | null;
  const dropdown = document.getElementById("search-results-dropdown");
  if (!input || !dropdown) return;

  input.addEventListener("input", () => {
    const rawQuery = input.value.trim();
    const q = normalizeStr(rawQuery);
    if (q.length < 2) {
      dropdown.classList.add("hidden");
      dropdown.innerHTML = "";
      return;
    }

    const matches = STATE.searchIndex
      .map((item) => {
        const normName = normalizeStr(item.name);
        let score = 0;
        if (normName === q) score = 100;
        else if (normName.startsWith(q)) score = 80;
        else if (normName.includes(q)) score = 50;
        else if (item.routes.some((r) => normalizeStr(r) === q)) score = 40;
        if (score > 0 && item.type === "MAV") score += 5;
        if (score > 0 && item.subType === "Metróállomás") score += 4;
        return { item, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    if (matches.length === 0) {
      dropdown.innerHTML = `<div class="search-empty">Nincs találat erre: "${rawQuery}"</div>`;
      dropdown.classList.remove("hidden");
      return;
    }

    dropdown.innerHTML = matches
      .map(({ item }) => {
        const icon =
          item.type === "MAV"
            ? "🚆"
            : item.subType === "Metróállomás"
              ? "🚇"
              : item.subType === "Villamosmegálló"
                ? "🚋"
                : "🚏";
        const badges = item.routes
          .slice(0, 5)
          .map(
            (r) =>
              `<span class="search-route-pill" style="background:${item.color || "#3b82f6"}">${r}</span>`
          )
          .join("");
        return `
          <div class="search-result-item" data-id="${item.id}" data-type="${item.type}" data-name="${item.name}" data-lat="${item.lat}" data-lon="${item.lon}">
            <div class="search-item-left">
              <span class="search-item-icon">${icon}</span>
              <div>
                <div class="search-item-title">${item.name}</div>
                <div class="search-item-sub">${item.subType}</div>
              </div>
            </div>
            <div class="search-item-badges">${badges}</div>
          </div>
        `;
      })
      .join("");

    dropdown.classList.remove("hidden");

    dropdown.querySelectorAll(".search-result-item").forEach((el) => {
      el.addEventListener("click", () => {
        const type = el.getAttribute("data-type");
        const id = el.getAttribute("data-id") || "";
        const name = el.getAttribute("data-name") || "";
        const lat = parseFloat(el.getAttribute("data-lat") || "47.4979");
        const lon = parseFloat(el.getAttribute("data-lon") || "19.0402");

        dropdown.classList.add("hidden");
        input.value = name;

        if (type === "MAV") {
          STATE.map.flyTo([lat, lon], 15, { duration: 0.8 });
          loadMavStationDetails(name);
        } else {
          if (!STATE.showStops) {
            const btn = document.getElementById("toggle-stops-btn");
            if (btn) btn.click();
          }
          STATE.map.flyTo([lat, lon], 16, { duration: 0.8 });
          selectStop(id, name);
        }
      });
    });
  });

  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (!input.contains(target) && !dropdown.contains(target)) {
      dropdown.classList.add("hidden");
    }
  });
}

function searchStationOrStop(query: string): void {
  const input = document.getElementById(
    "station-search-input"
  ) as HTMLInputElement | null;
  if (!input) return;
  input.value = query;
  input.dispatchEvent(new Event("input"));
  input.focus();
}
window.searchStationOrStop = searchStationOrStop;

// ─────────────────────────── API Calls & Data ────────────────────────────────

async function checkServerStatus(): Promise<void> {
  try {
    const data = await api.checkStatus();
    STATE.hasServerKey = data.hasEnvApiKey;

    const warningEl = document.getElementById("api-Warning");
    if (!STATE.hasServerKey && !STATE.apiKey) {
      warningEl?.classList.remove("hidden");
      setStatus("error", "Hiányzó BKK API kulcs! Kattints a ⚙️ ikonra.");
    } else {
      warningEl?.classList.add("hidden");
      setStatus("ok", "Kapcsolódva a BKK API-hoz");
    }
  } catch (err) {
    console.error("Status check failed:", err);
    setStatus("error", "Szerver nem érhető el");
  }
}

async function refreshAll(): Promise<void> {
  const promises: Promise<unknown>[] = [
    fetchVehicles(),
    fetchDepartures(STATE.activeStopId),
  ];
  if (STATE.showStops) promises.push(fetchStops());
  if (STATE.showMav) promises.push(fetchMavTrains());
  await Promise.allSettled(promises);
}

function startAutoRefresh(): void {
  if (STATE.timerId) clearInterval(STATE.timerId);
  STATE.timerId = setInterval(() => {
    refreshAll();
  }, STATE.refreshIntervalSec * 1000);
}

async function fetchVehicles(): Promise<void> {
  const center = STATE.map.getCenter();
  const bounds = STATE.map.getBounds();
  const latSpan = Math.min(
    Math.max((bounds.getNorth() - bounds.getSouth()) / 2, 0.01),
    0.15
  );
  const lonSpan = Math.min(
    Math.max((bounds.getEast() - bounds.getWest()) / 2, 0.015),
    0.2
  );

  try {
    const data = await api.getVehicles({
      lat: center.lat,
      lon: center.lng,
      latSpan,
      lonSpan,
      apiKey: STATE.apiKey,
    });
    STATE.allVehicles = data.vehicles || [];
    renderVehicles();
    setStatus("ok", "Élő adatok frissítve");
    const lastUpdatedEl = document.getElementById("last-updated");
    if (lastUpdatedEl) {
      lastUpdatedEl.textContent = new Date().toLocaleTimeString("hu-HU");
    }
  } catch (err) {
    console.error("Failed to fetch vehicles:", err);
    setStatus("error", `Hiba a járművek lekérésekor: ${(err as Error).message}`);
  }
}

async function fetchStops(): Promise<void> {
  const center = STATE.map.getCenter();
  const bounds = STATE.map.getBounds();
  const latSpan = Math.min(
    Math.max((bounds.getNorth() - bounds.getSouth()) / 2, 0.005),
    0.04
  );
  const lonSpan = Math.min(
    Math.max((bounds.getEast() - bounds.getWest()) / 2, 0.008),
    0.06
  );

  try {
    const data = await api.getStops({
      lat: center.lat,
      lon: center.lng,
      latSpan,
      lonSpan,
      apiKey: STATE.apiKey,
    });
    const stops = data.stops || [];
    indexBkkStopsIntoSearch(stops);
    renderStops(stops);
  } catch (err) {
    console.error("Failed to fetch stops:", err);
  }
}

async function fetchDepartures(stopId: string): Promise<void> {
  const screenEl = document.getElementById("departures-list");
  if (!screenEl) return;

  try {
    const data = await api.getDepartures({
      stopId,
      limit: 10,
      minutesAfter: 60,
      apiKey: STATE.apiKey,
    });

    const stopNameEl = document.getElementById("stop-name");
    const stopIdEl = document.getElementById("stop-id-display");
    if (stopNameEl) stopNameEl.textContent = data.stopName || stopId;
    if (stopIdEl) stopIdEl.textContent = data.stopId;

    if (!data.departures || data.departures.length === 0) {
      screenEl.innerHTML = `<div class="futar-empty">Nincs induló járat a következő 60 percben.</div>`;
      return;
    }

    let html = "";
    data.departures.forEach((dep) => {
      const isNow = dep.minutesUntil <= 0;
      const realtimeClass = dep.isRealtime ? "" : "scheduled";
      const nowClass = isNow ? "now" : "";
      const wheelchairIcon = dep.wheelchairAccessible ? "♿" : "";

      html += `
        <div class="futar-row">
          <span class="route-badge" style="background:#${dep.color}; color:#${dep.textColor}">
            ${dep.routeShortName}
          </span>
          <span class="headsign" title="${dep.headsign}">
            ${dep.headsign} <small>${wheelchairIcon}</small>
          </span>
          <span class="dep-time ${realtimeClass} ${nowClass}" title="${dep.isRealtime ? "Valós idejű GPS adat" : "Menetrend szerinti"}">
            ${dep.displayText}
          </span>
        </div>
      `;
    });

    if (data.alerts && data.alerts.length > 0) {
      html += `<div class="futar-alert">⚠️ ${data.alerts[0]}</div>`;
    }

    screenEl.innerHTML = html;
  } catch (err) {
    console.error("Failed to fetch departures:", err);
    screenEl.innerHTML = `<div class="futar-empty">Nem sikerült betölteni az indulásokat (${(err as Error).message}).</div>`;
  }
}

// ─────────────────────────── Map Rendering & Animation ───────────────────────

function createVehicleIcon(v: BkkVehicle): L.DivIcon {
  const bearing = v.bearing ?? 0;
  const hasBearing = v.bearing !== null && v.bearing !== undefined;
  return L.divIcon({
    className: "custom-vehicle-icon",
    html: `
      <div class="vehicle-marker" style="background:#${v.color}; color:#${v.textColor}; border-color:#${v.textColor}">
        <span>${v.routeShortName}</span>
        ${
          hasBearing
            ? `<div class="dir-arrow" style="transform: rotate(${bearing}deg)">▲</div>`
            : ""
        }
      </div>
    `,
    iconSize: [34, 22],
    iconAnchor: [17, 11],
  });
}

function createVehiclePopupHtml(v: BkkVehicle): string {
  const speedKmh = v.speed ? Math.round(v.speed * 3.6) : 0;
  const features: string[] = [];
  if (v.lowFloor) features.push("Alacsonypadlós");
  if (v.wheelchairAccessible) features.push("♿ Akadálymentes");
  if (v.airConditioned) features.push("❄️ Klímás");

  return `
    <div class="popup-title">
      <span class="route-badge" style="background:#${v.color}; color:#${v.textColor}">${v.routeShortName}</span>
      <span>▶ ${v.headsign || "Ismeretlen cél"}</span>
    </div>
    <div class="popup-meta">
      <div><strong>Jármű:</strong> ${v.model || "BKK Jármű"} (${v.licensePlate || v.label || v.vehicleId})</div>
      <div><strong>Sebesség:</strong> ${speedKmh} km/h</div>
      ${features.length ? `<div><strong>Jellemzők:</strong> ${features.join(" • ")}</div>` : ""}
      <div style="margin-top:6px;">
        <button onclick="loadAndDrawRoute('${v.routeId}', '#${v.color}')" class="btn-small" style="width:100%">
          🗺️ Útvonal kirajzolása
        </button>
      </div>
    </div>
  `;
}

function renderVehicles(): void {
  const filtered = STATE.allVehicles.filter((v) => {
    const matchesRoute =
      !STATE.routeFilter ||
      (v.routeShortName &&
        v.routeShortName.toUpperCase().includes(STATE.routeFilter));
    const matchesType = !STATE.typeFilter || v.routeType === STATE.typeFilter;
    return matchesRoute && matchesType;
  });

  const mavCount = STATE.showMav ? STATE.mavMarkers.size : 0;
  const countEl = document.getElementById("vehicle-count");
  if (countEl) countEl.textContent = String(filtered.length + mavCount);

  const now = performance.now();
  const activeIds = new Set<string>();

  filtered.forEach((v) => {
    if (!v.lat || !v.lon) return;
    activeIds.add(v.vehicleId);

    const existing = STATE.vehicleMarkers.get(v.vehicleId);
    if (existing) {
      const currentPos = existing.marker.getLatLng();
      const moved =
        Math.abs( existing.targetLat - v.lat ) > 0.000005 ||
        Math.abs( existing.targetLon - v.lon ) > 0.000005;

      if (moved) {
        existing.prevLat = currentPos.lat;
        existing.prevLon = currentPos.lng;
        existing.targetLat = v.lat;
        existing.targetLon = v.lon;
        existing.startTime = now;
        existing.duration = STATE.refreshIntervalSec * 1000;
      }

      existing.speed = v.speed || 0;
      existing.bearing = v.bearing;
      existing.lastServerTime = v.lastUpdateTime;
      existing.data = v;

      existing.marker.setIcon(createVehicleIcon(v));
      if (existing.marker.isPopupOpen()) {
        existing.marker.setPopupContent(createVehiclePopupHtml(v));
      } else {
        existing.marker.getPopup()?.setContent(createVehiclePopupHtml(v));
      }
    } else {
      const marker = L.marker([v.lat, v.lon], {
        icon: createVehicleIcon(v),
      });
      marker.bindPopup(createVehiclePopupHtml(v));
      marker.on("click", () => {
        if (v.routeId) {
          loadAndDrawRoute(v.routeId, `#${v.color}`);
        }
      });
      marker.addTo(STATE.vehicleLayer);

      STATE.vehicleMarkers.set(v.vehicleId, {
        marker,
        prevLat: v.lat,
        prevLon: v.lon,
        targetLat: v.lat,
        targetLon: v.lon,
        startTime: now,
        duration: STATE.refreshIntervalSec * 1000,
        speed: v.speed || 0,
        bearing: v.bearing,
        lastServerTime: v.lastUpdateTime,
        lastRenderTime: now,
        data: v,
      });
    }
  });

  for (const [id, entry] of STATE.vehicleMarkers.entries()) {
    if (!activeIds.has(id)) {
      STATE.vehicleLayer.removeLayer(entry.marker);
      STATE.vehicleMarkers.delete(id);
    }
  }
}

function startSmoothAnimationLoop(): void {
  const DEG_PER_METER_LAT = 1 / 111320;
  const DEG_PER_METER_LON = 1 / (111320 * Math.cos((47.4979 * Math.PI) / 180));

  function step(now: number): void {
    for (const entry of STATE.vehicleMarkers.values()) {
      const dt = (now - entry.lastRenderTime) / 1000;
      entry.lastRenderTime = now;

      const elapsed = now - entry.startTime;
      const t = Math.min(elapsed / entry.duration, 1.0);

      if (
        t < 1.0 &&
        (entry.prevLat !== entry.targetLat || entry.prevLon !== entry.targetLon)
      ) {
        const lat = entry.prevLat + (entry.targetLat - entry.prevLat) * t;
        const lon = entry.prevLon + (entry.targetLon - entry.prevLon) * t;
        entry.marker.setLatLng([lat, lon]);
      } else if (
        entry.speed > 0.8 &&
        entry.bearing !== null &&
        entry.bearing !== undefined &&
        elapsed < 20000
      ) {
        const cur = entry.marker.getLatLng();
        const rad = (entry.bearing * Math.PI) / 180;
        const dist = entry.speed * dt * 0.65;
        const dLat = dist * Math.cos(rad) * DEG_PER_METER_LAT;
        const dLon = dist * Math.sin(rad) * DEG_PER_METER_LON;
        entry.marker.setLatLng([cur.lat + dLat, cur.lng + dLon]);
      }
    }

    if (STATE.showMav) {
      for (const entry of STATE.mavMarkers.values()) {
        const dt = (now - entry.lastRenderTime) / 1000;
        entry.lastRenderTime = now;

        const elapsed = now - entry.startTime;
        const t = Math.min(elapsed / entry.duration, 1.0);

        if (
          t < 1.0 &&
          (entry.prevLat !== entry.targetLat ||
            entry.prevLon !== entry.targetLon)
        ) {
          const lat = entry.prevLat + (entry.targetLat - entry.prevLat) * t;
          const lon = entry.prevLon + (entry.targetLon - entry.prevLon) * t;
          entry.marker.setLatLng([lat, lon]);
        } else if (
          entry.speed > 1.0 &&
          entry.bearing !== null &&
          entry.bearing !== undefined &&
          elapsed < 45000
        ) {
          const cur = entry.marker.getLatLng();
          const rad = (entry.bearing * Math.PI) / 180;
          const dist = entry.speed * dt * 0.75;
          const dLat = dist * Math.cos(rad) * DEG_PER_METER_LAT;
          const dLon = dist * Math.sin(rad) * DEG_PER_METER_LON;
          entry.marker.setLatLng([cur.lat + dLat, cur.lng + dLon]);
        }
      }
    }

    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ─────────────────────────── Route & Network Drawing ─────────────────────────

async function loadAndDrawRoute(
  routeId: string,
  fallbackColor = "#3B82F6"
): Promise<void> {
  if (!routeId) return;
  try {
    STATE.routeLayer.clearLayers();
    STATE.activeRouteId = routeId;

    const data = await api.getRouteDetails(routeId, STATE.apiKey);
    const color = data.color ? `#${data.color}` : fallbackColor;

    (data.polylines || []).forEach((points) => {
      if (points.length < 2) return;
      L.polyline(points, {
        color: "#000000",
        weight: 8,
        opacity: 0.45,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(STATE.routeLayer);

      L.polyline(points, {
        color,
        weight: 5,
        opacity: 0.95,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(STATE.routeLayer);
    });
  } catch (err) {
    console.error("Failed to load route geometry:", err);
  }
}
window.loadAndDrawRoute = loadAndDrawRoute;

async function loadTransitNetwork(): Promise<void> {
  const btn = document.getElementById("toggle-network-btn");
  if (btn) btn.textContent = "⏳ Betöltés...";

  try {
    const data = await api.getTransitNetwork(STATE.apiKey);
    STATE.networkLayer.clearLayers();

    (data.lines || []).forEach((line) => {
      const isSubway = line.type === "SUBWAY";
      const isRail = line.type === "RAIL";
      const weight = isSubway ? 4.5 : isRail ? 3.5 : 2.5;
      const opacity = isSubway ? 0.85 : 0.65;

      (line.polylines || []).forEach((pts) => {
        if (pts.length < 2) return;
        const poly = L.polyline(pts, {
          color: `#${line.color}`,
          weight,
          opacity,
          lineCap: "round",
          lineJoin: "round",
        });
        poly.bindTooltip(`${line.shortName}`, { sticky: true });
        poly.addTo(STATE.networkLayer);
      });
    });

    STATE.networkLoaded = true;
  } catch (err) {
    console.error("Failed to load transit network:", err);
  } finally {
    if (btn) btn.textContent = "🕸️ Hálózat";
  }
}

// ─────────────────────────── Stops & Rounded Hulls ───────────────────────────

function renderStops(stops: BkkStop[]): void {
  STATE.stopsLayer.clearLayers();

  const groups = new Map<string, StopGroup>();
  stops.forEach((s) => {
    const key = s.name.trim();
    if (!groups.has(key)) {
      groups.set(key, {
        name: key,
        stops: [],
        routesMap: new Map(),
        mainColor: s.color || "#3B82F6",
        mainType: s.type || "BUS",
      });
    }
    const g = groups.get(key)!;
    g.stops.push(s);
    if (s.type === "SUBWAY") {
      g.mainType = "SUBWAY";
      g.mainColor = s.color;
    } else if (s.type === "TRAM" && g.mainType !== "SUBWAY") {
      g.mainType = "TRAM";
      g.mainColor = s.color;
    }

    (s.routes || []).forEach((r) => {
      g.routesMap.set(r.shortName, r);
    });
  });

  groups.forEach((group) => {
    const count = group.stops.length;
    const isHub = count >= 2 || group.mainType === "SUBWAY";
    const coords: [number, number][] = group.stops.map((s) => [s.lat, s.lon]);

    const centerLat = coords.reduce((sum, p) => sum + p[0], 0) / count;
    const centerLon = coords.reduce((sum, p) => sum + p[1], 0) / count;

    const allRoutes = Array.from(group.routesMap.values());
    const routeBadgesHtml = allRoutes
      .slice(0, 12)
      .map(
        (r) =>
          `<span class="stop-route-pill" style="background:${r.color};color:${r.textColor}">${r.shortName}</span>`
      )
      .join("");

    if (isHub && count >= 2) {
      const hullPts = getRoundedHull(coords, 0.00018, 8);

      const poly = L.polygon(hullPts, {
        color: group.mainColor,
        weight: 2,
        opacity: 0.85,
        fillColor: group.mainColor,
        fillOpacity: 0.18,
        className: "stop-hub-polygon",
      });

      poly.bindTooltip(
        `<div class="stop-tooltip-title">🚏 ${group.name} <small>(${count} peron)</small></div>
         <div class="stop-tooltip-routes">${routeBadgesHtml}</div>`,
        { direction: "top", sticky: true, className: "bkk-stop-tooltip" }
      );

      poly.on("click", () => {
        selectStop(group.stops[0].stopId, group.name);
      });

      poly.addTo(STATE.stopsLayer);

      const labelIcon = L.divIcon({
        className: "stop-hub-label",
        html: `<div class="hub-label-chip" style="border-color:${group.mainColor}">${group.name}</div>`,
        iconSize: [120, 20],
        iconAnchor: [60, 10],
      });
      const labelMarker = L.marker([centerLat, centerLon], {
        icon: labelIcon,
        interactive: false,
      });
      labelMarker.addTo(STATE.stopsLayer);
    }

    group.stops.forEach((s) => {
      const stopColor = s.color || "#3B82F6";
      const isSubway = s.type === "SUBWAY";
      const isTram = s.type === "TRAM";
      const radius = isSubway ? 7 : isTram ? 6 : 5;

      const marker = L.circleMarker([s.lat, s.lon], {
        radius,
        fillColor: stopColor,
        color: "#ffffff",
        weight: 2,
        fillOpacity: 0.95,
      });

      const stopRoutesHtml = (s.routes || [])
        .slice(0, 8)
        .map(
          (r) =>
            `<span class="stop-route-pill" style="background:${r.color};color:${r.textColor}">${r.shortName}</span>`
        )
        .join("");

      marker.bindTooltip(
        `<div class="stop-tooltip-title">${s.name} ${s.platformCode ? `[${s.platformCode}]` : ""}</div>
         ${stopRoutesHtml ? `<div class="stop-tooltip-routes">${stopRoutesHtml}</div>` : ""}`,
        { direction: "top", offset: [0, -6], className: "bkk-stop-tooltip" }
      );

      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectStop(s.stopId, s.name);
      });

      marker.addTo(STATE.stopsLayer);
    });
  });
}

function selectStop(stopId: string, stopName?: string): void {
  STATE.activeStopId = stopId;
  localStorage.setItem("bkk_active_stop", stopId);
  if (stopName) {
    const stopNameEl = document.getElementById("stop-name");
    if (stopNameEl) stopNameEl.textContent = stopName;
  }
  const stopIdEl = document.getElementById("stop-id-display");
  if (stopIdEl) stopIdEl.textContent = stopId;
  updateDiyLinks(stopId);
  fetchDepartures(stopId);
}

function updateDiyLinks(stopId: string): void {
  const endpointPath = `/api/departures/${stopId}?limit=5`;
  const codeEl = document.getElementById("diy-endpoint-url");
  if (codeEl) codeEl.textContent = endpointPath;
  const linkEl = document.getElementById(
    "open-json-link"
  ) as HTMLAnchorElement | null;
  if (linkEl) linkEl.href = `http://127.0.0.1:8000${endpointPath}`;
}

function setStatus(type: "ok" | "error" | "loading", message: string): void {
  const dot = document.getElementById("status-dot");
  if (!dot) return;
  dot.className = `status-dot ${type}`;
  dot.title = message;
}

// ─────────────────────────── MÁV / GYSEV Live Trains ─────────────────────────

async function fetchMavTrains(): Promise<void> {
  if (!STATE.showMav) return;
  try {
    const data = await api.getMavTrains();
    STATE.allMavTrains = data.trains || [];
    renderMavTrains();
  } catch (err) {
    console.error("Failed to fetch MÁV trains:", err);
  }
}

function createMavTrainIcon(t: MavTrain): L.DivIcon {
  const bearing = t.bearing ?? 0;
  const hasBearing = t.bearing !== null && t.bearing !== undefined;
  const delayBadge =
    t.delayMinutes >= 5
      ? `<span class="mav-delay-pill">+${t.delayMinutes}'</span>`
      : "";
  const label = t.trainName
    ? `🚆 ${t.routeShortName} ${t.trainName}`
    : `🚆 ${t.routeShortName}`;

  return L.divIcon({
    className: "custom-vehicle-icon mav-icon-wrapper",
    html: `
      <div class="vehicle-marker mav-train-marker" style="background:#${t.color}; color:#${t.textColor}; border-color:#ffffff">
        <span>${label}</span>
        ${delayBadge}
        ${hasBearing ? `<div class="dir-arrow" style="transform: rotate(${bearing}deg)">▲</div>` : ""}
      </div>
    `,
    iconSize: [t.trainName ? 115 : 54, 24],
    iconAnchor: [t.trainName ? 57 : 27, 12],
  });
}

function createMavPopupHtml(t: MavTrain): string {
  const delayColor =
    t.delayMinutes >= 15
      ? "#ef4444"
      : t.delayMinutes >= 5
        ? "#f59e0b"
        : "#10b981";
  const delayText =
    t.delayMinutes > 0 ? `+${t.delayMinutes} perc késés` : "Pontos (0 perc)";
  const speedKmh = t.speed ? Math.round(t.speed * 3.6) : null;
  const fullTitle = t.trainName
    ? `${t.routeShortName} ${t.trainName} (${t.trainNumber})`
    : `${t.routeShortName} (${t.trainNumber})`;

  return `
    <div class="popup-title">
      <span class="route-badge" style="background:#${t.color}; color:#${t.textColor}">🚆 ${fullTitle}</span>
    </div>
    <div class="popup-meta">
      <div><strong>Viszonylat:</strong> ${t.relation || "MÁV-START / GYSEV"}</div>
      ${speedKmh !== null ? `<div><strong>Sebesség (becsült):</strong> ~${speedKmh} km/h</div>` : ""}
      <div><strong>Menetrendi helyzet:</strong> <span style="color:${delayColor}; font-weight:700">${delayText}</span></div>
      <div style="margin-top:6px; display:flex; gap:6px;">
        <button onclick="loadMavTrainDetails('${t.elviraId}', '${t.trainNumber}', '#${t.color}')" class="btn-small" style="flex:1">
          📋 Menetrend &amp; Útvonal
        </button>
      </div>
    </div>
  `;
}

function renderMavTrains(): void {
  if (!STATE.showMav) return;

  const filtered = STATE.allMavTrains.filter((t) => {
    const searchStr =
      `${t.routeShortName} ${t.trainName || ""} ${t.trainNumber} ${t.relation}`.toUpperCase();
    const matchesRoute =
      !STATE.routeFilter || searchStr.includes(STATE.routeFilter);
    const matchesType = !STATE.typeFilter || STATE.typeFilter === "MAV";
    return matchesRoute && matchesType;
  });

  const now = performance.now();
  const activeIds = new Set<string>();

  filtered.forEach((t) => {
    if (!t.lat || !t.lon) return;
    activeIds.add(t.trainId);

    const existing = STATE.mavMarkers.get(t.trainId);
    if (existing) {
      const currentPos = existing.marker.getLatLng();
      const moved =
        Math.abs(existing.targetLat - t.lat) > 0.000005 ||
        Math.abs(existing.targetLon - t.lon) > 0.000005;

      if (moved) {
        existing.prevLat = currentPos.lat;
        existing.prevLon = currentPos.lng;
        existing.targetLat = t.lat;
        existing.targetLon = t.lon;
        existing.startTime = now;
        existing.duration = Math.max(STATE.refreshIntervalSec * 1000, 10000);
      }
      existing.speed = t.speed || 0;
      existing.bearing = t.bearing;
      existing.data = t;
      existing.marker.setIcon(createMavTrainIcon(t));
      if (existing.marker.isPopupOpen()) {
        existing.marker.setPopupContent(createMavPopupHtml(t));
      } else {
        existing.marker.getPopup()?.setContent(createMavPopupHtml(t));
      }
    } else {
      const marker = L.marker([t.lat, t.lon], {
        icon: createMavTrainIcon(t),
      });
      marker.bindPopup(createMavPopupHtml(t));
      marker.on("click", () => {
        if (t.elviraId) {
          loadMavTrainDetails(t.elviraId, t.trainNumber, `#${t.color}`);
        }
      });
      marker.addTo(STATE.mavLayer);

      STATE.mavMarkers.set(t.trainId, {
        marker,
        prevLat: t.lat,
        prevLon: t.lon,
        targetLat: t.lat,
        targetLon: t.lon,
        startTime: now,
        duration: Math.max(STATE.refreshIntervalSec * 1000, 10000),
        speed: t.speed || 0,
        bearing: t.bearing,
        lastRenderTime: now,
        data: t,
      });
    }
  });

  for (const [id, entry] of STATE.mavMarkers.entries()) {
    if (!activeIds.has(id)) {
      STATE.mavLayer.removeLayer(entry.marker);
      STATE.mavMarkers.delete(id);
    }
  }

  const countEl = document.getElementById("vehicle-count");
  if (countEl) {
    countEl.textContent = String(
      STATE.vehicleMarkers.size + STATE.mavMarkers.size
    );
  }
}

async function loadMavTrainDetails(
  elviraId: string,
  trainNumber = "",
  color = "#3b82f6"
): Promise<void> {
  if (!elviraId) return;

  const screenEl = document.getElementById("departures-list");
  const stopNameEl = document.getElementById("stop-name");
  const stopIdEl = document.getElementById("stop-id-display");
  if (stopNameEl)
    stopNameEl.textContent = `🚆 Vonat menetrend (${trainNumber || elviraId})`;
  if (stopIdEl) stopIdEl.textContent = `ELVIRA: ${elviraId}`;
  if (screenEl) {
    screenEl.innerHTML = `<div class="futar-empty">⏳ Vonat menetrend és útvonal betöltése...</div>`;
  }

  try {
    STATE.routeLayer.clearLayers();
    STATE.activeRouteId = `MAV_${elviraId}`;

    const data = await api.getMavTrainDetails(elviraId, trainNumber);

    const pts = data.polyline || [];
    if (pts.length >= 2) {
      L.polyline(pts, {
        color: "#000000",
        weight: 8,
        opacity: 0.5,
        lineCap: "round",
        lineJoin: "round",
      }).addTo(STATE.routeLayer);

      L.polyline(pts, {
        color,
        weight: 5,
        opacity: 0.95,
        dashArray: "10, 6",
        lineCap: "round",
        lineJoin: "round",
      }).addTo(STATE.routeLayer);
    }

    if (screenEl) {
      if (data.html) {
        screenEl.innerHTML = `
          <div id="vagonweb-container" class="vagonweb-box">
            <div class="vagonweb-loading">🚃 Szerelvény-összeállítás keresése (vagonWEB)...</div>
          </div>
          <div class="mav-timetable-container">${data.html}</div>
        `;
      } else {
        screenEl.innerHTML = `
          <div id="vagonweb-container" class="vagonweb-box"></div>
          <div class="futar-empty">Nincs részletes menetrendi adat.</div>
        `;
      }
    }

    loadVagonwebComposition(elviraId, trainNumber);
  } catch (err) {
    console.error("Failed to load MÁV train details:", err);
    if (screenEl) {
      screenEl.innerHTML = `<div class="futar-empty">Hiba a vonat menetrend lekérésekor.</div>`;
    }
  }
}

async function loadVagonwebComposition(
  elviraId: string,
  trainNumber: string
): Promise<void> {
  const container = document.getElementById("vagonweb-container");
  if (!container) return;

  try {
    const compData = await api.getMavTrainComposition(elviraId, trainNumber);
    if (
      !compData.found ||
      ((!compData.compositions || compData.compositions.length === 0) &&
        (!compData.cars || compData.cars.length === 0))
    ) {
      container.style.display = "none";
      return;
    }

    setCurrentVagonwebData(compData);
    container.innerHTML = buildVagonwebSectionHtml(compData);
  } catch (e) {
    console.warn("vagonWEB fetch failed:", e);
    container.style.display = "none";
  }
}

window.switchVagonwebType = switchVagonwebType;
window.loadMavTrainDetails = loadMavTrainDetails;
window.loadAndDrawMavRoute = (
  elviraId: string,
  color?: string,
  trainNumber?: string
) => loadMavTrainDetails(elviraId, trainNumber, color);

// ─────────────────────────── MÁV Network & Stations ──────────────────────────

let lastMavNetBounds: L.LatLngBounds | null = null;
let lastMavNetZoom = 0;

async function loadMavNetwork(): Promise<void> {
  if (!STATE.showMav) return;
  const zoom = STATE.map.getZoom();
  const bounds = STATE.map.getBounds();

  const tier = zoom >= 12 ? 3 : zoom >= 10 ? 2 : 1;
  if (
    lastMavNetBounds &&
    lastMavNetBounds.contains(bounds) &&
    lastMavNetZoom === tier
  ) {
    return;
  }

  const padBounds = bounds.pad(0.3);
  const sw = padBounds.getSouthWest();
  const ne = padBounds.getNorthEast();

  try {
    const data = await api.getMavNetwork({
      swLat: sw.lat,
      swLon: sw.lng,
      neLat: ne.lat,
      neLon: ne.lng,
      zoom,
    });
    STATE.mavNetworkLayer.clearLayers();
    lastMavNetBounds = padBounds;
    lastMavNetZoom = tier;

    const elements: MavNetworkElement[] = data.elements || [];
    elements.forEach((el) => {
      if (el.type === "way" && el.geometry && el.geometry.length >= 2) {
        const pts: [number, number][] = el.geometry.map((pt) => [
          pt.lat,
          pt.lon,
        ]);
        const isMain = el.tags && el.tags.usage === "main";
        const poly = L.polyline(pts, {
          color: isMain ? "#f59e0b" : "#94a3b8",
          weight: isMain ? 2.8 : 1.8,
          opacity: isMain ? 0.65 : 0.45,
          dashArray: isMain ? "6, 4" : "3, 3",
          interactive: false,
        });
        poly.addTo(STATE.mavNetworkLayer);
      } else if (
        el.type === "node" &&
        el.lat &&
        el.lon &&
        el.tags &&
        el.tags.name
      ) {
        const stName = el.tags.name;
        const isStation = el.tags.railway === "station";

        if (
          !STATE.searchIndex.some(
            (i) => normalizeStr(i.name) === normalizeStr(stName)
          )
        ) {
          STATE.searchIndex.push({
            id: `MAV_${stName}`,
            name: stName,
            type: "MAV",
            subType: isStation
              ? "Vasútállomás (MÁV)"
              : "Vasúti megállóhely (MÁV)",
            lat: el.lat,
            lon: el.lon,
            routes: ["MÁV"],
          });
        }

        const dot = L.circleMarker([el.lat, el.lon], {
          radius: isStation ? 5 : 3.5,
          fillColor: isStation ? "#f59e0b" : "#cbd5e1",
          color: "#0f172a",
          weight: 1.5,
          fillOpacity: 0.9,
        });
        dot.bindTooltip(
          `🚆 ${stName} <small>(kattints a menetrendhez)</small>`,
          { direction: "top" }
        );
        dot.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          loadMavStationDetails(stName);
        });
        dot.addTo(STATE.mavNetworkLayer);
      }
    });
  } catch (err) {
    console.error("Failed to load MÁV rail network:", err);
  }
}

async function loadMavStations(): Promise<void> {
  if (STATE.mavStationsLoaded) return;
  try {
    const data = await api.getMavStations();
    STATE.mavStationsLayer.clearLayers();

    (data.stations || []).forEach((st) => {
      const marker = L.circleMarker([st.lat, st.lon], {
        radius: 6,
        fillColor: "#f59e0b",
        color: "#ffffff",
        weight: 2,
        fillOpacity: 0.95,
      });

      marker.bindTooltip(
        `<div class="stop-tooltip-title">🚉 ${st.name}</div>
         <div style="font-size:0.75rem;color:#94a3b8">Kattints az állomási menetrendhez</div>`,
        { direction: "top", offset: [0, -6], className: "bkk-stop-tooltip" }
      );

      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        loadMavStationDetails(st.name);
      });

      marker.addTo(STATE.mavStationsLayer);
    });

    STATE.mavStationsLoaded = true;
  } catch (err) {
    console.error("Failed to load MÁV stations:", err);
  }
}

async function loadMavStationDetails(stationName: string): Promise<void> {
  if (!stationName) return;
  const screenEl = document.getElementById("departures-list");
  const stopNameEl = document.getElementById("stop-name");
  const stopIdEl = document.getElementById("stop-id-display");
  if (stopNameEl) stopNameEl.textContent = `🚉 ${stationName}`;
  if (stopIdEl) stopIdEl.textContent = "MÁV ÁLLOMÁS";
  if (screenEl) {
    screenEl.innerHTML = `<div class="futar-empty">⏳ Állomási menetrend betöltése...</div>`;
  }

  try {
    const data = await api.getMavStationDetails(stationName);
    if (screenEl) {
      if (data.html) {
        screenEl.innerHTML = `<div class="mav-timetable-container">${data.html}</div>`;
      } else {
        screenEl.innerHTML = `<div class="futar-empty">Nem található menetrend ehhez az állomáshoz: ${stationName}</div>`;
      }
    }
  } catch (err) {
    console.error("Failed to load MÁV station details:", err);
    if (screenEl) {
      screenEl.innerHTML = `<div class="futar-empty">Hiba az állomási menetrend lekérésekor.</div>`;
    }
  }
}
window.loadMavStationDetails = loadMavStationDetails;
