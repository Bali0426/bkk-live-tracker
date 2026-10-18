import time
import math
from typing import Dict, Any, Optional
import httpx
from app.config import settings

class SimpleTTLCache:
    """Egyszerű memóriabeli gyorsítótár a BKK API túlterhelésének elkerülésére."""
    def __init__(self, ttl_seconds: int = 8):
        self.ttl = ttl_seconds
        self._store: Dict[str, tuple[float, Any]] = {}

    def get(self, key: str) -> Optional[Any]:
        if key in self._store:
            ts, val = self._store[key]
            if time.time() - ts < self.ttl:
                return val
            del self._store[key]
        return None

    def set(self, key: str, value: Any):
        self._store[key] = (time.time(), value)

cache = SimpleTTLCache(ttl_seconds=settings.CACHE_TTL_SECONDS)


def normalize_references(ref_obj: Any) -> Dict[str, Any]:
    """BKK OTP API references szótárak és listák normalizálása id -> obj leképezésre."""
    if isinstance(ref_obj, dict):
        return ref_obj
    elif isinstance(ref_obj, list):
        return {item["id"]: item for item in ref_obj if isinstance(item, dict) and "id" in item}
    return {}


def format_hex_color(col: Optional[str], default: str) -> str:
    """Biztosítja a helyes CSS #RRGGBB színkódot."""
    if not col:
        return default
    col = str(col).strip()
    return col if col.startswith("#") else f"#{col}"


def get_route_colors(route: Dict[str, Any]) -> tuple[str, str]:
    """Hivatalos BKK színek és kontrasztos betűszínek feloldása járatokra és típusokra."""
    short_name = str(route.get("shortName") or "").strip().upper()
    route_type = str(route.get("type") or "").upper()
    bg = route.get("color")
    text = route.get("textColor")

    if bg and text:
        return format_hex_color(bg, "#009EE3"), format_hex_color(text, "#FFFFFF")

    # Hivatalos BKK alapszínek feloldása:
    if "SUBWAY" in route_type or short_name.startswith("M"):
        if "1" in short_name:
            return "#FFD800", "#000000"
        elif "2" in short_name:
            return "#E41F18", "#FFFFFF"
        elif "3" in short_name:
            return "#005CA5", "#FFFFFF"
        elif "4" in short_name:
            return "#4CA22F", "#FFFFFF"
        return "#005CA5", "#FFFFFF"
    elif "TRAM" in route_type:
        return "#FFD800", "#000000"
    elif "TROLLEY" in route_type:
        return "#E41F18", "#FFFFFF"
    elif "RAIL" in route_type or "SUBURBAN" in route_type or short_name.startswith("H"):
        if short_name.startswith("H"):
            return "#007B3B", "#FFFFFF"
        return "#2E5EA8", "#FFFFFF"
    elif short_name.startswith("9"):
        return "#1E293B", "#FFFFFF"

    return format_hex_color(bg, "#009EE3"), format_hex_color(text, "#FFFFFF")


def decode_polyline(polyline_str: str) -> list[tuple[float, float]]:
    """Google encoded polyline sztring dekódolása (lat, lon) pontokká."""
    index, lat, lng = 0, 0, 0
    coordinates = []
    length = len(polyline_str)
    while index < length:
        b, shift, result = 0, 0, 0
        while True:
            b = ord(polyline_str[index]) - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        dlat = ~(result >> 1) if (result & 1) else (result >> 1)
        lat += dlat
        shift, result = 0, 0
        while True:
            b = ord(polyline_str[index]) - 63
            index += 1
            result |= (b & 0x1f) << shift
            shift += 5
            if b < 0x20:
                break
        dlng = ~(result >> 1) if (result & 1) else (result >> 1)
        lng += dlng
        coordinates.append((round(lat * 1e-5, 6), round(lng * 1e-5, 6)))
    return coordinates


def resolve_api_key(override_key: Optional[str] = None) -> str:
    key = (override_key or settings.BKK_API_KEY or "").strip()
    if not key or key == "ide_ird_a_bkk_api_kulcsodat":
        key = "bkk-web"
    return key


