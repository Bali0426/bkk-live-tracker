const STORAGE_KEY = 'bkk_custom_api_key';
let customApiKey = localStorage.getItem(STORAGE_KEY) || '';
let vehicles = [];
let cachedStopsList = [];
let showStops = false;

// Egységesített jobb oldali widget állapot
let activeBoardMode = null; // 'bkk_stop' | 'mav_station' | 'mav_train'
let activeStopId = null;
let activeStationName = null;
let activeMavTrain = null;

const map = L.map('map', { zoomControl: false }).setView([47.4979, 19.0402], 14);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> közreműködők | Adatforrás: BKK Zrt. & MÁV-START',
  maxZoom: 19
}).addTo(map);

const linesLayer = L.layerGroup().addTo(map);
const customRouteLayer = L.layerGroup().addTo(map);
const mavRailsLayer = L.layerGroup().addTo(map);
const mavRouteLayer = L.layerGroup().addTo(map);
const stopGroupLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const vehicleLayer = L.layerGroup().addTo(map);
const mavTrainLayer = L.layerGroup().addTo(map);

let mavTrains = [];
let mavStations = [];
let mavAvgDelay = 0;

const activeVehicleModes = {
  SUBWAY: true,
  TRAM: true,
  TROLLEYBUS: true,
  BUS: true,
  RAIL: true,
  MAV: true
};

const activeLineModes = {
  SUBWAY: true,
  TRAM: true,
  TROLLEYBUS: true,
  BUS: true,
  RAIL: true,
  MAV_RAIL: false
};

let networkData = null;
let mavNetworkLoaded = false;
let activeTab = 'tabVehicles';

function normalizeMode(type, shortName = '') {
  const t = String(type || '').toUpperCase();
  const s = String(shortName || '').toUpperCase();
  if (t.includes('SUBURBAN') || t.includes('RAIL') || t.includes('TRAIN') || s.startsWith('H')) {
    return 'RAIL';
  }
  if (t.includes('TROLLEY')) {
    return 'TROLLEYBUS';
  }
  if (t.includes('SUBWAY') || t.includes('METRO') || s.startsWith('M')) {
    return 'SUBWAY';
  }
  if (t.includes('TRAM')) {
    return 'TRAM';
  }
  return 'BUS';
}

function isRailwayStation(stop) {
  if (!stop) return false;
  if (stop.stopCategory === 'MAV') return true;
  const name = String(stop.name || '').toLowerCase();
  const desc = String(stop.description || '').toLowerCase();
  return name.includes('vasútállomás') ||
         name.includes('pályaudvar') ||
         name.includes('pu.') ||
         name.includes('keleti') ||
         name.includes('nyugati') ||
         name.includes('déli') ||
         name.includes('kelenföld') ||
         name.includes('kőbánya-kispest') ||
         name.includes('rákosrendező') ||
         desc.includes('vasútállomás') ||
         desc.includes('pályaudvar');
}

function getCleanStationName(name) {
  if (!name) return '';
  const n = String(name).trim();
  const low = n.toLowerCase();
  if (low.includes('keleti')) return 'Budapest-Keleti';
  if (low.includes('nyugati')) return 'Budapest-Nyugati';
  if (low.includes('déli') || low.includes('deli')) return 'Budapest-Déli';
  if (low.includes('kelenföld') || low.includes('kelenfold')) return 'Budapest-Kelenföld';
  if (low.includes('kőbánya-kispest')) return 'Kőbánya-Kispest';
  return n.replace(/\s*(M|H|vasútállomás|pályaudvar|pu\.|megállóhely)\b/gi, '').trim();
}

function handleStopClick(stop) {
  if (!stop) return;
  if (isRailwayStation(stop)) {
    const clean = getCleanStationName(stop.name);
    loadMavStationDetails(clean, false, stop.stopId);
  } else {
    loadStopDepartures(stop.stopId, stop.name);
  }
}

function getHeaders() {
  return customApiKey ? { 'X-BKK-Key': customApiKey } : {};
}

function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function updateVehicleStatsCounter() {
  const statsEl = document.getElementById('vehicleStats');
  if (!statsEl) return;
  const bkkCount = vehicleLayer.getLayers().length;
  const mavCount = mavTrainLayer.getLayers().length;
  if (activeVehicleModes.MAV && mavCount > 0) {
    statsEl.textContent = `${bkkCount} BKK jármű • ${mavCount} vonat (átl. késés: ${mavAvgDelay}p)`;
  } else {
    statsEl.textContent = `${bkkCount} jármű a térképen`;
  }
}

async function checkServerStatus() {
  refreshAll();
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.hasEnvApiKey && !customApiKey) {
      document.getElementById('settingsModal').classList.remove('hidden');
    }
  } catch (e) {
    console.error('Status check error:', e);
  }
}

async function fetchVehicles() {
  const bounds = map.getBounds();
  const center = bounds.getCenter();
  const latSpan = Math.abs(bounds.getNorth() - bounds.getSouth()) * 1.1;
  const lonSpan = Math.abs(bounds.getEast() - bounds.getWest()) * 1.1;

  try {
    const res = await fetch(
      `/api/vehicles?lat=${center.lat}&lon=${center.lng}&lat_span=${latSpan}&lon_span=${lonSpan}`,
      { headers: getHeaders() }
    );
    if (!res.ok) {
      console.warn('API error:', res.status);
      return;
    }
    const data = await res.json();
    vehicles = data.vehicles || [];
    renderVehicles();
    document.getElementById('lastUpdated').textContent =
      'Frissítve: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('fetchVehicles failed:', err);
  }
}

function renderVehicles() {
  vehicleLayer.clearLayers();
  const filterInput = document.getElementById('routeFilter');
  const q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  const zoom = map.getZoom();
  const isDotMode = zoom <= 12;

  vehicles.forEach(v => {
    try {
      if (!v.lat || !v.lon) return;

      const mode = normalizeMode(v.routeType, v.routeShortName);
      if (!activeVehicleModes[mode]) return;

      const shortName = String(v.routeShortName || '').toLowerCase();
      const headsign = String(v.headsign || '').toLowerCase();
      if (q && !shortName.includes(q) && !headsign.includes(q)) return;

      let name = String(v.routeShortName || '').trim();
      if (name.length > 8) {
        name = name.slice(0, 8);
      }
      if (!name) {
        name = v.licensePlate || '•';
      }

      let icon;
      if (isDotMode) {
        const dotSize = zoom <= 9 ? 6 : (zoom === 10 ? 7 : (zoom === 11 ? 9 : 11));
        icon = L.divIcon({
          className: 'vehicle-div-icon',
          html: `<div class="v-dot" style="width:${dotSize}px;height:${dotSize}px;background:${v.color || '#009EE3'};"></div>`,
          iconSize: [dotSize, dotSize],
          iconAnchor: [dotSize / 2, dotSize / 2]
        });
      } else {
        const height = zoom === 13 ? 20 : (zoom === 14 ? 24 : 28);
        const fontSize = zoom === 13 ? 9.5 : (zoom === 14 ? 11 : 12);
        const charW = zoom === 13 ? 6 : (zoom === 14 ? 7.2 : 8);
        const minW = zoom === 13 ? 22 : (zoom === 14 ? 26 : 30);
        const isLong = name.length > 3;
        const width = isLong ? Math.max(minW + 4, Math.round(name.length * charW + 10)) : minW;

        icon = L.divIcon({
          className: 'vehicle-div-icon',
          html: `<div class="v-marker" style="min-width:${width}px;height:${height}px;font-size:${fontSize}px;background:${v.color || '#009EE3'};color:${v.textColor || '#FFFFFF'};">${name}</div>`,
          iconSize: [width, height],
          iconAnchor: [width / 2, height / 2]
        });
      }

      const m = L.marker([v.lat, v.lon], { icon, zIndexOffset: 1000 });
      if (isDotMode) {
        m.bindTooltip(`<b>${v.routeShortName || 'Járat'}</b> → ${v.headsign || ''}`, { direction: 'top' });
      }
      m.bindPopup(`
        <div style="font-size:13px;line-height:1.5;">
          <strong>${v.routeShortName || 'Járat'} → ${v.headsign || 'N/A'}</strong><br>
          Rendszám: <b>${v.licensePlate || 'N/A'}</b><br>
          Sebesség: ${v.speedKmh || 0} km/h<br>
          Típus: ${v.model || v.routeType || 'N/A'}<br>
          <button class="btn btn-secondary" style="margin-top:8px;width:100%;font-size:11px;" onclick="loadAndDrawRoute('${v.routeId || v.routeShortName}')">🛤️ Nyomvonal kirajzolása</button>
        </div>
      `);
      vehicleLayer.addLayer(m);
    } catch (err) {
      console.error('Error rendering vehicle:', err, v);
    }
  });

  updateVehicleStatsCounter();
}

