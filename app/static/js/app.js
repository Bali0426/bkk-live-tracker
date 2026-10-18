const STORAGE_KEY = 'bkk_custom_api_key';
let customApiKey = localStorage.getItem(STORAGE_KEY) || '';
let vehicles = [];
let showStops = false;
let activeStopId = null;

const map = L.map('map', { zoomControl: false }).setView([47.4979, 19.0402], 14);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> közreműködők | Adatforrás: BKK Zrt.',
  maxZoom: 19
}).addTo(map);

const linesLayer = L.layerGroup().addTo(map);
const customRouteLayer = L.layerGroup().addTo(map);
const stopGroupLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const vehicleLayer = L.layerGroup().addTo(map);

// MÁV Rétegek
const mavRailsLayer = L.layerGroup().addTo(map);
const mavRouteLayer = L.layerGroup().addTo(map);
const mavTrainLayer = L.layerGroup().addTo(map);

let mavTrains = [];
let mavStations = [];
let activeStationName = null;
let showMavRails = false;
let activeMavTrain = null;
const activeMavCategories = {
  on_time: true,
  minor: true,
  major: true,
  ic_only: false
};

const activeVehicleModes = {
  SUBWAY: true,
  TRAM: true,
  TROLLEYBUS: true,
  BUS: true,
  RAIL: true
};

const activeLineModes = {
  SUBWAY: true,
  TRAM: true,
  TROLLEYBUS: true,
  BUS: true,
  RAIL: true
};

let networkData = null;
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
         name.includes('hév-állomás') ||
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
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
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
      showToast('Hiba a járművek lekérésekor: ' + res.status);
      return;
    }
    const data = await res.json();
    vehicles = data.vehicles || [];
    renderVehicles();
    document.getElementById('lastUpdated').textContent =
      'Frissítve: ' + new Date().toLocaleTimeString();
  } catch (err) {
    console.error('fetchVehicles failed:', err);
    showToast('Hiba a járművek lekérésekor');
  }
}

