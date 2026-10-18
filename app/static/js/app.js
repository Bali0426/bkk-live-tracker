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
const stopGroupLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);
const vehicleLayer = L.layerGroup().addTo(map);

const activeModes = {
  SUBWAY: true,
  TRAM: true,
  TROLLEYBUS: true,
  BUS: true,
  RAIL: true
};

let showLines = false;
let networkData = null;

function normalizeMode(type) {
  if (!type) return 'BUS';
  const t = String(type).toUpperCase();
  if (t === 'SUBWAY' || t === 'METRO') return 'SUBWAY';
  if (t === 'TRAM') return 'TRAM';
  if (t === 'TROLLEYBUS') return 'TROLLEYBUS';
  if (t === 'RAIL' || t === 'TRAIN' || t === 'HEV') return 'RAIL';
  return 'BUS';
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
  try {
    const res = await fetch('/api/status');
    const data = await res.json();
    if (!data.hasEnvApiKey && !customApiKey) {
      document.getElementById('settingsModal').classList.remove('hidden');
    } else {
      refreshAll();
    }
  } catch (e) {
    console.error(e);
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
    if (res.status === 401) {
      document.getElementById('settingsModal').classList.remove('hidden');
      return;
    }
    if (!res.ok) throw new Error('API hiba');
    const data = await res.json();
    vehicles = data.vehicles || [];
    renderVehicles();
    document.getElementById('lastUpdated').textContent =
      'Frissítve: ' + new Date().toLocaleTimeString();
  } catch (err) {
    showToast('Hiba a járművek lekérésekor');
  }
}

function renderVehicles() {
  vehicleLayer.clearLayers();
  const q = document.getElementById('routeFilter').value.trim().toLowerCase();
  let count = 0;

  vehicles.forEach(v => {
    const mode = normalizeMode(v.routeType);
    if (!activeModes[mode]) return;

    const shortName = String(v.routeShortName || '').toLowerCase();
    const headsign = String(v.headsign || '').toLowerCase();
    if (q && !shortName.includes(q) && !headsign.includes(q)) return;

    count++;
    const name = String(v.routeShortName || '');
    const isLong = name.length > 3;
    const width = isLong ? Math.max(34, name.length * 8 + 10) : 28;
    const height = 28;
    const icon = L.divIcon({
      className: '',
      html: `<div class="v-marker" style="min-width:${width}px;height:${height}px;background:${v.color};color:${v.textColor};">${name}</div>`,
      iconSize: [width, height],
      iconAnchor: [width / 2, height / 2]
    });

    const m = L.marker([v.lat, v.lon], { icon });
    m.bindPopup(`
      <div style="font-size:13px;line-height:1.5;">
        <strong>${v.routeShortName} → ${v.headsign || 'N/A'}</strong><br>
        Rendszám: <b>${v.licensePlate || 'N/A'}</b><br>
        Sebesség: ${v.speedKmh} km/h<br>
        Típus: ${v.model || v.routeType}<br>
        <button class="btn btn-secondary" style="margin-top:8px;width:100%;font-size:11px;" onclick="loadAndDrawRoute('${v.routeId || v.routeShortName}')">🛤️ Nyomvonal kirajzolása</button>
      </div>
    `);
    vehicleLayer.addLayer(m);
  });

  document.getElementById('vehicleStats').textContent = `${count} jármű látható`;
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
        hullPolygon.on('click', () => loadStopDepartures(groupTargetId));

        stopGroupLayer.addLayer(hullPolygon);
      }
    });

    // 2. Egyedi megálló jelölők felrajzolása
    stopsList.forEach(s => {
      const isParent = Boolean(s.isStopArea || s.locationType === 1);
      
      let markerHtml = '';
      let iconSize = [13, 13];
      let iconAnchor = [6.5, 6.5];
      
      if (isParent) {
        iconSize = [20, 20];
        iconAnchor = [10, 10];
        markerHtml = `<div class="stop-marker stop-marker-parent" title="${s.name} (Gyűjtőállomás)">🏢</div>`;
      } else {
        iconSize = [13, 13];
        iconAnchor = [6.5, 6.5];
        markerHtml = `<div class="stop-marker stop-marker-dir" title="${s.name} (Per-irány megálló)"></div>`;
      }

      const icon = L.divIcon({
        className: '',
        html: markerHtml,
        iconSize: iconSize,
        iconAnchor: iconAnchor
      });

      const marker = L.marker([s.lat, s.lon], { icon });
      
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

      marker.on('click', () => loadStopDepartures(s.stopId));
      stopLayer.addLayer(marker);
    });
  } catch (e) {
    console.error(e);
  }
}

