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
        bg_color = format_hex_color(route.get("color"), "#009EE3")
        text_color = format_hex_color(route.get("textColor"), "#FFFFFF")

        vehicles.append({
            "vehicleId": v.get("vehicleId"),
            "licensePlate": v.get("licensePlate"),
            "lat": loc.get("lat"),
            "lon": loc.get("lon"),
            "bearing": v.get("bearing"),
            "speedKmh": round((v.get("speed") or 0) * 3.6),
            "routeId": route_id,
            "routeShortName": short_name,
            "routeType": route.get("type", "BUS"),
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
        bg_color = format_hex_color(route.get("color"), "#009EE3")
        text_color = format_hex_color(route.get("textColor"), "#FFFFFF")

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
