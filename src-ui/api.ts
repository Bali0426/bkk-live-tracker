/**
 * BKK & MÁV Live Tracker – Tauri v2 IPC / REST API Kliens (Windows & Android)
 *
 * Natív Tauri környezetben közvetlenül a Rust háttérmodult hívja (`invoke`),
 * böngészős fejlesztői nézetben pedig visszalép a helyi `/api/...` végpontokra.
 */

import { invoke } from "@tauri-apps/api/core";
import type {
  ApiStatusResponse,
  BkkDeparturesResponse,
  BkkStopsResponse,
  BkkVehiclesResponse,
  MavNetworkResponse,
  MavStationDetailsResponse,
  MavStationsResponse,
  MavTrainDetailsResponse,
  MavTrainsResponse,
  RouteDetailsResponse,
  TransitNetworkResponse,
  VagonwebResponse,
} from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export function isTauriApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["X-BKK-Key"] = apiKey;
  }
  return headers;
}

export const api = {
  async checkStatus(): Promise<ApiStatusResponse> {
    if (isTauriApp()) {
      return await invoke<ApiStatusResponse>("cmd_api_status");
    }
    const res = await fetch("http://127.0.0.1:8000/api/status");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getVehicles(params: {
    lat: number;
    lon: number;
    latSpan: number;
    lonSpan: number;
    apiKey?: string;
  }): Promise<BkkVehiclesResponse> {
    if (isTauriApp()) {
      return await invoke<BkkVehiclesResponse>("cmd_get_vehicles", {
        lat: params.lat,
        lon: params.lon,
        latSpan: params.latSpan,
        lonSpan: params.lonSpan,
        key: params.apiKey || null,
      });
    }
    const q = new URLSearchParams({
      lat: params.lat.toFixed(5),
      lon: params.lon.toFixed(5),
      lat_span: params.latSpan.toFixed(4),
      lon_span: params.lonSpan.toFixed(4),
    });
    const res = await fetch(`http://127.0.0.1:8000/api/vehicles?${q}`, {
      headers: buildHeaders(params.apiKey),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getStops(params: {
    lat: number;
    lon: number;
    latSpan: number;
    lonSpan: number;
    apiKey?: string;
  }): Promise<BkkStopsResponse> {
    if (isTauriApp()) {
      return await invoke<BkkStopsResponse>("cmd_get_stops", {
        lat: params.lat,
        lon: params.lon,
        latSpan: params.latSpan,
        lonSpan: params.lonSpan,
        key: params.apiKey || null,
      });
    }
    const q = new URLSearchParams({
      lat: params.lat.toFixed(5),
      lon: params.lon.toFixed(5),
      lat_span: params.latSpan.toFixed(4),
      lon_span: params.lonSpan.toFixed(4),
    });
    const res = await fetch(`http://127.0.0.1:8000/api/stops?${q}`, {
      headers: buildHeaders(params.apiKey),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getDepartures(params: {
    stopId: string;
    limit?: number;
    minutesAfter?: number;
    apiKey?: string;
  }): Promise<BkkDeparturesResponse> {
    const limit = params.limit ?? 10;
    const minutesAfter = params.minutesAfter ?? 60;
    if (isTauriApp()) {
      return await invoke<BkkDeparturesResponse>("cmd_get_departures", {
        stopId: params.stopId,
        limit,
        minutesAfter,
        key: params.apiKey || null,
      });
    }
    const res = await fetch(
      `http://127.0.0.1:8000/api/departures/${encodeURIComponent(params.stopId)}?limit=${limit}&minutes_after=${minutesAfter}`,
      { headers: buildHeaders(params.apiKey) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getRouteDetails(routeId: string, apiKey?: string): Promise<RouteDetailsResponse> {
    if (isTauriApp()) {
      return await invoke<RouteDetailsResponse>("cmd_get_route", {
        routeId,
        key: apiKey || null,
      });
    }
    const res = await fetch(
      `http://127.0.0.1:8000/api/routes/${encodeURIComponent(routeId)}`,
      { headers: buildHeaders(apiKey) }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getTransitNetwork(apiKey?: string): Promise<TransitNetworkResponse> {
    if (isTauriApp()) {
      return await invoke<TransitNetworkResponse>("cmd_get_network", {
        key: apiKey || null,
      });
    }
    const res = await fetch("http://127.0.0.1:8000/api/network", {
      headers: buildHeaders(apiKey),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getMavTrains(): Promise<MavTrainsResponse> {
    if (isTauriApp()) {
      return await invoke<MavTrainsResponse>("cmd_get_mav_trains");
    }
    const res = await fetch("http://127.0.0.1:8000/api/mav/trains");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getMavTrainDetails(
    elviraId: string,
    trainNumber: string
  ): Promise<MavTrainDetailsResponse> {
    if (isTauriApp()) {
      return await invoke<MavTrainDetailsResponse>("cmd_get_mav_train_details", {
        elviraId,
        trainNumber,
      });
    }
    const res = await fetch(
      `http://127.0.0.1:8000/api/mav/trains/${encodeURIComponent(elviraId)}?train_number=${encodeURIComponent(trainNumber)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getMavTrainComposition(
    elviraId: string,
    trainNumber: string
  ): Promise<VagonwebResponse> {
    if (isTauriApp()) {
      return await invoke<VagonwebResponse>("cmd_get_mav_train_composition", {
        elviraId,
        trainNumber,
      });
    }
    const res = await fetch(
      `http://127.0.0.1:8000/api/mav/trains/${encodeURIComponent(elviraId)}/composition?train_number=${encodeURIComponent(trainNumber)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getMavNetwork(params: {
    swLat: number;
    swLon: number;
    neLat: number;
    neLon: number;
    zoom: number;
  }): Promise<MavNetworkResponse> {
    if (isTauriApp()) {
      return await invoke<MavNetworkResponse>("cmd_get_mav_network", {
        swLat: params.swLat,
        swLon: params.swLon,
        neLat: params.neLat,
        neLon: params.neLon,
        zoom: params.zoom,
      });
    }
    const q = new URLSearchParams({
      sw_lat: params.swLat.toFixed(2),
      sw_lon: params.swLon.toFixed(2),
      ne_lat: params.neLat.toFixed(2),
      ne_lon: params.neLon.toFixed(2),
      zoom: String(params.zoom),
    });
    const res = await fetch(`http://127.0.0.1:8000/api/mav/network?${q}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getMavStations(): Promise<MavStationsResponse> {
    if (isTauriApp()) {
      return await invoke<MavStationsResponse>("cmd_get_mav_stations");
    }
    const res = await fetch("http://127.0.0.1:8000/api/mav/stations");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },

  async getMavStationDetails(stationName: string): Promise<MavStationDetailsResponse> {
    if (isTauriApp()) {
      return await invoke<MavStationDetailsResponse>("cmd_get_mav_station_details", {
        stationName,
      });
    }
    const res = await fetch(
      `http://127.0.0.1:8000/api/mav/stations/${encodeURIComponent(stationName)}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  },
};
