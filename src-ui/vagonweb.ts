/**
 * vagonWEB.cz szerelvény-összeállítás megjelenítő modul
 */

import type { VagonwebCar, VagonwebComposition, VagonwebResponse } from "./types";

let currentVagonwebData: VagonwebResponse | null = null;

export function setCurrentVagonwebData(data: VagonwebResponse | null): void {
  currentVagonwebData = data;
}

export function renderVagonwebCarsHtml(cars: VagonwebCar[] | undefined): string {
  let html = `<div class="vagonweb-consist">`;
  html += `<div class="vagonweb-direction" title="Menetirány">⬅️</div>`;

  (cars || []).forEach((car) => {
    const isLoco =
      car.cls.includes("⚡") || (!car.num && car.cls === "");
    const carClassStyle = isLoco
      ? "loco"
      : car.cls.includes("1")
        ? "first-class"
        : "second-class";

    let visualHtml = "";
    if (car.img) {
      visualHtml = `<img src="${car.img}" class="vw-car-img" alt="${car.model}" loading="lazy" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="vw-car-box fallback" style="display:none;"><span class="vw-car-model">${car.model || "?"}</span></div>`;
    } else {
      visualHtml = `<div class="vw-car-box"><span class="vw-car-model">${car.model || "?"}</span></div>`;
    }

    html += `
      <div class="vagonweb-car ${carClassStyle}" title="${car.operator} ${car.model} ${car.route ? "(" + car.route + ")" : ""}">
        <div class="vw-car-top">
          ${car.num ? `<span class="vw-car-num">#${car.num}</span>` : `<span class="vw-car-num">Mozdony</span>`}
          ${car.cls && !isLoco ? `<span class="vw-car-cls">${car.cls}. o.</span>` : ""}
        </div>
        <div class="vw-car-visual">
          ${visualHtml}
        </div>
        <div class="vw-car-bottom">
          <span class="vw-car-type">${car.model || ""}</span>
        </div>
      </div>
    `;
  });

  html += `</div>`;
  return html;
}

export function switchVagonwebType(wantActual: boolean): void {
  const data = currentVagonwebData;
  if (!data || !data.compositions) return;

  const comp: VagonwebComposition =
    data.compositions.find((c) => c.isActual === wantActual) ||
    data.compositions[0];
  if (!comp) return;

  const carsContainer = document.getElementById("vw-cars-wrapper");
  if (carsContainer) {
    carsContainer.innerHTML = renderVagonwebCarsHtml(comp.cars);
  }

  const subtitleEl = document.getElementById("vw-comp-subtitle");
  if (subtitleEl) {
    subtitleEl.textContent = comp.title || "";
  }

  const btnPlanned = document.getElementById("vw-btn-planned");
  const btnActual = document.getElementById("vw-btn-actual");
  if (btnPlanned && btnActual) {
    btnPlanned.classList.toggle("active", !wantActual);
    btnActual.classList.toggle("active", wantActual);
  }
}

export function buildVagonwebSectionHtml(compData: VagonwebResponse): string {
  const comps = compData.compositions || [];
  const hasBoth = Boolean(compData.hasActual && compData.hasPlanned);
  const defaultComp: VagonwebComposition =
    comps.find((c) => c.isActual) ||
    comps[0] || {
      id: "default",
      cars: compData.cars || [],
      title: "",
      isActual: false,
    };

  let html = `<div class="vagonweb-header">`;
  html += `<div class="vw-header-top">`;
  html += `<span>🚃 Szerelvény-összeállítás (${compData.title || compData.trainNumber})</span>`;
  html += `<a href="${compData.url}" target="_blank" class="vagonweb-link" title="Megnyitás a vagonWEB.cz oldalon">vagonWEB ↗</a>`;
  html += `</div>`;

  if (hasBoth) {
    html += `
      <div class="vw-toggle-row">
        <button id="vw-btn-actual" class="vw-toggle-btn ${defaultComp.isActual ? "active" : ""}" onclick="switchVagonwebType(true)" title="Utasok által rögzített valós múltbeli összeállítás">
          📸 Valós megfigyelés
        </button>
        <button id="vw-btn-planned" class="vw-toggle-btn ${!defaultComp.isActual ? "active" : ""}" onclick="switchVagonwebType(false)" title="Menetrend szerinti tervezett összeállítás">
          📅 Tervezett (menetrendi)
        </button>
      </div>
    `;
  } else if (compData.hasActual) {
    html += `<div class="vw-badge-row"><span class="vw-mode-badge actual">📸 Valós megfigyelés alapján</span></div>`;
  } else {
    html += `<div class="vw-badge-row"><span class="vw-mode-badge planned">📅 Tervezett (menetrendi) összeállítás</span></div>`;
  }

  if (defaultComp.title) {
    html += `<div id="vw-comp-subtitle" class="vw-comp-subtitle">${defaultComp.title}</div>`;
  }
  html += `</div>`;

  html += `<div id="vw-cars-wrapper">`;
  html += renderVagonwebCarsHtml(defaultComp.cars);
  html += `</div>`;
  return html;
}
