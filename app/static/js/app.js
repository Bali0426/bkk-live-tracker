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

const vehicleLayer = L.layerGroup().addTo(map);
const stopLayer = L.layerGroup().addTo(map);

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
        Típus: ${v.model || v.routeType}
      </div>
    `);
    vehicleLayer.addLayer(m);
  });

  document.getElementById('vehicleStats').textContent = `${count} jármű látható`;
}

async function fetchStops() {
  if (!showStops) {
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
    stopLayer.clearLayers();

    (data.stops || []).forEach(s => {
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
          <span class="dep-badge" style="background:${d.color};color:${d.textColor};">${d.routeShortName}</span>
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

function refreshAll() {
  fetchVehicles();
  if (showStops) fetchStops();
  if (activeStopId) loadStopDepartures(activeStopId);
}

// Eseménykezelők
document.getElementById('routeFilter').addEventListener('input', renderVehicles);
document.getElementById('btnRefresh').addEventListener('click', refreshAll);

document.getElementById('btnToggleStops').addEventListener('click', (e) => {
  showStops = !showStops;
  e.currentTarget.classList.toggle('active', showStops);
  fetchStops();
  if (showStops) showToast('🚏 Megállók: 🏢 Lila = Gyűjtőállomás | 🔴 Korall = Per-irány megálló');
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