function renderVehicles() {
  vehicleLayer.clearLayers();
  const filterInput = document.getElementById('routeFilter');
  const q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  let count = 0;

  vehicles.forEach(v => {
    try {
      if (!v.lat || !v.lon) return;

      const mode = normalizeMode(v.routeType, v.routeShortName);
      if (!activeVehicleModes[mode]) return;

      const shortName = String(v.routeShortName || '').toLowerCase();
      const headsign = String(v.headsign || '').toLowerCase();
      if (q && !shortName.includes(q) && !headsign.includes(q)) return;

      count++;
      let name = String(v.routeShortName || '').trim();
      if (name.length > 8) {
        name = name.slice(0, 8);
      }
      if (!name) {
        name = v.licensePlate || '•';
      }

      const isLong = name.length > 3;
      const width = isLong ? Math.max(34, name.length * 8 + 10) : 28;
      const height = 28;
      const icon = L.divIcon({
        className: 'vehicle-div-icon',
        html: `<div class="v-marker" style="min-width:${width}px;height:${height}px;background:${v.color || '#009EE3'};color:${v.textColor || '#FFFFFF'};">${name}</div>`,
        iconSize: [width, height],
        iconAnchor: [width / 2, height / 2]
      });

      const m = L.marker([v.lat, v.lon], { icon, zIndexOffset: 1000 });
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

  const statsEl = document.getElementById('vehicleStats');
  if (statsEl) {
    statsEl.textContent = `${count} jármű látható`;
  }
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

  // 1. Konvex burok (Monotone Chain)
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
    hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  }

  // Egy pont -> kör
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

  // Két pont -> stadion / lekerekített kapszula (mint a képen balra: Kossuth Lajos tér)
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

  // 3+ pont: Minden sarokban ív és érintő egyenesek (mint a képen középen: Báthory utca)
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

async function fetchStops() {
  if (!showStops) {
    stopGroupLayer.clearLayers();
    stopLayer.clearLayers();
    return;
  }
  const bounds = map.getBounds();
  const center = bounds.getCenter();
  const latSpan = Math.min(0.025, Math.abs(bounds.getNorth() - bounds.getSouth()));
  const lonSpan = Math.min(0.035, Math.abs(bounds.getEast() - bounds.getWest()));

  try {
    const res = await fetch(
      `/api/stops?lat=${center.lat}&lon=${center.lng}&lat_span=${latSpan}&lon_span=${lonSpan}`,
      { headers: getHeaders() }
    );
    if (!res.ok) return;
    const data = await res.json();
    stopGroupLayer.clearLayers();
    stopLayer.clearLayers();

    const stopsList = data.stops || [];

    // Csoportosítás parentStationId szerint (vagy név szerint, ha nincs)
    const groups = {};
    stopsList.forEach(s => {
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

    // 1. Megállócsoportok lekerekített burka (OSM Transport stílus)
    Object.values(groups).forEach(g => {
      const pts = g.children.map(c => [c.lat, c.lon]);
      if (pts.length < 2) return;

      // Ha túl nagy a távolság (> 450m), ne kössük össze (különálló területek)
      const d = calcDistanceMeters(pts[0][0], pts[0][1], pts[1][0], pts[1][1]);
      if (d > 450) return;

      const groupTargetId = g.parent ? g.parent.stopId : (g.children[0] ? g.children[0].stopId : g.id);

      // Lekerekített körbefoglaló burok (sarokívekkel minden peron körül)
      const roundedHull = getRoundedHull(pts, 24);
      if (roundedHull.length >= 3) {
        const hullPolygon = L.polygon(roundedHull, {
          color: '#4f46e5',
          weight: 1.5,
          opacity: 0.85,
          fillColor: '#4f46e5',
          fillOpacity: 0.22,
          lineJoin: 'round',
          lineCap: 'round',
          className: 'stop-group-polygon'
        });

        hullPolygon.bindTooltip(`
          <div style="font-size:12px;line-height:1.4;">
            <span class="stop-badge stop-badge-parent">🏢 ${pts.length === 2 ? 'Közös megálló (2 peron)' : `Csomópont (${pts.length} peron)`}</span><br>
            <strong style="font-size:13px;color:#f8fafc;">${g.name}</strong><br>
            <span style="color:#94a3b8;font-size:11px;">Kattints a megállócsoport összes indulásához</span>
          </div>
        `, { direction: 'top', sticky: true });

        hullPolygon.on('mouseover', () => hullPolygon.setStyle({ fillOpacity: 0.38, weight: 2.2, color: '#818cf8' }));
        hullPolygon.on('mouseout', () => hullPolygon.setStyle({ fillOpacity: 0.22, weight: 1.5, color: '#4f46e5' }));
        hullPolygon.on('click', () => handleStopClick({ stopId: groupTargetId, name: g.name }));

        stopGroupLayer.addLayer(hullPolygon);
      }
    });

    // 2. Egyedi megálló jelölők felrajzolása (Egységes normál megállóként jelennek meg)
    stopsList.forEach(s => {
      const isParent = Boolean(s.isStopArea || s.locationType === 1);
      
      const iconSize = isParent ? [20, 20] : [13, 13];
      const iconAnchor = isParent ? [10, 10] : [6.5, 6.5];
      const markerHtml = isParent
        ? `<div class="stop-marker stop-marker-parent" title="${s.name} (Gyűjtőállomás)">🏢</div>`
        : `<div class="stop-marker stop-marker-dir" title="${s.name}"></div>`;

      const icon = L.divIcon({
        className: '',
        html: markerHtml,
        iconSize: iconSize,
        iconAnchor: iconAnchor
      });

      const marker = L.marker([s.lat, s.lon], { icon, zIndexOffset: isParent ? 500 : 0 });
      
      const badgeHtml = isParent
        ? `<span class="stop-badge stop-badge-parent">🏢 Gyűjtőmegálló</span>`
        : `<span class="stop-badge stop-badge-dir">🚏 Per-irány megálló${s.direction ? ` (${s.direction}°)` : ''}</span>`;
      
      const typeInfo = s.type ? `<span style="color:#94a3b8;font-size:11px;"> • ${s.type}</span>` : '';

      marker.bindTooltip(`
        <div style="font-size:12px;line-height:1.4;">
          ${badgeHtml}${typeInfo}<br>
          <strong style="font-size:13px;color:#f8fafc;">${s.name}</strong><br>
          <span style="color:#94a3b8;font-size:11px;">ID: <code>${s.stopId}</code></span>
          ${s.parentStationId ? `<br><span style="color:#64748b;font-size:10px;">Gyűjtő ID: ${s.parentStationId}</span>` : ''}
        </div>
      `, {
        direction: 'top',
        offset: isParent ? [0, -10] : [0, -7]
      });

      marker.on('click', () => handleStopClick(s));
      stopLayer.addLayer(marker);
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadStopDepartures(stopId, stopName = '') {
  if (!stopId) return;
  activeStopId = stopId.trim();
  const stopInput = document.getElementById('stopInput');
  if (stopInput) stopInput.value = activeStopId;

  try {
    const res = await fetch(`/api/departures/${encodeURIComponent(activeStopId)}?limit=10`, {
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Megálló nem található');
    const data = await res.json();

    document.getElementById('mavBoard').classList.add('hidden');
    const board = document.getElementById('futarBoard');
    board.classList.remove('hidden');

    const displayName = data.stopName || stopName || activeStopId;
    document.getElementById('boardStopName').textContent = displayName;
    document.getElementById('boardStopId').textContent = data.stopId;
    document.getElementById('boardApiUrl').textContent = `/api/departures/${data.stopId}`;

    // Ha a megálló egyben vasútállomás is, biztosítunk gombot a MÁV menetrendhez
    const isTrain = isRailwayStation({ name: displayName });
    let mavSwitchBtn = document.getElementById('btnBoardSwitchToMav');
    if (isTrain) {
      if (!mavSwitchBtn) {
        mavSwitchBtn = document.createElement('button');
        mavSwitchBtn.id = 'btnBoardSwitchToMav';
        mavSwitchBtn.className = 'btn btn-primary';
        mavSwitchBtn.style.cssText = 'margin-top:8px;width:100%;font-size:12px;padding:6px;';
        document.querySelector('.board-stop-id').insertAdjacentElement('afterend', mavSwitchBtn);
      }
      mavSwitchBtn.innerHTML = `🚆 MÁV Vonat Menetrend (${getCleanStationName(displayName)})`;
      mavSwitchBtn.onclick = () => loadMavStationDetails(getCleanStationName(displayName), false, data.stopId);
      mavSwitchBtn.style.display = 'block';
    } else if (mavSwitchBtn) {
      mavSwitchBtn.style.display = 'none';
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
    showToast('Nem sikerült betölteni a megállót: ' + activeStopId);
  }
}

// Tab kezelés
function switchTab(tabId) {
  activeTab = tabId;
  const isVeh = (tabId === 'tabVehicles');
  const isLines = (tabId === 'tabLines');
  const isMav = (tabId === 'tabMav');
  const isStations = (tabId === 'tabStations');

  document.getElementById('tabVehiclesBtn').classList.toggle('active', isVeh);
  document.getElementById('tabLinesBtn').classList.toggle('active', isLines);
  document.getElementById('tabMavBtn').classList.toggle('active', isMav);
  document.getElementById('tabStationsBtn').classList.toggle('active', isStations);

  document.getElementById('tabVehicles').classList.toggle('hidden', !isVeh);
  document.getElementById('tabLines').classList.toggle('hidden', !isLines);
  document.getElementById('tabMav').classList.toggle('hidden', !isMav);
  document.getElementById('tabStations').classList.toggle('hidden', !isStations);

  if (isLines && !networkData) {
    loadTransitNetwork();
  } else if (isMav && mavTrains.length === 0) {
    fetchMavTrains();
  } else if (isStations && mavStations.length === 0) {
    fetchMavStations();
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
  if (!networkData || !networkData.routes) return;
  linesLayer.clearLayers();
  let drawnCount = 0;

  networkData.routes.forEach(route => {
    const mode = normalizeMode(route.type, route.shortName);
    if (!activeLineModes[mode]) return;
    drawnCount++;

    (route.polylines || []).forEach(variant => {
      if (!variant.coordinates || variant.coordinates.length === 0) return;

      // Háttér sötét sáv a kontraszthoz
      const glowLine = L.polyline(variant.coordinates, {
        color: '#000000',
        weight: 6,
        opacity: 0.55,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      linesLayer.addLayer(glowLine);

      // Fő vonal hivatalos BKK vonalszínnel
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

  const statEl = document.getElementById('linesStats');
  if (statEl) {
    statEl.textContent = `${drawnCount} járat nyomvonala látható`;
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

    // Átváltunk a vonalak fülre
    switchTab('tabLines');
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
  try {
    const res = await fetch('/api/mav/trains');
    if (!res.ok) {
      console.warn('MÁV API hiba:', res.status);
      return;
    }
    const data = await res.json();
    mavTrains = data.trains || [];
    renderMavTrains();

    const statsEl = document.getElementById('mavStats');
    if (statsEl) {
      statsEl.textContent = `${mavTrains.length} vonat a hálózaton`;
    }
    const avgDelayEl = document.getElementById('mavAvgDelay');
    if (avgDelayEl) {
      avgDelayEl.textContent = `Átl. késés: ${data.avgDelay || 0} perc`;
    }
  } catch (err) {
    console.error('fetchMavTrains failed:', err);
  }
}

function renderMavTrains() {
  mavTrainLayer.clearLayers();
  const filterInput = document.getElementById('mavFilter');
  const q = filterInput ? filterInput.value.trim().toLowerCase() : '';
  let count = 0;

  mavTrains.forEach(t => {
    try {
      if (!t.lat || !t.lon) return;

      // Kategória és IC szűrés
      if (activeMavCategories.ic_only && !t.isIC) return;
      if (!activeMavCategories[t.category]) return;

      // Kereső mező (vonatszám vagy viszonylat)
      if (q) {
        const trainNum = String(t.trainNumber || '').toLowerCase();
        const rel = String(t.relation || '').toLowerCase();
        if (!trainNum.includes(q) && !rel.includes(q)) return;
      }

      count++;
      const displayName = t.trainNumber || 'Vonat';
      const delayBadgeText = t.delay <= 0 ? '0p' : `+${t.delay}p`;

      const icon = L.divIcon({
        className: 'mav-div-icon',
        html: `
          <div class="mav-marker" title="${t.trainNumber} - ${t.relation} (${t.statusText})">
            <span class="mav-icon-tag">🚆</span>
            <span class="mav-name-tag">${displayName}</span>
            <span class="mav-delay-pill" style="background:${t.color};color:${t.textColor};">${delayBadgeText}</span>
          </div>
        `,
        iconAnchor: [35, 14]
      });

      const m = L.marker([t.lat, t.lon], { icon, zIndexOffset: 950 });

      m.bindPopup(`
        <div style="font-size:13px;line-height:1.5;min-width:240px;">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">
            <strong style="font-size:15px;color:#38bdf8;">🚆 ${t.trainNumber}</strong>
            <span class="mav-delay-pill" style="background:${t.color};color:${t.textColor};font-weight:bold;padding:2px 6px;">${t.statusText}</span>
          </div>
          <div style="color:#f8fafc;font-size:12px;margin-bottom:6px;">
            <strong>${t.relation}</strong>
          </div>
          <div style="color:#94a3b8;font-size:11px;margin-bottom:10px;">
            Menetvonal: <b>${t.menetvonal}</b>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-primary" style="flex:1;font-size:11px;padding:6px 8px;" onclick="loadMavTrainDetails('${t.elviraId}', '${t.trainNumber}', '${encodeURIComponent(t.relation)}')">📋 Menetrend</button>
            <button class="btn btn-secondary" style="font-size:11px;padding:6px 8px;" onclick="loadAndDrawMavRoute('${t.elviraId}', '${t.trainNumber}')">🛤️ Nyomvonal</button>
          </div>
        </div>
      `);

      mavTrainLayer.addLayer(m);
    } catch (err) {
      console.error('Error rendering mav train:', err, t);
    }
  });

  const statsEl = document.getElementById('mavStats');
  if (statsEl) {
    statsEl.textContent = `${count} / ${mavTrains.length} vonat látható`;
  }
}

// MÁV Menetrend és közbenső állomások lekérése
async function loadMavTrainDetails(elviraId, trainNumber, encodedRelation = '', silent = false) {
  if (!elviraId) return;
  const relation = encodedRelation ? decodeURIComponent(encodedRelation) : (activeMavTrain ? activeMavTrain.relation : '');
  activeMavTrain = { elviraId, trainNumber, relation };

  try {
    if (!silent) {
      showToast(`🚆 ${trainNumber} menetrendjének betöltése...`);
    }
    const res = await fetch(`/api/mav/trains/${encodeURIComponent(elviraId)}?train_number=${encodeURIComponent(trainNumber || '')}`);
    if (!res.ok) throw new Error('Menetrend nem tölthető be');
    const data = await res.json();

    document.getElementById('futarBoard').classList.add('hidden');
    const board = document.getElementById('mavBoard');
    board.classList.remove('hidden');

    document.getElementById('mavBoardTrainName').textContent = `🚆 ${trainNumber || 'MÁV Járat'}`;
    document.getElementById('mavBoardRelation').textContent = relation || '';

    const listEl = document.getElementById('mavBoardTimetableList');
    if (data.html) {
      listEl.innerHTML = data.html;
      listEl.querySelectorAll('a').forEach(a => {
        a.removeAttribute('onclick');
        a.style.cursor = 'default';
      });
    } else {
      listEl.innerHTML = '<div style="padding:16px;color:#94a3b8;font-size:13px;">Nincs elérhető menetrend adat ehhez a járathoz.</div>';
    }

    if (data.polylines && data.polylines.length > 0) {
      drawMavTrainPolylines(data.polylines, trainNumber, !silent);
    }
  } catch (err) {
    console.error(err);
    if (!silent) {
      showToast(`Nem sikerült betölteni a menetrendet: ${trainNumber}`);
    }
  }
}
window.loadMavTrainDetails = loadMavTrainDetails;

// MÁV nyomvonal kirajzolása
async function loadAndDrawMavRoute(elviraId, trainNumber) {
  if (!elviraId) return;
  try {
    showToast(`🛤️ ${trainNumber} nyomvonalának lekérése...`);
    const res = await fetch(`/api/mav/trains/${encodeURIComponent(elviraId)}?train_number=${encodeURIComponent(trainNumber || '')}`);
    if (!res.ok) throw new Error('Nyomvonal nem található');
    const data = await res.json();

    if (!data.polylines || data.polylines.length === 0) {
      showToast('Nincs elérhető nyomvonal ehhez a vonathoz: ' + trainNumber);
      return;
    }

    drawMavTrainPolylines(data.polylines, trainNumber, true);
    showToast(`🛤️ ${trainNumber} nyomvonala kirajzolva!`);
  } catch (err) {
    console.error(err);
    showToast('Hiba a nyomvonal betöltésekor: ' + trainNumber);
  }
}
window.loadAndDrawMavRoute = loadAndDrawMavRoute;

function drawMavTrainPolylines(polylines, trainNumber, fitBounds = false) {
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
    line.bindTooltip(`<strong>🚆 ${trainNumber}</strong> nyomvonala`, { sticky: true });
    mavRouteLayer.addLayer(line);
  });

  if (fitBounds) {
    const bounds = mavRouteLayer.getBounds();
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }
}

// Vasúti hálózat vágányainak be/kikapcsolása
async function toggleMavRails() {
  showMavRails = !showMavRails;
  const btn = document.getElementById('btnToggleMavRails');
  if (btn) btn.classList.toggle('active', showMavRails);

  if (!showMavRails) {
    mavRailsLayer.clearLayers();
    showToast('Vasútvonalak elrejtve');
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
        color: '#64748b',
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
    showToast(`🛤️ ${data.count || 0} vasúti szakasz betöltve!`);
  } catch (err) {
    console.error(err);
    showToast('Hiba a vasúthálózat betöltésekor');
  }
}

// 🚉 Vasútállomások és Menetrend Kezelése
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

  // 1. Ismert állomások (főpályaudvarok, vármegyeszékhelyek koordinátákkal)
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
      await loadMavStationDetails(known.name);
      return;
    }
  }

  // 2. BKK Stop ID esetén (pl. BKK_F01046)
  if (q.startsWith('BKK_')) {
    await loadStopDepartures(q);
    return;
  }

  // 3. Tisztított állomásnév lekérdezése MÁV-tól
  const cleanName = getCleanStationName(q);
  showToast(`🔍 Menetrend keresése: ${cleanName}...`);
  const success = await loadMavStationDetails(cleanName);
  if (success) return;

  showToast(`Nem található állomás: "${q}"`);
}
window.searchStationOrStop = searchStationOrStop;

async function loadMavStationDetails(stationName, silent = false, bkkStopId = null) {
  if (!stationName) return;
  activeStationName = stationName.trim();
  const inp = document.getElementById('stationSearchInput');
  if (inp) inp.value = activeStationName;

  // Ha ismert állomás, odarepítjük a térképet
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

  try {
    if (!silent) {
      showToast(`🚉 ${activeStationName} menetrendjének betöltése...`);
    }
    const res = await fetch(`/api/mav/stations/${encodeURIComponent(activeStationName)}`);
    if (!res.ok) throw new Error('Nem sikerült betölteni az állomást');
    const data = await res.json();

    document.getElementById('futarBoard').classList.add('hidden');
    const board = document.getElementById('mavBoard');
    board.classList.remove('hidden');

    document.getElementById('mavBoardSubtitle').textContent = 'MÁV-START ÉLŐ ÁLLOMÁSI MENETREND';
    document.getElementById('mavBoardTrainName').textContent = `🚉 ${data.station || activeStationName}`;
    
    // BKK kapcsolódási gomb ha van megadott stopId
    let bkkBtnHtml = '';
    if (bkkStopId) {
      bkkBtnHtml = `<button class="btn btn-secondary" style="margin-top:6px;width:100%;font-size:11px;padding:4px 8px;" onclick="loadStopDepartures('${bkkStopId}', '${activeStationName}')">🚏 Helyi BKK Járatok & Indulások</button>`;
    }
    document.getElementById('mavBoardRelation').innerHTML = `<span>Élő indulások és érkezések • Vágánykijelző</span>${bkkBtnHtml}`;
    
    const footerText = document.getElementById('mavBoardFooterText');
    if (footerText) {
      footerText.textContent = 'Kattints bármely vonatszámra az útvonal és térképi nyomvonal megtekintéséhez!';
    }

    const listEl = document.getElementById('mavBoardTimetableList');
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
  if (showStops) fetchStops();
  if (activeStopId) loadStopDepartures(activeStopId);
  if (activeTab === 'tabMav' || mavTrains.length > 0) fetchMavTrains();
  if (activeMavTrain) loadMavTrainDetails(activeMavTrain.elviraId, activeMavTrain.trainNumber, activeMavTrain.relation, true);
  if (activeStationName) loadMavStationDetails(activeStationName, true);
}

// Eseménykezelők
document.getElementById('routeFilter').addEventListener('input', renderVehicles);
document.getElementById('btnRefresh').addEventListener('click', refreshAll);

// Fülváltás
document.getElementById('tabVehiclesBtn').addEventListener('click', () => switchTab('tabVehicles'));
document.getElementById('tabLinesBtn').addEventListener('click', () => switchTab('tabLines'));
document.getElementById('tabMavBtn').addEventListener('click', () => switchTab('tabMav'));
document.getElementById('tabStationsBtn').addEventListener('click', () => switchTab('tabStations'));

// Menetrend kereső vezérlők
function triggerStationSearch() {
  const val = document.getElementById('stationSearchInput').value.trim();
  if (val) searchStationOrStop(val);
}

const btnSearchStation = document.getElementById('btnSearchStation');
if (btnSearchStation) {
  btnSearchStation.addEventListener('click', triggerStationSearch);
}
const stationSearchInput = document.getElementById('stationSearchInput');
if (stationSearchInput) {
  stationSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') triggerStationSearch();
  });
}

// MÁV vezérlők
document.getElementById('mavFilter').addEventListener('input', renderMavTrains);
document.getElementById('btnToggleMavRails').addEventListener('click', toggleMavRails);
const btnFitMav = document.getElementById('btnFitMavTrains');
if (btnFitMav) {
  btnFitMav.addEventListener('click', () => {
    map.flyTo([47.1625, 19.5033], 8);
    showToast('🇭🇺 Teljes országos vasúti nézet');
  });
}

document.getElementById('btnCloseMavBoard').addEventListener('click', () => {
  document.getElementById('mavBoard').classList.add('hidden');
  mavRouteLayer.clearLayers();
  activeMavTrain = null;
});

document.querySelectorAll('.mav-toggle-switch').forEach(sw => {
  sw.addEventListener('change', (e) => {
    const cat = e.target.dataset.category;
    activeMavCategories[cat] = e.target.checked;
    renderMavTrains();
  });
});

// Sima Toggle kapcsolók (Switch toggles)
document.querySelectorAll('.mode-toggle-switch').forEach(sw => {
  sw.addEventListener('change', (e) => {
    const type = e.target.dataset.type;
    const mode = e.target.dataset.mode;
    if (type === 'vehicle') {
      activeVehicleModes[mode] = e.target.checked;
      renderVehicles();
    } else if (type === 'line') {
      activeLineModes[mode] = e.target.checked;
      renderTransitNetwork();
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
  renderTransitNetwork();
});

document.getElementById('btnToggleStops').addEventListener('click', (e) => {
  showStops = !showStops;
  e.currentTarget.classList.toggle('active', showStops);
  fetchStops();
  if (showStops) showToast('🚏 Megállók: 🔵 Lekerekített burok = Közös megállócsoport (OSM stílus)');
});

document.getElementById('btnLoadStop').addEventListener('click', () => {
  const val = document.getElementById('stopInput').value.trim();
  if (val) loadStopDepartures(val);
});

document.getElementById('btnCloseBoard').addEventListener('click', () => {
  document.getElementById('futarBoard').classList.add('hidden');
  activeStopId = null;
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
    showToast(isDarkTheme ? 'Sötét térkép bekapcsolva' : 'Világos térkép bekapcsolva');
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

let moveTimeout;
map.on('moveend', () => {
  clearTimeout(moveTimeout);
  moveTimeout = setTimeout(() => {
    fetchVehicles();
    if (showStops) fetchStops();
  }, 500);
});

checkServerStatus();
fetchMavStations();
setInterval(refreshAll, 10000);