async function loadStopDepartures(stopId) {
  if (!stopId) return;
  activeStopId = stopId.trim();
  document.getElementById('stopInput').value = activeStopId;

  try {
    const res = await fetch(`/api/departures/${encodeURIComponent(activeStopId)}?limit=10`, {
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Megálló nem található');
    const data = await res.json();

    document.getElementById('futarBoard').classList.remove('hidden');
    document.getElementById('boardStopName').textContent = data.stopName;
    document.getElementById('boardStopId').textContent = data.stopId;
    document.getElementById('boardApiUrl').textContent = `/api/departures/${data.stopId}`;

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

// Vonalhálózat kezelése
async function toggleTransitNetwork() {
  showLines = !showLines;
  const btn = document.getElementById('btnToggleLines');
  if (btn) btn.classList.toggle('active', showLines);

  if (!showLines) {
    linesLayer.clearLayers();
    showToast('🛤️ Vonalhálózat kikapcsolva');
    return;
  }

  showToast('🛤️ Vonalhálózat betöltése...');
  if (!networkData) {
    try {
      const res = await fetch('/api/network', { headers: getHeaders() });
      if (!res.ok) throw new Error('Hálózat betöltési hiba');
      networkData = await res.json();
    } catch (e) {
      console.error(e);
      showToast('Nem sikerült betölteni a vonalhálózatot');
      showLines = false;
      if (btn) btn.classList.remove('active');
      return;
    }
  }

  renderTransitNetwork();
  showToast('🛤️ Metró- és főbb villamosvonalak megjelenítve');
}

function renderTransitNetwork() {
  if (!showLines || !networkData || !networkData.routes) return;
  linesLayer.clearLayers();

  networkData.routes.forEach(route => {
    const mode = normalizeMode(route.type);
    if (!activeModes[mode]) return;

    (route.polylines || []).forEach(variant => {
      if (!variant.coordinates || variant.coordinates.length === 0) return;

      // Glow / kontraszt háttér sötét térképen
      const glowLine = L.polyline(variant.coordinates, {
        color: '#000000',
        weight: 6,
        opacity: 0.55,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      linesLayer.addLayer(glowLine);

      // Fő színes nyomvonal (hivatalos BKK vonalszín)
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

let activeRoutePolyline = null;
async function loadAndDrawRoute(routeId) {
  if (!routeId) return;
  try {
    showToast(`🛤️ Nyomvonal betöltése: ${routeId}...`);
    const res = await fetch(`/api/routes/${encodeURIComponent(routeId)}`, { headers: getHeaders() });
    if (!res.ok) throw new Error('Járat nem található');
    const data = await res.json();

    if (!data.polylines || data.polylines.length === 0) {
      showToast('Nincs elérhető nyomvonal ehhez a járathoz');
      return;
    }

    if (activeRoutePolyline) {
      map.removeLayer(activeRoutePolyline);
      activeRoutePolyline = null;
    }

    const group = L.featureGroup();
    data.polylines.forEach(v => {
      if (!v.coordinates || v.coordinates.length === 0) return;

      // Háttér sáv
      const bg = L.polyline(v.coordinates, {
        color: '#000000',
        weight: 7,
        opacity: 0.6,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false
      });
      group.addLayer(bg);

      // Fő vonal
      const poly = L.polyline(v.coordinates, {
        color: data.color || '#38bdf8',
        weight: 4.5,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round'
      });
      poly.bindTooltip(
        `<strong style="color:${data.color}">${data.shortName}</strong> → ${v.headsign || v.name}`,
        { className: 'transit-line-tooltip', sticky: true }
      );
      group.addLayer(poly);
    });

    group.addTo(map);
    activeRoutePolyline = group;
    map.fitBounds(group.getBounds(), { padding: [40, 40] });
    showToast(`🛤️ ${data.shortName} nyomvonala kirajzolva!`);
  } catch (e) {
    console.error(e);
    showToast(`Hiba a járat nyomvonalának betöltésekor: ${routeId}`);
  }
}
window.loadAndDrawRoute = loadAndDrawRoute;

function refreshAll() {
  fetchVehicles();
  if (showStops) fetchStops();
  if (activeStopId) loadStopDepartures(activeStopId);
}

// Eseménykezelők
document.getElementById('routeFilter').addEventListener('input', renderVehicles);
document.getElementById('btnRefresh').addEventListener('click', refreshAll);

const btnLines = document.getElementById('btnToggleLines');
if (btnLines) {
  btnLines.addEventListener('click', toggleTransitNetwork);
}

document.querySelectorAll('.mode-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    const mode = chip.dataset.mode;
    activeModes[mode] = !activeModes[mode];
    chip.classList.toggle('active', activeModes[mode]);
    renderVehicles();
    if (showLines) renderTransitNetwork();
  });
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
setInterval(refreshAll, 10000);