// Távolságméter számítás két koordináta között
function calcDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Lekerekített burok (rounded convex hull / buffer) előállítása mint OSM Transporton
function getRoundedHull(points, radiusMeters = 24) {
  if (!points || points.length === 0) return [];

  const latMid = points[0][0];
  const latScale = 1.0 / 111139.0;
  const lonScale = 1.0 / (111139.0 * Math.cos(latMid * Math.PI / 180));

  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  const sorted = points.slice().sort((a, b) => a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]);
  let hull = [];
  if (sorted.length <= 2) {
    hull = sorted;
  } else {
    const lower = [];
    for (let i = 0; i < sorted.length; i++) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], sorted[i]) <= 0) {
        lower.pop();
      }
      lower.push(sorted[i]);
    }
    const upper = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], sorted[i]) <= 0) {
        upper.pop();
      }
      upper.push(sorted[i]);
    }
    upper.pop();
    lower.pop();
    hull = lower.concat(upper);
  }

  if (hull.length === 1) {
    const p = hull[0];
    const ring = [];
    for (let i = 0; i < 20; i++) {
      const ang = (2 * Math.PI * i) / 20;
      ring.push([
        p[0] + radiusMeters * latScale * Math.sin(ang),
        p[1] + radiusMeters * lonScale * Math.cos(ang)
      ]);
    }
    return ring;
  }

  if (hull.length === 2) {
    const p1 = hull[0], p2 = hull[1];
    const x1 = p1[1] / lonScale, y1 = p1[0] / latScale;
    const x2 = p2[1] / lonScale, y2 = p2[0] / latScale;
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return [];
    const baseAng = Math.atan2(dy, dx);
    const ring = [];
    const steps = 10;
    for (let i = 0; i <= steps; i++) {
      const ang = baseAng - Math.PI / 2 + (Math.PI * i) / steps;
      const xm = x2 + radiusMeters * Math.cos(ang);
      const ym = y2 + radiusMeters * Math.sin(ang);
      ring.push([ym * latScale, xm * lonScale]);
    }
    for (let i = 0; i <= steps; i++) {
      const ang = baseAng + Math.PI / 2 + (Math.PI * i) / steps;
      const xm = x1 + radiusMeters * Math.cos(ang);
      const ym = y1 + radiusMeters * Math.sin(ang);
      ring.push([ym * latScale, xm * lonScale]);
    }
    return ring;
  }

  const ptsM = hull.map(p => [p[1] / lonScale, p[0] / latScale]);
  const n = ptsM.length;

  let area = 0;
  for (let i = 0; i < n; i++) {
    area += ptsM[i][0] * ptsM[(i + 1) % n][1] - ptsM[(i + 1) % n][0] * ptsM[i][1];
  }
  if (area < 0) ptsM.reverse();

  const rounded = [];
  const arcSteps = 8;

  for (let i = 0; i < n; i++) {
    const pPrev = ptsM[(i - 1 + n) % n];
    const pCurr = ptsM[i];
    const pNext = ptsM[(i + 1) % n];

    const v1x = pCurr[0] - pPrev[0];
    const v1y = pCurr[1] - pPrev[1];
    const l1 = Math.hypot(v1x, v1y);
    if (l1 === 0) continue;
    const n1x = v1y / l1;
    const n1y = -v1x / l1;
    const ang1 = Math.atan2(n1y, n1x);

    const v2x = pNext[0] - pCurr[0];
    const v2y = pNext[1] - pCurr[1];
    const l2 = Math.hypot(v2x, v2y);
    if (l2 === 0) continue;
    const n2x = v2y / l2;
    const n2y = -v2x / l2;
    const ang2 = Math.atan2(n2y, n2x);

    let diff = ang2 - ang1;
    while (diff < 0) diff += 2 * Math.PI;
    while (diff > 2 * Math.PI) diff -= 2 * Math.PI;

    for (let s = 0; s <= arcSteps; s++) {
      const ang = ang1 + diff * (s / arcSteps);
      const xm = pCurr[0] + radiusMeters * Math.cos(ang);
      const ym = pCurr[1] + radiusMeters * Math.sin(ang);
      rounded.push([ym * latScale, xm * lonScale]);
    }
  }

  return rounded;
}

const STOP_TYPE_ICONS = {
  MAV: '🚉',
  SUBWAY: '🚇',
  HEV: '🚆',
  TRAM: '🚊',
  TROLLEYBUS: '🚎',
  BUS: '🚌'
};

async function fetchStops() {
  if (!showStops) {
    stopGroupLayer.clearLayers();
    stopLayer.clearLayers();
    return;
  }
  const zoom = map.getZoom();
  if (zoom <= 11) {
    stopGroupLayer.clearLayers();
    stopLayer.clearLayers();
    return;
  }

  const bounds = map.getBounds();
  const center = bounds.getCenter();
  const latSpan = Math.min(0.03, Math.abs(bounds.getNorth() - bounds.getSouth()));
  const lonSpan = Math.min(0.04, Math.abs(bounds.getEast() - bounds.getWest()));

  try {
    const res = await fetch(
      `/api/stops?lat=${center.lat}&lon=${center.lng}&lat_span=${latSpan}&lon_span=${lonSpan}`,
      { headers: getHeaders() }
    );
    if (!res.ok) return;
    const data = await res.json();
    cachedStopsList = data.stops || [];
    renderStops();
  } catch (e) {
    console.error(e);
  }
}