async def fetch_vehicles_for_location(
    lat: float,
    lon: float,
    lat_span: float = 0.03,
    lon_span: float = 0.04,
    api_key: Optional[str] = None
) -> Dict[str, Any]:
    key = resolve_api_key(api_key)
    cache_key = f"vehicles:{round(lat, 3)}:{round(lon, 3)}:{round(lat_span, 3)}:{round(lon_span, 3)}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    url = f"{settings.FUTAR_BASE_URL}/vehicles-for-location.json"
    params = {
        "key": key,
        "lat": lat,
        "lon": lon,
        "latSpan": lat_span,
        "lonSpan": lon_span,
        "includeReferences": "routes,trips"
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json()

    data = raw.get("data", {})
    list_items = data.get("list", [])
    refs = data.get("references", {})
    routes_map = normalize_references(refs.get("routes"))
    trips_map = normalize_references(refs.get("trips"))

    vehicles = []
    for v in list_items:
        loc = v.get("location")
        if not loc:
            continue
        trip = trips_map.get(v.get("tripId"), {})
        route_id = v.get("routeId") or trip.get("routeId")
        route = routes_map.get(route_id, {})

        short_name = route.get("shortName") or v.get("label") or (route_id or "").replace("BKK_", "")
        bg_color, text_color = get_route_colors(route)
        route_type = route.get("type") or v.get("routeType") or "BUS"

        vehicles.append({
            "vehicleId": v.get("vehicleId"),
            "licensePlate": v.get("licensePlate"),
            "lat": loc.get("lat"),
            "lon": loc.get("lon"),
            "bearing": v.get("bearing"),
            "speedKmh": round((v.get("speed") or 0) * 3.6),
            "routeId": route_id,
            "routeShortName": short_name,
            "routeType": route_type,
            "color": bg_color,
            "textColor": text_color,
            "headsign": trip.get("tripHeadsign") or v.get("label") or "",
            "model": v.get("model", ""),
            "status": v.get("status", "")
        })

    result = {
        "count": len(vehicles),
        "timestamp": int(time.time()),
        "vehicles": vehicles
    }
    cache.set(cache_key, result)
    return result


async def fetch_stops_for_location(
    lat: float,
    lon: float,
    lat_span: float = 0.015,
    lon_span: float = 0.02,
    api_key: Optional[str] = None
) -> Dict[str, Any]:
    key = resolve_api_key(api_key)
    cache_key = f"stops:{round(lat, 3)}:{round(lon, 3)}:{round(lat_span, 3)}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    url = f"{settings.FUTAR_BASE_URL}/stops-for-location.json"
    params = {
        "key": key,
        "lat": lat,
        "lon": lon,
        "latSpan": lat_span,
        "lonSpan": lon_span
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json()

    data = raw.get("data", {})
    list_items = data.get("list", [])

    stops = []
    for s in list_items:
        if s.get("lat") and s.get("lon"):
            is_parent = bool(
                s.get("locationType") == 1
                or s.get("locationSubType") == "stop-area"
                or (s.get("id") or "").startswith("BKK_CS")
            )
            stops.append({
                "stopId": s.get("id"),
                "name": s.get("name"),
                "lat": s.get("lat"),
                "lon": s.get("lon"),
                "direction": s.get("direction", ""),
                "type": s.get("type", ""),
                "locationType": s.get("locationType", 0),
                "locationSubType": s.get("locationSubType", ""),
                "parentStationId": s.get("parentStationId", ""),
                "isStopArea": is_parent
            })

    result = {"count": len(stops), "stops": stops}
    cache.set(cache_key, result)
    return result


async def fetch_departures_for_stop(
    stop_id: str,
    limit: int = 10,
    minutes_after: int = 45,
    api_key: Optional[str] = None
) -> Dict[str, Any]:
    key = resolve_api_key(api_key)
    cache_key = f"departures:{stop_id}:{limit}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    url = f"{settings.FUTAR_BASE_URL}/arrivals-and-departures-for-stop.json"
    params = {
        "key": key,
        "stopId": stop_id,
        "onlyDepartures": "true",
        "limit": limit,
        "minutesAfter": minutes_after,
        "includeReferences": "routes,trips,stops"
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json()

    data = raw.get("data", {})
    entry = data.get("entry", {})
    refs = data.get("references", {})

    stops_map = normalize_references(refs.get("stops"))
    routes_map = normalize_references(refs.get("routes"))
    trips_map = normalize_references(refs.get("trips"))

    stop_info = stops_map.get(stop_id) or (list(stops_map.values())[0] if stops_map else {"id": stop_id, "name": stop_id})
    now_sec = time.time()

    departures = []
    for st in entry.get("stopTimes", []):
        trip = trips_map.get(st.get("tripId"), {})
        route_id = trip.get("routeId") or st.get("routeId")
        route = routes_map.get(route_id, {})

        sched_time = st.get("departureTime") or st.get("arrivalTime")
        pred_time = st.get("predictedDepartureTime") or st.get("predictedArrivalTime")
        effective_time = pred_time or sched_time

        if not effective_time:
            continue

        # Ha ezredmásodpercben érkezne, osztjuk 1000-rel
        if effective_time > 1e11:
            effective_time = effective_time / 1000.0

        diff_min = max(0, math.floor((effective_time - now_sec) / 60))

        short_name = route.get("shortName") or (route_id or "").replace("BKK_", "")
        bg_color, text_color = get_route_colors(route)

        departures.append({
            "routeShortName": short_name,
            "headsign": st.get("stopHeadsign") or trip.get("tripHeadsign") or "",
            "minutesUntil": diff_min,
            "displayTime": "MOST" if diff_min == 0 else f"{diff_min}'",
            "isRealtime": pred_time is not None,
            "epochTime": int(effective_time),
            "color": bg_color,
            "textColor": text_color
        })

    departures.sort(key=lambda x: x["epochTime"])

    result = {
        "stopId": stop_id,
        "stopName": stop_info.get("name", stop_id),
        "timestamp": int(now_sec),
        "departures": departures[:limit]
    }
    cache.set(cache_key, result)
    return result


COMMON_ROUTE_MAP = {
    "M1": "BKK_5100",
    "M2": "BKK_5200",
    "M3": "BKK_5300",
    "M4": "BKK_5400",
    "1": "BKK_3010",
    "2": "BKK_3020",
    "4": "BKK_3040",
    "6": "BKK_3060",
    "47": "BKK_3470",
    "49": "BKK_3490",
}

CORE_NETWORK_ROUTES = [
    ("BKK_5100", "M1"),
    ("BKK_5200", "M2"),
    ("BKK_5300", "M3"),
    ("BKK_5400", "M4"),
    ("BKK_3040", "4"),
    ("BKK_3060", "6"),
    ("BKK_3010", "1"),
    ("BKK_3020", "2"),
    ("BKK_3470", "47"),
    ("BKK_3490", "49"),
]


async def fetch_route_details(route_id: str, api_key: Optional[str] = None) -> Dict[str, Any]:
    """Lekéri egy BKK járat (pl. M3, 4-es villamos) nyomvonalának koordinátáit és adatait."""
    key = resolve_api_key(api_key)
    clean_id = route_id.strip()
    target_id = COMMON_ROUTE_MAP.get(clean_id.upper(), clean_id)
    if not target_id.startswith("BKK_"):
        target_id = f"BKK_{target_id}"

    cache_key = f"route_details:{target_id}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    url = f"{settings.FUTAR_BASE_URL}/route-details.json"
    params = {
        "key": key,
        "routeId": target_id,
        "includePolyline": "true"
    }

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        raw = resp.json()

    entry = raw.get("data", {}).get("entry", {})
    short_name = entry.get("shortName") or clean_id
    route_type = entry.get("type", "BUS")
    bg_color, text_color = get_route_colors(entry)

    variants = entry.get("variants", [])
    polylines = []
    for var in variants:
        poly_str = var.get("polyline", {}).get("points")
        if poly_str:
            coords = decode_polyline(poly_str)
            if coords:
                polylines.append({
                    "name": var.get("name", ""),
                    "headsign": var.get("headsign", ""),
                    "direction": var.get("direction", ""),
                    "coordinates": coords
                })

    result = {
        "routeId": target_id,
        "shortName": short_name,
        "description": entry.get("description", ""),
        "type": route_type,
        "color": bg_color,
        "textColor": text_color,
        "polylines": polylines
    }
    cache.set(cache_key, result)
    return result


async def fetch_transit_network(api_key: Optional[str] = None) -> Dict[str, Any]:
    """Budapest törzshálózatának (M1, M2, M3, M4 metrók és 1, 2, 4, 6, 47, 49 villamosok) nyomvonalai."""
    cache_key = "core_transit_network"
    cached = cache.get(cache_key)
    if cached:
        return cached

    routes = []
    for rid, _ in CORE_NETWORK_ROUTES:
        try:
            r_data = await fetch_route_details(rid, api_key)
            if r_data.get("polylines"):
                routes.append(r_data)
        except Exception:
            continue

    result = {
        "count": len(routes),
        "routes": routes
    }
    cache.set(cache_key, result)
    return result

