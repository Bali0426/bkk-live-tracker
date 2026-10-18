import time
import math
import asyncio
from typing import Dict, Any, Optional
import httpx
from app.config import settings

class SimpleTTLCache:
    """Egyszerű memóriabeli gyorsítótár a BKK API túlterhelésének elkerülésére."""
    def __init__(self, ttl_seconds: int = 8):
        self.ttl = ttl_seconds
        self._store: Dict[str, tuple[float, Any]] = {}

    def clear(self):
        self._store.clear()

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

    # HÉV színek (H5: lila/magenta, H6: olajzöld, H7: narancs, H8/H9: rózsaszín / hivatalos BKK zöld: #007B3B)
    if "SUBURBAN" in route_type or "RAIL" in route_type or short_name.startswith("H"):
        if bg and text:
            return format_hex_color(bg, "#007B3B"), format_hex_color(text, "#FFFFFF")
        return "#007B3B", "#FFFFFF"

    # Metrók
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

    # Villamosok
    if "TRAM" in route_type:
        return "#FFD800", "#000000"

    # Trolibuszok
    if "TROLLEY" in route_type:
        return "#E41F18", "#FFFFFF"

    # Éjszakai buszok
    if short_name.startswith("9") and len(short_name) == 3:
        return "#1E293B", "#FFFFFF"

    # Ha a BKK adott színt
    if bg and text:
        return format_hex_color(bg, "#009EE3"), format_hex_color(text, "#FFFFFF")

    return "#009EE3", "#FFFFFF"


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

    # A BKK OTP API limit: ha latSpan vagy lonSpan >= 0.095, az API üres választ (0 járművet) ad vissza!
    # Ha a felhasználó kicsinyít a térképen (lat_span vagy lon_span > 0.08),
    # 4 fedő szektort kérdezünk le párhuzamosan a teljes Budapest lefedéséhez.
    if lat_span > 0.08 or lon_span > 0.08:
        query_coords = [
            (47.54, 19.01, 0.085, 0.085),  # Észak-Buda / Óbuda
            (47.54, 19.13, 0.085, 0.085),  # Észak-Pest / Újpest / Zugló
            (47.45, 19.02, 0.085, 0.085),  # Dél-Buda / Kelenföld
            (47.45, 19.14, 0.085, 0.085),  # Dél-Pest / Kőbánya / Kispest
        ]
    else:
        query_coords = [
            (lat, lon, min(lat_span, 0.088), min(lon_span, 0.088))
        ]

    all_raw = []
    async with httpx.AsyncClient(timeout=10.0) as client:
        tasks = [
            client.get(url, params={
                "key": key,
                "lat": q_lat,
                "lon": q_lon,
                "latSpan": q_lat_span,
                "lonSpan": q_lon_span,
                "includeReferences": "routes,trips"
            })
            for q_lat, q_lon, q_lat_span, q_lon_span in query_coords
        ]
        responses = await asyncio.gather(*tasks, return_exceptions=True)
        # Ha 401-et kapunk egyéni kulcsra, azonnal próbáljuk újra a hivatalos 'bkk-web' kulccsal:
        if any(isinstance(resp, httpx.Response) and resp.status_code == 401 for resp in responses) and key != "bkk-web":
            tasks = [
                client.get(url, params={
                    "key": "bkk-web",
                    "lat": q_lat,
                    "lon": q_lon,
                    "latSpan": q_lat_span,
                    "lonSpan": q_lon_span,
                    "includeReferences": "routes,trips"
                })
                for q_lat, q_lon, q_lat_span, q_lon_span in query_coords
            ]
            responses = await asyncio.gather(*tasks, return_exceptions=True)

        for resp in responses:
            if isinstance(resp, httpx.Response) and resp.status_code == 200:
                all_raw.append(resp.json())

    seen_vehicle_ids = set()
    vehicles = []

    for raw in all_raw:
        data = raw.get("data", {})
        list_items = data.get("list", [])
        refs = data.get("references", {})
        routes_map = normalize_references(refs.get("routes"))
        trips_map = normalize_references(refs.get("trips"))

        for v in list_items:
            loc = v.get("location")
            if not loc:
                continue
            v_id = v.get("vehicleId") or f"{loc.get('lat')}_{loc.get('lon')}"
            if v_id in seen_vehicle_ids:
                continue
            seen_vehicle_ids.add(v_id)

            trip = trips_map.get(v.get("tripId"), {})
            route_id = v.get("routeId") or trip.get("routeId")
            route = routes_map.get(route_id, {})

            short_name = route.get("shortName") or v.get("label") or (route_id or "").replace("BKK_", "")
            bg_color, text_color = get_route_colors(route)

            raw_type = str(route.get("type") or v.get("routeType") or "").upper()
            s_name_upper = str(short_name).upper()

            if "SUBURBAN" in raw_type or "RAIL" in raw_type or s_name_upper.startswith("H"):
                norm_type = "RAIL"
            elif "TROLLEY" in raw_type:
                norm_type = "TROLLEYBUS"
            elif "SUBWAY" in raw_type or "METRO" in raw_type or s_name_upper.startswith("M"):
                norm_type = "SUBWAY"
            elif "TRAM" in raw_type:
                norm_type = "TRAM"
            else:
                norm_type = "BUS"

            vehicles.append({
                "vehicleId": v_id,
                "licensePlate": v.get("licensePlate"),
                "lat": loc.get("lat"),
                "lon": loc.get("lon"),
                "bearing": v.get("bearing"),
                "speedKmh": round((v.get("speed") or 0) * 3.6),
                "routeId": route_id,
                "routeShortName": short_name,
                "routeType": norm_type,
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
    cache_key = f"stops_v2:{round(lat, 3)}:{round(lon, 3)}:{round(lat_span, 3)}"
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
    routes_ref = data.get("references", {}).get("routes", {})

    stops = []
    for s in list_items:
        if s.get("lat") and s.get("lon"):
            stop_id = str(s.get("id") or "")
            stop_name = str(s.get("name") or "")
            name_low = stop_name.lower()
            raw_type = str(s.get("type") or "").upper()

            r_types = set()
            r_short_names = []
            for rid in s.get("routeIds", []):
                r_obj = routes_ref.get(rid, {})
                rt = str(r_obj.get("type") or "").upper()
                sn = str(r_obj.get("shortName") or "").upper()
                if rt:
                    r_types.add(rt)
                if sn:
                    r_short_names.append(sn)
            if raw_type:
                r_types.add(raw_type)

            has_hev_route = any(sn in ("H5", "H6", "H7", "H8", "H9") for sn in r_short_names)
            is_mav_station = (
                stop_id.startswith("BKK_0055")
                or "vasútállomás" in name_low
                or "pályaudvar" in name_low
                or ("RAIL" in r_types and not has_hev_route)
            )

            if is_mav_station:
                stop_cat = "MAV"
                stop_color = "#f59e0b"
                stop_label = "Vasútállomás"
            elif "SUBWAY" in r_types:
                stop_cat = "SUBWAY"
                stop_color = "#a855f7"
                stop_label = "Metróállomás"
            elif has_hev_route or "SUBURBAN_RAILWAY" in r_types or "hév" in name_low:
                stop_cat = "HEV"
                stop_color = "#10b981"
                stop_label = "HÉV-állomás"
            elif "TRAM" in r_types:
                stop_cat = "TRAM"
                stop_color = "#eab308"
                stop_label = "Villamosmegálló"
            elif "TROLLEYBUS" in r_types:
                stop_cat = "TROLLEYBUS"
                stop_color = "#ef4444"
                stop_label = "Trolibuszmegálló"
            else:
                stop_cat = "BUS"
                stop_color = "#0ea5e9"
                stop_label = "Buszmegálló"

            is_parent = bool(
                s.get("locationType") == 1
                or s.get("locationSubType") == "stop-area"
                or stop_id.startswith("BKK_CS")
            )
            stops.append({
                "stopId": stop_id,
                "name": stop_name,
                "lat": s.get("lat"),
                "lon": s.get("lon"),
                "direction": s.get("direction", ""),
                "type": raw_type or stop_cat,
                "stopCategory": stop_cat,
                "stopColor": stop_color,
                "stopTypeLabel": stop_label,
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
    # Metrók
    "M1": "BKK_5100",
    "M2": "BKK_5200",
    "M3": "BKK_5300",
    "M4": "BKK_5400",
    # Villamosok
    "1": "BKK_3010",
    "2": "BKK_3020",
    "3": "BKK_3030",
    "4": "BKK_3040",
    "6": "BKK_3060",
    "17": "BKK_3170",
    "19": "BKK_3190",
    "47": "BKK_3470",
    "49": "BKK_3490",
    "56": "BKK_3560",
    # HÉV vonalak
    "H5": "BKK_H5",
    "H6": "BKK_H6",
    "H7": "BKK_H7",
    "H8": "BKK_H8",
    "H9": "BKK_H9",
    # Trolibuszok
    "72": "BKK_4720",
    "73": "BKK_4730",
    "74": "BKK_4740",
    "75": "BKK_4750",
    "76": "BKK_4760",
    "77": "BKK_4770",
    "78": "BKK_4780",
    "79": "BKK_4790",
    "80": "BKK_4800",
    "81": "BKK_4810",
    "82": "BKK_4820",
    "83": "BKK_4830",
    # Főbb autóbuszok
    "7": "BKK_0070",
    "8E": "BKK_0085",
    "9": "BKK_0090",
    "100E": "BKK_1005",
    "200E": "BKK_2005",
    "105": "BKK_1050",
    "133E": "BKK_1335",
}

CORE_NETWORK_ROUTES = [
    # Metrók (SUBWAY)
    ("BKK_5100", "M1"),
    ("BKK_5200", "M2"),
    ("BKK_5300", "M3"),
    ("BKK_5400", "M4"),
    # Villamosok (TRAM)
    ("BKK_3040", "4"),
    ("BKK_3060", "6"),
    ("BKK_3010", "1"),
    ("BKK_3020", "2"),
    ("BKK_3470", "47"),
    ("BKK_3490", "49"),
    # HÉV (RAIL)
    ("BKK_H5", "H5"),
    ("BKK_H6", "H6"),
    ("BKK_H7", "H7"),
    ("BKK_H8", "H8"),
    # Trolibusz (TROLLEYBUS)
    ("BKK_4720", "72"),
    ("BKK_4740", "74"),
    ("BKK_4760", "76"),
    ("BKK_4800", "80"),
    # Főbuszok (BUS)
    ("BKK_0070", "7"),
    ("BKK_0090", "9"),
    ("BKK_1050", "105"),
    ("BKK_1005", "100E"),
]


async def fetch_route_details(route_id: str, api_key: Optional[str] = None) -> Dict[str, Any]:
    """Lekéri egy BKK járat (pl. M3, 4, 72, H5) nyomvonalának koordinátáit és adatait."""
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
    raw_type = str(entry.get("type", "BUS")).upper()
    s_upper = str(short_name).upper()

    if "SUBURBAN" in raw_type or "RAIL" in raw_type or s_upper.startswith("H"):
        norm_type = "RAIL"
    elif "TROLLEY" in raw_type:
        norm_type = "TROLLEYBUS"
    elif "SUBWAY" in raw_type or "METRO" in raw_type or s_upper.startswith("M"):
        norm_type = "SUBWAY"
    elif "TRAM" in raw_type:
        norm_type = "TRAM"
    else:
        norm_type = "BUS"

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
        "type": norm_type,
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