function renderStops() {
  stopGroupLayer.clearLayers();
  stopLayer.clearLayers();
  if (!showStops || !cachedStopsList.length) return;

  const zoom = map.getZoom();
  if (zoom <= 11) return;

  // Csoportosítás parentStationId szerint (vagy név szerint, ha nincs)
  const groups = {};
  cachedStopsList.forEach(s => {
    const isParent = Boolean(s.isStopArea || s.locationType === 1);
    if (isParent) {
      if (!groups[s.stopId]) {
        groups[s.stopId] = { id: s.stopId, name: s.name, parent: s, children: [] };
      } else {
        groups[s.stopId].parent = s;
        groups[s.stopId].name = s.name;
      }
    } else {
      const pId = s.parentStationId || s.name;
      if (!groups[pId]) {
        groups[pId] = { id: pId, name: s.name, parent: null, children: [] };
      }
      groups[pId].children.push(s);
    }
  });

  // 1. Megállócsoportok lekerekített burka (zoom >= 13 esetén)
  if (zoom >= 13) {
    const hullRadius = zoom === 13 ? 16 : (zoom === 14 ? 20 : 24);
    Object.values(groups).forEach(g => {
      const pts = g.children.map(c => [c.lat, c.lon]);
      if (pts.length < 2) return;

      const d = calcDistanceMeters(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
      if (d > 450) return;

      const groupTargetId = g.parent ? g.parent.stopId : (g.children[0] ? g.children[0].stopId : g.id);
      const groupColor = (g.parent && g.parent.stopColor) || (g.children[0] && g.children[0].stopColor) || '#4f46e5';

      const roundedHull = getRoundedHull(pts, hullRadius);
      if (roundedHull.length >= 3) {
        const hullPolygon = L.polygon(roundedHull, {
          color: groupColor,
          weight: 1.6,
          opacity: 0.85,
          fillColor: groupColor,
          fillOpacity: 0.2,
          lineJoin: 'round',
          lineCap: 'round',
          className: 'stop-group-polygon'
        });

        hullPolygon.bindTooltip(`
          <div style="font-size:12px;line-height:1.4;">
            <span class="stop-badge" style="border-color:${groupColor};color:${groupColor};">🏢 ${pts.length === 2 ? 'Közös megálló (2 peron)' : `Csomópont (${pts.length} peron)`}</span><br>
            <strong style="font-size:13px;color:#f8fafc;">${g.name}</strong><br>
            <span style="color:#94a3b8;font-size:11px;">Kattints a menetrend és indulások megnyitásához</span>
          </div>
        `, { direction: 'top', sticky: true });

        hullPolygon.on('click', () => handleStopClick({ stopId: groupTargetId, name: g.name, stopCategory: g.parent ? g.parent.stopCategory : '' }));
        stopGroupLayer.addLayer(hullPolygon);
      }
    });
  }

  // 2. Egyedi megállók felrajzolása típus szerinti színnel és zoom-függő mérettel
  cachedStopsList.forEach(s => {
    const isParent = Boolean(s.isStopArea || s.locationType === 1);
    const stopColor = s.stopColor || (isParent ? '#a855f7' : '#0ea5e9');
    const stopCat = s.stopCategory || 'BUS';
    const stopLabel = s.stopTypeLabel || 'Megálló';
    const typeEmoji = STOP_TYPE_ICONS[stopCat] || '🚏';

    let pSize, dSize, fontSize;
    if (zoom === 12) {
      pSize = 9;
      dSize = 6;
      fontSize = 0;
    } else if (zoom === 13) {
      pSize = 14;
      dSize = 8;
      fontSize = 8;
    } else if (zoom === 14) {
      pSize = 18;
      dSize = 11;
      fontSize = 10;
    } else if (zoom === 15) {
      pSize = 21;
      dSize = 13;
      fontSize = 11;
    } else {
      pSize = 24;
      dSize = 15;
      fontSize = 12;
    }

    const size = isParent ? pSize : dSize;
    const anchor = size / 2;
    const innerIcon = (isParent && fontSize > 0) ? '🏢' : '';

    const markerHtml = isParent
      ? `<div class="stop-marker stop-marker-parent" style="width:${size}px;height:${size}px;font-size:${fontSize}px;--stop-color:${stopColor};background:${stopColor};">${innerIcon}</div>`
      : `<div class="stop-marker stop-marker-dir" style="width:${size}px;height:${size}px;--stop-color:${stopColor};background:${stopColor};"></div>`;

    const icon = L.divIcon({
      className: '',
      html: markerHtml,
      iconSize: [size, size],
      iconAnchor: [anchor, anchor]
    });

    const marker = L.marker([s.lat, s.lon], { icon, zIndexOffset: isParent ? 500 : 0 });

    const roleText = isParent ? 'Gyűjtőállomás' : `Per-irány megálló${s.direction ? ` (${s.direction}°)` : ''}`;
    marker.bindTooltip(`
      <div style="font-size:12px;line-height:1.4;">
        <span class="stop-badge" style="border-color:${stopColor};color:${stopColor};">${typeEmoji} ${stopLabel} • ${roleText}</span><br>
        <strong style="font-size:13px;color:#f8fafc;">${s.name}</strong><br>
        <span style="color:#94a3b8;font-size:11px;">ID: <code>${s.stopId}</code></span>
      </div>
    `, {
      direction: 'top',
      offset: [0, -anchor - 2]
    });

    marker.on('click', () => handleStopClick(s));
    stopLayer.addLayer(marker);
  });
}

// Egységesített FUTÁR & MÁV Widget tab-állapot beállító
function configureUnifiedBoardTabs({ showTabs = false, activeMode = 'bkk', bkkCallback = null, mavCallback = null }) {
  const tabsContainer = document.getElementById('boardModeTabs');
  const tabBkk = document.getElementById('boardTabBkk');
  const tabMav = document.getElementById('boardTabMav');
  if (!tabsContainer || !tabBkk || !tabMav) return;

  if (!showTabs) {
    tabsContainer.classList.add('hidden');
    return;
  }

  tabsContainer.classList.remove('hidden');
  tabBkk.classList.toggle('active', activeMode === 'bkk');
  tabMav.classList.toggle('active', activeMode === 'mav');

  tabBkk.onclick = bkkCallback;
  tabMav.onclick = mavCallback;
}

async function loadStopDepartures(stopId, stopName = '', silent = false) {
  if (!stopId) return;
  activeBoardMode = 'bkk_stop';
  activeStopId = stopId.trim();
  const stopInput = document.getElementById('stopInput');
  if (stopInput && !silent) stopInput.value = activeStopId;

  try {
    const res = await fetch(`/api/departures/${encodeURIComponent(activeStopId)}?limit=12`, {
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Megálló nem található');
    const data = await res.json();

    const board = document.getElementById('futarBoard');
    board.classList.remove('hidden');
    board.classList.remove('board-wide');

    const displayName = data.stopName || stopName || activeStopId;
    document.getElementById('boardSubtitle').textContent = 'FUTÁR ÉLŐ ADATOK & INDULÁSOK';
    document.getElementById('boardStopName').textContent = `🚏 ${displayName}`;
    document.getElementById('boardStopId').textContent = data.stopId;
    document.getElementById('btnCopyStopId').classList.remove('hidden');
    document.getElementById('boardFooterText').innerHTML = `Widget API végpont: <code id="boardApiUrl">/api/departures/${data.stopId}</code>`;

    const isTrain = isRailwayStation({ name: displayName });
    if (isTrain) {
      const cleanSt = getCleanStationName(displayName);
      configureUnifiedBoardTabs({
        showTabs: true,
        activeMode: 'bkk',
        bkkCallback: () => loadStopDepartures(data.stopId, displayName),
        mavCallback: () => loadMavStationDetails(cleanSt, false, data.stopId)
      });
    } else {
      configureUnifiedBoardTabs({ showTabs: false });
    }

    const listEl = document.getElementById('boardDeparturesList');
    listEl.innerHTML = '';

    if (!data.departures || data.departures.length === 0) {
      listEl.innerHTML = '<div style="padding:16px;color:#94a3b8;font-size:13px;">Nincs indulás a következő 45 percben.</div>';
      return;
    }

    data.departures.forEach(d => {
      const row = document.createElement('div');
      row.className = 'dep-row';
      row.innerHTML = `
        <div class="dep-left">
          <span class="dep-badge" style="background:${d.color};color:${d.textColor};cursor:pointer;" title="Kattints a nyomvonal kirajzolásához" onclick="loadAndDrawRoute('${d.routeId || d.routeShortName}')">${d.routeShortName}</span>
          <span class="dep-headsign">${d.headsign}</span>
        </div>
        <span class="dep-time">${d.displayTime}</span>
      `;
      listEl.appendChild(row);
    });
  } catch (e) {
    if (!silent) {
      showToast('Nem sikerült betölteni a megállót: ' + activeStopId);
    }
  }
}

// Tab kezelés (Járművek vs Vonalak)
function switchTab(tabId) {
  activeTab = tabId;
  const isVeh = (tabId === 'tabVehicles');
  const isLines = (tabId === 'tabLines');

  document.getElementById('tabVehiclesBtn').classList.toggle('active', isVeh);
  document.getElementById('tabLinesBtn').classList.toggle('active', isLines);

  document.getElementById('tabVehicles').classList.toggle('hidden', !isVeh);
  document.getElementById('tabLines').classList.toggle('hidden', !isLines);

  if (isLines && !networkData) {
    loadTransitNetwork();
  }
}

// Vonalhálózat kezelése
async function loadTransitNetwork() {
  if (!networkData) {
    try {
      showToast('🛤️ Vonalhálózat letöltése...');
      const res = await fetch('/api/network', { headers: getHeaders() });
      if (!res.ok) throw new Error('Hálózat betöltési hiba');
      networkData = await res.json();
    } catch (e) {
      console.error(e);
      showToast('Nem sikerült betölteni a vonalhálózatot');
      return;
    }
  }
  renderTransitNetwork();
}

function renderTransitNetwork() {
  linesLayer.clearLayers();
  let drawnCount = 0;

  if (networkData && networkData.routes) {
    networkData.routes.forEach(route => {
      const mode = normalizeMode(route.type, route.shortName);
      if (!activeLineModes[mode]) return;
      drawnCount++;

      (route.polylines || []).forEach(variant => {
        if (!variant.coordinates || variant.coordinates.length === 0) return;

        const glowLine = L.polyline(variant.coordinates, {
          color: '#000000',
          weight: 6,
          opacity: 0.55,
          lineCap: 'round',
          lineJoin: 'round',
          interactive: false
        });
        linesLayer.addLayer(glowLine);

        const poly = L.polyline(variant.coordinates, {
          color: route.color || '#3b82f6',
          weight: 4,
          opacity: 0.95,
          lineCap: 'round',
          lineJoin: 'round'
        });

        poly.bindTooltip(
          `<span style="color:${route.color};font-weight:bold;font-size:12px;">${route.shortName}</span> <span style="color:#cbd5e1;">${variant.name || variant.headsign || route.description || ''}</span>`,
          { className: 'transit-line-tooltip', sticky: true }
        );

        poly.on('click', () => {
          showToast(`🛤️ Járat: ${route.shortName} (${variant.headsign || route.description || ''})`);
        });

        linesLayer.addLayer(poly);
      });
    });
  }

  const statEl = document.getElementById('linesStats');
  if (statEl) {
    statEl.textContent = `${drawnCount} BKK járat nyomvonala${activeLineModes.MAV_RAIL ? ' + MÁV vasúthálózat' : ''} látható`;
  }
}

async function loadAndDrawRoute(routeId) {
  if (!routeId) return;
  try {
    showToast(`🛤️ Nyomvonal keresése: ${routeId}...`);
    const res = await fetch(`/api/routes/${encodeURIComponent(routeId)}`, { headers: getHeaders() });
    if (!res.ok) throw new Error('Járat nem található');
    const data = await res.json();

    if (!data.polylines || data.polylines.length === 0) {
      showToast('Nincs elérhető nyomvonal ehhez a járathoz: ' + routeId);
      return;
    }

    customRouteLayer.clearLayers();

    data.polylines.forEach(v => {
      if (!v.coordinates || v.coordinates.length === 0) return;

      const bg = L.polyline(v.coordinates, {
        color: '#000000',
        weight: 8,
        opacity: 0.7,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      customRouteLayer.addLayer(bg);

      const poly = L.polyline(v.coordinates, {
        color: data.color || '#38bdf8',
        weight: 5,
        opacity: 1,
        lineCap: 'round',
        lineJoin: 'round'
      });
      poly.bindTooltip(
        `<strong style="color:${data.color}">${data.shortName}</strong> → ${v.headsign || v.name}`,
        { className: 'transit-line-tooltip', sticky: true }
      );
      customRouteLayer.addLayer(poly);
    });

    const bounds = customRouteLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
    showToast(`🛤️ ${data.shortName} nyomvonala kirajzolva!`);

    const customInp = document.getElementById('customRouteInput');
    if (customInp) customInp.value = data.shortName;
  } catch (e) {
    console.error(e);
    showToast(`Hiba a járat nyomvonalának betöltésekor: ${routeId}`);
  }
}
window.loadAndDrawRoute = loadAndDrawRoute;

// MÁV Vonatok Lekérése és Megjelenítése
async function fetchMavTrains() {
  if (!activeVehicleModes.MAV) {
    mavTrainLayer.clearLayers();
    updateVehicleStatsCounter();
    return;
  }
  try {
    const res = await fetch('/api/mav/trains');
    if (!res.ok) {
      console.warn('MÁV API hiba:', res.status);
      return;
    }
    const data = await res.json();
    mavTrains = data.trains || [];
    mavAvgDelay = data.avgDelay || 0;
    renderMavTrains();
  } catch (err) {
    console.error('fetchMavTrains failed:', err);
  }
}

function renderMavTrains() {
  mavTrainLayer.clearLayers();
  if (!activeVehicleModes.MAV) {
    updateVehicleStatsCounter();
    return;
  }

  const filterInput = document.getElementById('routeFilter');
  const q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  const zoom = map.getZoom();
  const isDotMode = zoom <= 11;

  mavTrains.forEach(t => {
    try {
      if (!t.lat || !t.lon) return;

      const trainName = String(t.trainName || '').toLowerCase();
      const trainNum = String(t.trainNumber || '').toLowerCase();
      const fullTitle = String(t.fullTitle || '').toLowerCase();
      const rel = String(t.relation || '').toLowerCase();

      if (q && !trainName.includes(q) && !trainNum.includes(q) && !fullTitle.includes(q) && !rel.includes(q)) {
        return;
      }

      const displayName = t.trainName || t.relation || t.trainNumber || 'Vonat';
      const delayBadgeText = t.delay <= 0 ? '0p' : `+${t.delay}p`;

      let icon;
      if (isDotMode) {
        const dotSize = zoom <= 8 ? 7 : (zoom <= 10 ? 9 : 11);
        icon = L.divIcon({
          className: 'mav-div-icon',
          html: `<div class="mav-dot" style="width:${dotSize}px;height:${dotSize}px;background:${t.color};"></div>`,
          iconSize: [dotSize, dotSize],
          iconAnchor: [dotSize / 2, dotSize / 2]
        });
      } else {
        const fontSize = zoom === 12 ? 9.5 : (zoom === 13 ? 10.5 : 11.5);
        const pad = zoom === 12 ? '1px 5px' : '2px 6px 2px 5px';
        icon = L.divIcon({
          className: 'mav-div-icon',
          html: `
            <div class="mav-marker" style="font-size:${fontSize}px;padding:${pad};" title="${displayName} (#${t.trainNumber}) - ${t.relation} (${t.statusText})">
              <span class="mav-icon-tag">🚆</span>
              <span class="mav-name-tag" style="font-size:${fontSize}px;">${displayName}</span>
              <span class="mav-delay-pill" style="background:${t.color};color:${t.textColor};">${delayBadgeText}</span>
            </div>
          `,
          iconAnchor: [40, 14]
        });
      }

      const m = L.marker([t.lat, t.lon], { icon, zIndexOffset: 950 });

      if (isDotMode) {
        m.bindTooltip(`🚆 <b>${displayName}</b> <span style="color:#94a3b8;">(#${t.trainNumber})</span> • ${t.statusText}<br><span style="font-size:11px;color:#cbd5e1;">${t.relation}</span>`, { direction: 'top' });
      }

      const safeTitle = encodeURIComponent(displayName);
      const safeRel = encodeURIComponent(t.relation || '');

      m.bindPopup(`
        <div style="font-size:13px;line-height:1.5;min-width:240px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;">
            <strong style="font-size:15px;color:#38bdf8;">🚆 ${displayName}</strong>
            <span class="mav-delay-pill" style="background:${t.color};color:${t.textColor};font-weight:bold;padding:2px 6px;">${t.statusText}</span>
          </div>
          <div style="color:#f8fafc;font-size:12px;margin-bottom:4px;">
            <strong>${t.relation}</strong>
          </div>
          <div style="color:#94a3b8;font-size:11px;margin-bottom:10px;">
            Vonatszám: <b>${t.trainNumber}</b> • Üzemeltető: <b>${t.menetvonal}</b>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary" style="flex:1;font-size:11px;padding:6px 8px;" onclick="loadMavTrainDetails('${t.elviraId}', '${t.trainNumber}', '${safeRel}', false, '${safeTitle}')">📋 Menetrend</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:6px 8px;" onclick="loadAndDrawMavRoute('${t.elviraId}', '${safeTitle}')">🛤️ Nyomvonal</button>
          </div>
        </div>
      `);

      mavTrainLayer.addLayer(m);
    } catch (err) {
      console.error('Error rendering mav train:', err, t);
    }
  });

  updateVehicleStatsCounter();
}

// MÁV Vonat Menetrend betöltése az egységesített FUTÁR & MÁV Widgetbe
async function loadMavTrainDetails(elviraId, trainNumber, encodedRelation = '', silent = false, encodedTrainName = '') {
  if (!elviraId) return;
  const relation = encodedRelation ? decodeURIComponent(encodedRelation) : (activeMavTrain ? activeMavTrain.relation : '');
  const trainName = encodedTrainName ? decodeURIComponent(encodedTrainName) : (activeMavTrain ? activeMavTrain.trainName : '');
  activeBoardMode = 'mav_train';
  activeMavTrain = { elviraId, trainNumber, relation, trainName };

  // Ha ismerjük a vonatot a listából, kinyerjük a nevét
  let resolvedName = trainName;
  if (!resolvedName && mavTrains.length > 0) {
    const found = mavTrains.find(x => x.elviraId === elviraId || (trainNumber && x.trainNumber === trainNumber));
    if (found) {
      resolvedName = found.trainName;
      if (!activeMavTrain.relation) activeMavTrain.relation = found.relation;
      if (!activeMavTrain.trainNumber) activeMavTrain.trainNumber = found.trainNumber;
    }
  }

  const headerLabel = resolvedName || trainNumber || 'MÁV Vonat';

  try {
    if (!silent) {
      showToast(`🚆 ${headerLabel} menetrendjének betöltése...`);
    }
    const res = await fetch(`/api/mav/trains/${encodeURIComponent(elviraId)}?train_number=${encodeURIComponent(trainNumber || '')}`);
    if (!res.ok) throw new Error('Menetrend nem tölthető be');
    const data = await res.json();

    const board = document.getElementById('futarBoard');
    board.classList.remove('hidden');
    board.classList.add('board-wide');

    document.getElementById('boardSubtitle').textContent = 'MÁV-START ÉLŐ VONAT MENETREND';
    document.getElementById('boardStopName').textContent = `🚆 ${headerLabel}`;
    const numInfo = activeMavTrain.trainNumber ? ` (#${activeMavTrain.trainNumber})` : '';
    document.getElementById('boardStopId').textContent = `${activeMavTrain.relation || 'Élő vonatkövetés'}${numInfo}`;
    document.getElementById('btnCopyStopId').classList.add('hidden');
    document.getElementById('boardFooterText').textContent = 'Kattints bármely állomásra az állomási indulási táblához!';

    if (activeStationName) {
      configureUnifiedBoardTabs({
        showTabs: true,
        activeMode: 'mav',
        bkkCallback: () => loadMavStationDetails(activeStationName),
        mavCallback: () => {}
      });
      document.getElementById('boardTabBkk').textContent = `← Vissza: ${activeStationName}`;
      document.getElementById('boardTabMav').textContent = `🚆 Vonat menetrend`;
    } else {
      configureUnifiedBoardTabs({ showTabs: false });
    }

    const listEl = document.getElementById('boardDeparturesList');
    listEl.innerHTML = '';

    const compContainer = document.createElement('div');
    compContainer.id = 'mavCompositionContainer';
    compContainer.className = 'mav-composition-container';
    compContainer.innerHTML = '<div class="vagonweb-loading"><span class="pulse-dot"></span> 🚆 Vonatösszeállítás betöltése a vagonWEB-ről...</div>';
    listEl.appendChild(compContainer);

    if (data.html) {
      const timetableDiv = document.createElement('div');
      timetableDiv.innerHTML = data.html;
      listEl.appendChild(timetableDiv);
    } else {
      const emptyDiv = document.createElement('div');
      emptyDiv.style.cssText = 'padding:16px;color:#94a3b8;font-size:13px;';
      emptyDiv.textContent = 'Nincs elérhető menetrend adat ehhez a járathoz.';
      listEl.appendChild(emptyDiv);
    }

    // Vonatösszeállítás aszinkron lekérése a vagonWEB.cz-ről
    loadMavTrainComposition(elviraId, activeMavTrain.trainNumber || trainNumber);

    if (data.polylines && data.polylines.length > 0) {
      drawMavTrainPolylines(data.polylines, headerLabel, !silent);
    }
  } catch (err) {
    console.error(err);
    if (!silent) {
      showToast(`Nem sikerült betölteni a menetrendet: ${headerLabel}`);
    }
  }
}
window.loadMavTrainDetails = loadMavTrainDetails;

// 🚆 vagonWEB Képes Vonatösszeállítás Kezelő
let currentVagonwebData = null;
let currentVagonwebCompType = 'actual'; // 'actual' | 'planned'

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadMavTrainComposition(elviraId, trainNumber) {
  const container = document.getElementById('mavCompositionContainer');
  if (!container) return;

  const queryNum = trainNumber || elviraId || '';
  if (!queryNum) {
    container.innerHTML = '';
    return;
  }

  try {
    const res = await fetch(`/api/mav/trains/${encodeURIComponent(elviraId)}/composition?train_number=${encodeURIComponent(queryNum)}`);
    if (!res.ok) throw new Error('Hiba a vagonWEB lekérésben');
    const data = await res.json();

    if (!data.success) {
      const cleanNum = (String(queryNum).match(/\d+/) || [queryNum])[0];
      container.innerHTML = `
        <div class="vagonweb-empty">
          <span>ℹ️ Nincs mentett vagonWEB összeállítás ehhez a vonathoz (#${cleanNum})</span>
          <a href="https://www.vagonweb.cz/razeni/vlak.php?cislo=${encodeURIComponent(cleanNum)}" target="_blank" class="vagonweb-link">Keresés a vagonWEB-en ↗</a>
        </div>
      `;
      return;
    }

    currentVagonwebData = data;
    // Ha van aktuális/tényleges, azzal nyitunk, különben a tervezettel
    currentVagonwebCompType = data.hasActual ? 'actual' : 'planned';
    renderVagonwebCard();
  } catch (err) {
    console.warn('Vagonweb betöltési hiba:', err);
    container.innerHTML = '';
  }
}

function renderVagonwebCard() {
  const container = document.getElementById('mavCompositionContainer');
  if (!container || !currentVagonwebData) return;

  const data = currentVagonwebData;
  const isActual = currentVagonwebCompType === 'actual';
  const comp = isActual ? data.latestActual : data.defaultPlanned;

  if (!comp || !comp.cars || comp.cars.length === 0) {
    container.innerHTML = `
      <div class="vagonweb-empty">
        <span>ℹ️ Ehhez az állapothoz nem található kocsirajz.</span>
        <a href="${data.vagonwebUrl}" target="_blank" class="vagonweb-link">vagonWEB adatlap ↗</a>
      </div>
    `;
    return;
  }

  const badgeClass = isActual ? 'badge-actual' : 'badge-planned';
  const badgeText = isActual ? '🔴 Tényleges összeállítás' : '🟢 Tervezett menetrendi';

  container.innerHTML = `
    <div class="vagonweb-card">
      <div class="vagonweb-header">
        <div class="vagonweb-title">
          <span class="vagonweb-logo">🚆 vagonWEB</span>
          <span class="vagonweb-badge ${badgeClass}">${badgeText}</span>
        </div>
        <a href="${data.vagonwebUrl}" target="_blank" class="vagonweb-link" title="Eredeti adatlap megnyitása a vagonWEB.cz oldalon">Adatlap ↗</a>
      </div>
      <div class="vagonweb-date-row">
        <span class="vagonweb-date">📅 ${escapeHtml(comp.displayHeader || comp.rawHeader)}</span>
        <div class="vagonweb-toggle-btns">
          ${data.hasActual ? `<button class="vagonweb-toggle-btn ${isActual ? 'active' : ''}" onclick="switchVagonwebType('actual')">Tényleges</button>` : ''}
          ${data.hasPlanned ? `<button class="vagonweb-toggle-btn ${!isActual ? 'active' : ''}" onclick="switchVagonwebType('planned')">Tervezett</button>` : ''}
        </div>
      </div>
      <div class="vagonweb-train-scroll">
        <div class="vagonweb-train-row">
          ${comp.cars.map(c => `
            <div class="vagonweb-car ${c.isLoco ? 'is-loco' : ''} ${c.isEmu ? 'is-emu' : ''}" title="${escapeHtml(c.operator)} ${escapeHtml(c.carType)} ${escapeHtml(c.carSub)}">
              <div class="car-top">
                ${c.isEmu
                  ? `<span class="car-emu-label">MOTORVONAT</span>`
                  : (c.isLoco
                      ? `<span class="car-loco-label">MOZDONY</span>`
                      : (c.carNumber ? `<span class="car-num">${escapeHtml(c.carNumber)}</span>` : `<span class="car-num-empty">Kocsi</span>`)
                    )
                }
                ${c.carClass ? `<span class="car-class-badge">${escapeHtml(c.carClass)}. o.</span>` : ''}
              </div>
              <div class="car-img-wrap">
                ${c.imgUrl ? `<img src="${c.imgUrl}" alt="${escapeHtml(c.carType)}" class="car-img" loading="lazy">` : `<div style="font-size:10px;color:#94a3b8;">${escapeHtml(c.carType)}</div>`}
              </div>
              <div class="car-bottom">
                <span class="car-type">${escapeHtml(c.carType || (c.isLoco ? 'Mozdony' : (c.isEmu ? 'Motorvonat' : 'Kocsi')))}</span>
                ${c.carSub ? `<span class="car-sub">${escapeHtml(c.carSub)}</span>` : ''}
                ${c.operator ? `<span class="car-op">${escapeHtml(c.operator)}</span>` : ''}
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
}

function switchVagonwebType(type) {
  currentVagonwebCompType = type;
  renderVagonwebCard();
}
window.switchVagonwebType = switchVagonwebType;

// MÁV nyomvonal kirajzolása
async function loadAndDrawMavRoute(elviraId, encodedTrainName) {
  if (!elviraId) return;
  const label = encodedTrainName ? decodeURIComponent(encodedTrainName) : elviraId;
  try {
    showToast(`🛤️ ${label} nyomvonalának lekérése...`);
    const res = await fetch(`/api/mav/trains/${encodeURIComponent(elviraId)}`);
    if (!res.ok) throw new Error('Nyomvonal nem található');
    const data = await res.json();

    if (!data.polylines || data.polylines.length === 0) {
      showToast('Nincs elérhető nyomvonal ehhez a vonathoz: ' + label);
      return;
    }

    drawMavTrainPolylines(data.polylines, label, true);
    showToast(`🛤️ ${label} nyomvonala kirajzolva!`);
  } catch (err) {
    console.error(err);
    showToast('Hiba a nyomvonal betöltésekor: ' + label);
  }
}
window.loadAndDrawMavRoute = loadAndDrawMavRoute;

function drawMavTrainPolylines(polylines, label, fitBounds = false) {
  mavRouteLayer.clearLayers();

  polylines.forEach(p => {
    if (!p.coordinates || p.coordinates.length === 0) return;

    const bg = L.polyline(p.coordinates, {
      color: '#000000',
      weight: 7,
      opacity: 0.7,
      lineCap: 'round',
      lineJoin: 'round',
      interactive: false
    });
    mavRouteLayer.addLayer(bg);

    const line = L.polyline(p.coordinates, {
      color: '#38bdf8',
      weight: 4.5,
      opacity: 0.95,
      lineCap: 'round',
      lineJoin: 'round'
    });
    line.bindTooltip(`<strong>🚆 ${label}</strong> nyomvonala`, { sticky: true });
    mavRouteLayer.addLayer(line);
  });

  if (fitBounds) {
    const bounds = mavRouteLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }
}

// Vasúti hálózat vágányainak betöltése
async function updateMavRailsLayer() {
  if (!activeLineModes.MAV_RAIL) {
    mavRailsLayer.clearLayers();
    renderTransitNetwork();
    return;
  }

  showToast('🛤️ MÁV vasúthálózat letöltése...');
  try {
    const res = await fetch('/api/mav/network');
    if (!res.ok) throw new Error('Vasúthálózat hiba');
    const data = await res.json();
    mavRailsLayer.clearLayers();

    (data.lines || []).forEach(seg => {
      if (!seg.coordinates || seg.coordinates.length === 0) return;

      const track = L.polyline(seg.coordinates, {
        color: '#f59e0b',
        weight: 2.2,
        opacity: 0.75,
        dashArray: '5, 5',
        lineCap: 'round'
      });

      if (seg.lineNum) {
        track.bindTooltip(`Vasútvonal: <b>${seg.lineNum}</b>`, { sticky: true });
      }
      mavRailsLayer.addLayer(track);
    });
    mavNetworkLoaded = true;
    renderTransitNetwork();
    showToast(`🛤️ ${data.count || 0} vasúti szakasz betöltve!`);
  } catch (err) {
    console.error(err);
    showToast('Hiba a vasúthálózat betöltésekor');
  }
}

// 🚉 Vasútállomások és Egységesített Menetrend Keresés
async function fetchMavStations() {
  try {
    const res = await fetch('/api/mav/stations');
    if (!res.ok) return;
    const data = await res.json();
    mavStations = data.stations || [];
  } catch (err) {
    console.error('fetchMavStations failed:', err);
  }
}

async function searchStationOrStop(query) {
  if (!query || !query.trim()) return;
  const q = query.trim();
  const qLow = q.toLowerCase();

  // 1. Ha BKK Stop ID-t adott meg (pl. BKK_F01046 vagy F01046)
  if (q.toUpperCase().startsWith('BKK_') || /^[F0-9]{5,7}$/i.test(q)) {
    const formattedId = q.toUpperCase().startsWith('BKK_') ? q : `BKK_${q.toUpperCase()}`;
    await loadStopDepartures(formattedId);
    return;
  }

  // 2. Ha a jelenleg betöltött térképi megállók között szerepel név szerint
  const localStop = cachedStopsList.find(s => s.name && s.name.toLowerCase().includes(qLow));

  // 3. Ismert MÁV állomások (főpályaudvarok, vármegyeszékhelyek koordinátákkal)
  if (mavStations.length > 0) {
    const known = mavStations.find(s =>
      s.name.toLowerCase() === qLow ||
      s.shortName.toLowerCase() === qLow ||
      s.name.toLowerCase().includes(qLow) ||
      qLow.includes(s.shortName.toLowerCase()) ||
      (s.city && s.city.toLowerCase() === qLow)
    );
    if (known) {
      map.flyTo([known.lat, known.lon], 14);
      await loadMavStationDetails(known.name, false, localStop ? localStop.stopId : null);
      return;
    }
  }

  // 4. Ha helyi BKK megállót találtunk és nem vasútállomás
  if (localStop && !isRailwayStation(localStop)) {
    map.flyTo([localStop.lat, localStop.lon], 16);
    await loadStopDepartures(localStop.stopId, localStop.name);
    return;
  }

  // 5. Általános MÁV állomás lekérdezése név alapján
  const cleanName = getCleanStationName(q);
  showToast(`🔍 Menetrend keresése: ${cleanName}...`);
  const success = await loadMavStationDetails(cleanName, false, localStop ? localStop.stopId : null);
  if (success) return;

  showToast(`Nem található megálló vagy állomás: "${q}"`);
}
window.searchStationOrStop = searchStationOrStop;

async function loadMavStationDetails(stationName, silent = false, bkkStopId = null) {
  if (!stationName) return false;
  activeBoardMode = 'mav_station';
  activeStationName = stationName.trim();
  if (bkkStopId) activeStopId = bkkStopId;

  const stopInput = document.getElementById('stopInput');
  if (stopInput && !silent) stopInput.value = activeStationName;

  if (!silent && mavStations.length > 0) {
    const sLow = activeStationName.toLowerCase();
    const known = mavStations.find(s =>
      s.name.toLowerCase() === sLow ||
      s.shortName.toLowerCase() === sLow ||
      s.name.toLowerCase().includes(sLow) ||
      sLow.includes(s.shortName.toLowerCase())
    );
    if (known) {
      map.flyTo([known.lat, known.lon], 14);
    }
  }

  // Ha nincs explicit bkkStopId, megkeressük a betöltött megállók között
  let linkedBkkId = bkkStopId;
  if (!linkedBkkId && cachedStopsList.length > 0) {
    const cleanLow = activeStationName.toLowerCase().replace('budapest-', '');
    const match = cachedStopsList.find(s => s.name && s.name.toLowerCase().includes(cleanLow));
    if (match) linkedBkkId = match.stopId;
  }

  try {
    if (!silent) {
      showToast(`🚉 ${activeStationName} menetrendjének betöltése...`);
    }
    const res = await fetch(`/api/mav/stations/${encodeURIComponent(activeStationName)}`);
    if (!res.ok) throw new Error('Nem sikerült betölteni az állomást');
    const data = await res.json();

    const board = document.getElementById('futarBoard');
    board.classList.remove('hidden');
    board.classList.remove('board-wide');

    document.getElementById('boardSubtitle').textContent = 'MÁV-START ÉLŐ ÁLLOMÁSI MENETREND';
    document.getElementById('boardStopName').textContent = `🚉 ${data.station || activeStationName}`;
    document.getElementById('boardStopId').textContent = 'Élő indulások és érkezések • Vágánykijelző';
    document.getElementById('btnCopyStopId').classList.add('hidden');
    document.getElementById('boardFooterText').textContent = 'Kattints bármely vonatra az útvonal és térképi nyomvonal megtekintéséhez!';

    document.getElementById('boardTabBkk').textContent = '🚏 BKK Indulások';
    document.getElementById('boardTabMav').textContent = '🚆 MÁV Menetrend';

    if (linkedBkkId) {
      configureUnifiedBoardTabs({
        showTabs: true,
        activeMode: 'mav',
        bkkCallback: () => loadStopDepartures(linkedBkkId, activeStationName),
        mavCallback: () => loadMavStationDetails(activeStationName, false, linkedBkkId)
      });
    } else {
      configureUnifiedBoardTabs({ showTabs: false });
    }

    const listEl = document.getElementById('boardDeparturesList');
    if (data.html && data.html.trim().length > 100) {
      listEl.innerHTML = data.html;
    } else {
      listEl.innerHTML = '<div style="padding:16px;color:#94a3b8;font-size:13px;">Nincs elérhető vasúti menetrend ehhez az állomáshoz.</div>';
    }

    if (!silent) {
      showToast(`🚉 ${activeStationName} menetrendje betöltve!`);
    }
    return true;
  } catch (err) {
    console.error(err);
    if (!silent) {
      showToast(`Hiba az állomás betöltésekor: ${activeStationName}`);
    }
    return false;
  }
}
window.loadMavStationDetails = loadMavStationDetails;

function refreshAll() {
  fetchVehicles();
  if (activeVehicleModes.MAV) fetchMavTrains();
  if (showStops) fetchStops();

  if (activeBoardMode === 'bkk_stop' && activeStopId) {
    loadStopDepartures(activeStopId, '', true);
  } else if (activeBoardMode === 'mav_station' && activeStationName) {
    loadMavStationDetails(activeStationName, true, activeStopId);
  } else if (activeBoardMode === 'mav_train' && activeMavTrain) {
    loadMavTrainDetails(
      activeMavTrain.elviraId,
      activeMavTrain.trainNumber,
      encodeURIComponent(activeMavTrain.relation || ''),
      true,
      encodeURIComponent(activeMavTrain.trainName || '')
    );
  }
}

// Eseménykezelők
document.getElementById('routeFilter').addEventListener('input', () => {
  renderVehicles();
  renderMavTrains();
});
document.getElementById('btnRefresh').addEventListener('click', refreshAll);

// Fülváltás
document.getElementById('tabVehiclesBtn').addEventListener('click', () => switchTab('tabVehicles'));
document.getElementById('tabLinesBtn').addEventListener('click', () => switchTab('tabLines'));

// Sima Toggle kapcsolók (Switch toggles)
document.querySelectorAll('.mode-toggle-switch').forEach(sw => {
  sw.addEventListener('change', (e) => {
    const type = e.target.dataset.type;
    const mode = e.target.dataset.mode;
    if (type === 'vehicle') {
      activeVehicleModes[mode] = e.target.checked;
      if (mode === 'MAV') {
        if (e.target.checked && mavTrains.length === 0) {
          fetchMavTrains();
        } else {
          renderMavTrains();
        }
      } else {
        renderVehicles();
      }
    } else if (type === 'line') {
      activeLineModes[mode] = e.target.checked;
      if (mode === 'MAV_RAIL') {
        updateMavRailsLayer();
      } else {
        renderTransitNetwork();
      }
    }
  });
});

// Egyedi nyomvonal kirajzolás és törlés
document.getElementById('btnDrawRoute').addEventListener('click', () => {
  const val = document.getElementById('customRouteInput').value.trim();
  if (val) loadAndDrawRoute(val);
});
document.getElementById('customRouteInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val) loadAndDrawRoute(val);
  }
});

document.getElementById('btnClearCustomRoute').addEventListener('click', () => {
  customRouteLayer.clearLayers();
  mavRouteLayer.clearLayers();
  document.getElementById('customRouteInput').value = '';
  showToast('Egyedi nyomvonal törölve');
});

// Összes vonal elrejtése / mutatása kapcsoló
let allLinesShown = true;
document.getElementById('btnToggleAllLines').addEventListener('click', () => {
  allLinesShown = !allLinesShown;
  document.querySelectorAll('.mode-toggle-switch[data-type="line"]').forEach(sw => {
    sw.checked = allLinesShown;
    activeLineModes[sw.dataset.mode] = allLinesShown;
  });
  document.getElementById('btnToggleAllLines').textContent = allLinesShown ? 'Összes elrejtése' : 'Összes mutatása';
  updateMavRailsLayer();
  renderTransitNetwork();
});

document.getElementById('btnToggleStops').addEventListener('click', (e) => {
  showStops = !showStops;
  e.currentTarget.classList.toggle('active', showStops);
  fetchStops();
  if (showStops) {
    showToast('🚏 Megállók bekapcsolva (színkódolva típus szerint)');
  }
});

document.getElementById('btnLoadStop').addEventListener('click', () => {
  const val = document.getElementById('stopInput').value.trim();
  if (val) searchStationOrStop(val);
});
document.getElementById('stopInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const val = e.target.value.trim();
    if (val) searchStationOrStop(val);
  }
});

document.getElementById('btnCloseBoard').addEventListener('click', () => {
  const b = document.getElementById('futarBoard');
  b.classList.add('hidden');
  b.classList.remove('board-wide');
  mavRouteLayer.clearLayers();
  activeBoardMode = null;
  activeStopId = null;
  activeStationName = null;
  activeMavTrain = null;
});

document.getElementById('btnCopyStopId').addEventListener('click', () => {
  if (activeStopId) {
    navigator.clipboard.writeText(activeStopId);
    showToast(`Stop ID másolva: ${activeStopId}`);
  }
});

document.getElementById('btnLocate').addEventListener('click', () => {
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(pos => {
      map.flyTo([pos.coords.latitude, pos.coords.longitude], 15);
    });
  }
});

