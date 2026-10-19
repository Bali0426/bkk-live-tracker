/**
 * BKK & MÁV Live Tracker – TypeScript Típusdefiníciók (Tauri v2 + TS)
 */

export interface ApiStatusResponse {
  status: string;
  hasEnvApiKey: boolean;
  cacheTtlSeconds: number;
}

export interface BkkVehicle {
  vehicleId: string;
  licensePlate?: string | null;
  label?: string | null;
  model?: string | null;
  lat: number;
  lon: number;
  bearing?: number | null;
  speed?: number | null;
  routeId?: string | null;
  routeShortName: string;
  routeType: string;
  color: string;
  textColor: string;
  headsign?: string;
  status?: string | null;
  stopId?: string | null;
  stopDistancePercent?: number | null;
  lastUpdateTime?: number | null;
  wheelchairAccessible?: boolean;
  lowFloor?: boolean;
  airConditioned?: boolean;
  tripId?: string | null;
}

export interface BkkVehiclesResponse {
  count: number;
  vehicles: BkkVehicle[];
}

export interface BkkStopRoute {
  routeId: string;
  shortName: string;
  type: string;
  color: string;
  textColor: string;
}

export interface BkkStop {
  stopId: string;
  name: string;
  lat: number;
  lon: number;
  direction?: string | null;
  platformCode?: string | null;
  type: string;
  color: string;
  wheelchairBoarding?: boolean;
  routes: BkkStopRoute[];
}

export interface BkkStopsResponse {
  count: number;
  stops: BkkStop[];
}

export interface BkkDeparture {
  routeId: string;
  routeShortName: string;
  routeType: string;
  color: string;
  textColor: string;
  headsign: string;
  scheduledEpoch: number;
  predictedEpoch: number;
  isRealtime: boolean;
  minutesUntil: number;
  displayText: string;
  wheelchairAccessible: boolean;
  alertCount?: number;
}

export interface BkkDeparturesResponse {
  stopId: string;
  stopName: string;
  lat?: number | null;
  lon?: number | null;
  currentTime: number;
  count: number;
  departures: BkkDeparture[];
  alerts: string[];
}

export interface RouteDetailsResponse {
  routeId: string;
  shortName: string;
  type: string;
  color: string;
  textColor: string;
  description?: string;
  polylines: [number, number][][];
}

export interface TransitNetworkLine {
  routeId: string;
  shortName: string;
  type: string;
  color: string;
  polylines: [number, number][][];
}

export interface TransitNetworkResponse {
  count: number;
  lines: TransitNetworkLine[];
}

export interface MavTrain {
  trainId: string;
  elviraId: string;
  trainNumber: string;
  routeShortName: string;
  trainName?: string;
  trainCategory: string;
  relation: string;
  lat: number;
  lon: number;
  speed?: number | null;
  bearing?: number | null;
  delayMinutes: number;
  color: string;
  textColor: string;
}

export interface MavTrainsResponse {
  count: number;
  trains: MavTrain[];
}

export interface MavTrainDetailsResponse {
  elviraId: string;
  html: string;
  polyline: [number, number][];
}

export interface MavNetworkElement {
  type: "way" | "node";
  id?: number;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  tags?: Record<string, string>;
}

export interface MavNetworkResponse {
  elements?: MavNetworkElement[];
}

export interface MavStation {
  name: string;
  lat: number;
  lon: number;
  importance?: number;
}

export interface MavStationsResponse {
  count: number;
  stations: MavStation[];
}

export interface MavStationDetailsResponse {
  stationName: string;
  html: string;
}

export interface VagonwebCar {
  num: string;
  cls: string;
  operator: string;
  model: string;
  route: string;
  img?: string | null;
}

export interface VagonwebComposition {
  id: string;
  title: string;
  isActual: boolean;
  cars: VagonwebCar[];
}

export interface VagonwebResponse {
  found: boolean;
  trainNumber: string;
  title?: string;
  relation?: string;
  url?: string;
  hasActual?: boolean;
  hasPlanned?: boolean;
  compositions?: VagonwebComposition[];
  cars?: VagonwebCar[];
}

export interface SearchIndexItem {
  id: string;
  name: string;
  type: "MAV" | "BKK" | "BKK_DYNAMIC";
  subType: string;
  lat: number;
  lon: number;
  routes: string[];
  color?: string;
}