const THEME_KEY = 'bkk_map_theme';
let isDarkTheme = localStorage.getItem(THEME_KEY) !== 'light';

function applyTheme() {
  document.body.classList.toggle('dark-map', isDarkTheme);
  const btn = document.getElementById('btnTheme');
  if (btn) {
    btn.textContent = isDarkTheme ? '🌙' : '☀️';
    btn.title = isDarkTheme ? 'Váltás világos térképre' : 'Váltás sötét térképre';
  }
}

applyTheme();

const btnTheme = document.getElementById('btnTheme');
if (btnTheme) {
  btnTheme.addEventListener('click', () => {
    isDarkTheme = !isDarkTheme;
    localStorage.setItem(THEME_KEY, isDarkTheme ? 'dark' : 'light');
    applyTheme();
    showToast(isDarkTheme ? 'Sötét (szürkeárnyalatos) térkép bekapcsolva' : 'Világos térkép bekapcsolva');
  });
}

document.getElementById('btnSettings').addEventListener('click', () => {
  document.getElementById('apiKeyInput').value = customApiKey;
  document.getElementById('settingsModal').classList.remove('hidden');
});

document.getElementById('btnCancelModal').addEventListener('click', () => {
  document.getElementById('settingsModal').classList.add('hidden');
});

document.getElementById('btnSaveModal').addEventListener('click', () => {
  customApiKey = document.getElementById('apiKeyInput').value.trim();
  if (customApiKey) {
    localStorage.setItem(STORAGE_KEY, customApiKey);
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
  document.getElementById('settingsModal').classList.add('hidden');
  refreshAll();
});

// Zoom változáskor azonnal frissítjük a méreteket és pont/címke módot
map.on('zoomend', () => {
  renderVehicles();
  renderMavTrains();
  if (showStops) renderStops();
});

let moveTimeout;
map.on('moveend', () => {
  clearTimeout(moveTimeout);
  moveTimeout = setTimeout(() => {
    fetchVehicles();
    if (showStops) fetchStops();
  }, 450);
});

checkServerStatus();
fetchMavStations();
setInterval(refreshAll, 10000);
