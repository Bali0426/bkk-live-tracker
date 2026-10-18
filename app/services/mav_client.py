import time
import json
import re
from typing import Dict, Any, List, Optional
import httpx
from app.services.futar_client import decode_polyline, SimpleTTLCache

mav_cache = SimpleTTLCache(ttl_seconds=8)
mav_train_details_cache = SimpleTTLCache(ttl_seconds=30)
mav_lines_cache = SimpleTTLCache(ttl_seconds=300)
mav_station_cache = SimpleTTLCache(ttl_seconds=45)

VONATINFO_URL = "https://vonatinfo.mav.hu/map.aspx/getData"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Content-Type": "application/json; charset=utf-8",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Origin": "https://vonatinfo.mav.hu",
    "Referer": "https://vonatinfo.mav.hu/"
}


async def fetch_mav_trains() -> Dict[str, Any]:
    """Lekéri az összes magyarországi MÁV és GYSEV vonat élő GPS pozícióját és késését."""
    cache_key = "mav_trains"
    cached = mav_cache.get(cache_key)
    if cached:
        return cached

    payload = {"a": "TRAINS", "jo": {"history": False, "id": False}}

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        resp = await client.post(VONATINFO_URL, json=payload, headers=HEADERS)
        resp.raise_for_status()
        raw = resp.json()

    val = raw.get("d", {})
    if isinstance(val, str):
        val = json.loads(val)

    trains_raw = val.get("result", {}).get("Trains", {}).get("Train", [])
    if isinstance(trains_raw, dict):
        trains_raw = [trains_raw]

    trains: List[Dict[str, Any]] = []
    total_delay = 0

    for t in trains_raw:
        try:
            lat = float(t.get("@Lat", 0))
            lon = float(t.get("@Lon", 0))
            if not lat or not lon:
                continue

            delay = int(t.get("@Delay", 0))
            total_delay += max(0, delay)
            train_num = str(t.get("@TrainNumber") or "")
            relation = str(t.get("@Relation") or "")
            elvira_id = str(t.get("@ElviraID") or "")
            menetvonal = str(t.get("@Menetvonal") or "MAV")

            # Késési kategória és színkód
            if delay <= 0:
                cat = "on_time"
                color = "#10b981"  # Zöld - pontos
                text_color = "#FFFFFF"
                status_desc = "Pontos"
            elif delay < 10:
                cat = "minor"
                color = "#eab308"  # Sárga - enyhe késés (<10p)
                text_color = "#0f172a"
                status_desc = f"+{delay} perc"
            else:
                cat = "major"
                color = "#ef4444"  # Piros - jelentős késés (10+ perc)
                text_color = "#FFFFFF"
                status_desc = f"+{delay} perc"

            # Típus (IC, S, Z, G, Ex, EC, stb.)
            is_ic = "IC" in train_num or "EuroCity" in relation or "EC" in train_num or "Railjet" in relation
            is_suburban = train_num.startswith("S") or train_num.startswith("Z") or train_num.startswith("G")

            trains.append({
                "trainNumber": train_num,
                "relation": relation,
                "delay": delay,
                "lat": lat,
                "lon": lon,
                "elviraId": elvira_id,
                "menetvonal": menetvonal,
                "category": cat,
                "color": color,
                "textColor": text_color,
                "statusText": status_desc,
                "isIC": is_ic,
                "isSuburban": is_suburban
            })
        except Exception:
            continue

    avg_delay = round(total_delay / max(1, len(trains)), 1)

    result = {
        "count": len(trains),
        "avgDelay": avg_delay,
        "timestamp": int(time.time()),
        "trains": trains
    }
    mav_cache.set(cache_key, result)
    return result


async def fetch_mav_train_details(elvira_id: str, train_number: Optional[str] = None) -> Dict[str, Any]:
    """Lekéri egy adott MÁV vonat menetrendjét (állomások, peronok, idők) és nyomvonalát."""
    cache_key = f"mav_train:{elvira_id}:{train_number}"
    cached = mav_train_details_cache.get(cache_key)
    if cached:
        return cached

    payload = {
        "a": "TRAIN",
        "jo": {
            "v": elvira_id,
            "vsz": train_number or "",
            "zoom": False,
            "csakkozlekedovonat": True
        }
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        resp = await client.post(VONATINFO_URL, json=payload, headers=HEADERS)
        resp.raise_for_status()
        raw = resp.json()

    val = raw.get("d", {})
    if isinstance(val, str):
        val = json.loads(val)

    res = val.get("result", {})
    html_timetable = res.get("html", "")
    line_segments = res.get("line", [])

    polylines = []
    for seg in line_segments:
        pts = seg.get("points")
        if pts:
            coords = decode_polyline(pts)
            if coords:
                polylines.append({
                    "info": seg.get("info", "vonat"),
                    "coordinates": coords
                })

    result = {
        "elviraId": elvira_id,
        "trainNumber": train_number or "",
        "html": html_timetable,
        "polylines": polylines
    }
    mav_train_details_cache.set(cache_key, result)
    return result


async def fetch_mav_network(
    sw_lat: float = 45.7,
    sw_lon: float = 16.1,
    ne_lat: float = 48.6,
    ne_lon: float = 22.9,
    zoom: int = 10
) -> Dict[str, Any]:
    """Lekéri a magyarországi vasúti vágányhálózat geometriáját a térképre."""
    cache_key = f"mav_network:{round(sw_lat, 2)}:{round(sw_lon, 2)}:{round(ne_lat, 2)}:{round(ne_lon, 2)}:{zoom}"
    cached = mav_lines_cache.get(cache_key)
    if cached:
        return cached

    payload = {
        "a": "LINE",
        "jo": {
            "sw": [sw_lat, sw_lon],
            "ne": [ne_lat, ne_lon],
            "id": "bg",
            "zoom": zoom
        }
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        resp = await client.post(VONATINFO_URL, json=payload, headers=HEADERS)
        resp.raise_for_status()
        raw = resp.json()

    val = raw.get("d", {})
    if isinstance(val, str):
        val = json.loads(val)

    lines_raw = val.get("result", {}).get("lines", [])
    polylines = []

    for item in lines_raw:
        pts = item.get("points")
        if pts:
            coords = decode_polyline(pts)
            if coords:
                polylines.append({
                    "lineNum": item.get("linenum", ""),
                    "coordinates": coords
                })

    result = {
        "count": len(polylines),
        "lines": polylines
    }
    mav_lines_cache.set(cache_key, result)
    return result


MAJOR_STATIONS: List[Dict[str, Any]] = [
    # Budapest Főpályaudvarok és csomópontok
    {"id": "bp-keleti", "name": "Budapest-Keleti", "shortName": "Keleti pu.", "lat": 47.5002, "lon": 19.0838, "isMajor": True, "city": "Budapest"},
    {"id": "bp-nyugati", "name": "Budapest-Nyugati", "shortName": "Nyugati pu.", "lat": 47.5108, "lon": 19.0575, "isMajor": True, "city": "Budapest"},
    {"id": "bp-deli", "name": "Budapest-Déli", "shortName": "Déli pu.", "lat": 47.4998, "lon": 19.0253, "isMajor": True, "city": "Budapest"},
    {"id": "kelenfold", "name": "Kelenföld", "shortName": "Kelenföld", "lat": 47.4646, "lon": 19.0215, "isMajor": True, "city": "Budapest"},
    {"id": "kobanya-kispest", "name": "Kőbánya-Kispest", "shortName": "Kőbánya-Kispest", "lat": 47.4639, "lon": 19.1489, "isMajor": True, "city": "Budapest"},
    {"id": "zuglo", "name": "Zugló", "shortName": "Zugló", "lat": 47.5132, "lon": 19.0984, "isMajor": False, "city": "Budapest"},
    {"id": "ferencvaros", "name": "Ferencváros", "shortName": "Ferencváros", "lat": 47.4678, "lon": 19.0898, "isMajor": False, "city": "Budapest"},
    {"id": "rakos", "name": "Rákos", "shortName": "Rákos", "lat": 47.4983, "lon": 19.1558, "isMajor": False, "city": "Budapest"},
    {"id": "ujpest", "name": "Újpest", "shortName": "Újpest", "lat": 47.5619, "lon": 19.0886, "isMajor": False, "city": "Budapest"},
    
    # Vármegyeszékhelyek és nagyobb vasúti csomópontok
    {"id": "debrecen", "name": "Debrecen", "shortName": "Debrecen", "lat": 47.5208, "lon": 21.6261, "isMajor": True, "city": "Debrecen"},
    {"id": "gyor", "name": "Győr", "shortName": "Győr", "lat": 47.6833, "lon": 17.6350, "isMajor": True, "city": "Győr"},
    {"id": "szeged", "name": "Szeged", "shortName": "Szeged", "lat": 46.2410, "lon": 20.1432, "isMajor": True, "city": "Szeged"},
    {"id": "miskolc-tiszai", "name": "Miskolc-Tiszai", "shortName": "Miskolc-Tiszai", "lat": 48.1008, "lon": 20.8065, "isMajor": True, "city": "Miskolc"},
    {"id": "pecs", "name": "Pécs", "shortName": "Pécs", "lat": 46.0683, "lon": 18.2325, "isMajor": True, "city": "Pécs"},
    {"id": "szekesfehervar", "name": "Székesfehérvár", "shortName": "Székesfehérvár", "lat": 47.1812, "lon": 18.4239, "isMajor": True, "city": "Székesfehérvár"},
    {"id": "szolnok", "name": "Szolnok", "shortName": "Szolnok", "lat": 47.1683, "lon": 20.1783, "isMajor": True, "city": "Szolnok"},
    {"id": "nyiregyhaza", "name": "Nyíregyháza", "shortName": "Nyíregyháza", "lat": 47.9506, "lon": 21.7139, "isMajor": True, "city": "Nyíregyháza"},
    {"id": "kecskemet", "name": "Kecskemét", "shortName": "Kecskemét", "lat": 46.9103, "lon": 19.6978, "isMajor": True, "city": "Kecskemét"},
    {"id": "bekescsaba", "name": "Békéscsaba", "shortName": "Békéscsaba", "lat": 46.6739, "lon": 21.0825, "isMajor": True, "city": "Békéscsaba"},
    {"id": "szombathely", "name": "Szombathely", "shortName": "Szombathely", "lat": 47.2372, "lon": 16.6358, "isMajor": True, "city": "Szombathely"},
    {"id": "veszprem", "name": "Veszprém", "shortName": "Veszprém", "lat": 47.1158, "lon": 17.9150, "isMajor": True, "city": "Veszprém"},
    {"id": "zalaegerszeg", "name": "Zalaegerszeg", "shortName": "Zalaegerszeg", "lat": 46.8375, "lon": 16.8522, "isMajor": True, "city": "Zalaegerszeg"},
    {"id": "eger", "name": "Eger", "shortName": "Eger", "lat": 47.8931, "lon": 20.3739, "isMajor": True, "city": "Eger"},
    {"id": "kaposvar", "name": "Kaposvár", "shortName": "Kaposvár", "lat": 46.3533, "lon": 17.7942, "isMajor": True, "city": "Kaposvár"},
    {"id": "tatabanya", "name": "Tatabánya", "shortName": "Tatabánya", "lat": 47.5847, "lon": 18.3986, "isMajor": True, "city": "Tatabánya"},
    {"id": "sopron", "name": "Sopron", "shortName": "Sopron", "lat": 47.6767, "lon": 16.5886, "isMajor": True, "city": "Sopron"},
    {"id": "cegled", "name": "Cegléd", "shortName": "Cegléd", "lat": 47.1781, "lon": 19.7892, "isMajor": False, "city": "Cegléd"},
    {"id": "vac", "name": "Vác", "shortName": "Vác", "lat": 47.7817, "lon": 19.1367, "isMajor": False, "city": "Vác"},
    {"id": "hatvan", "name": "Hatvan", "shortName": "Hatvan", "lat": 47.6631, "lon": 19.6742, "isMajor": False, "city": "Hatvan"},
    {"id": "fuzesabony", "name": "Füzesabony", "shortName": "Füzesabony", "lat": 47.7478, "lon": 20.4194, "isMajor": False, "city": "Füzesabony"},
    {"id": "siofok", "name": "Siófok", "shortName": "Siófok", "lat": 46.9069, "lon": 18.0531, "isMajor": True, "city": "Siófok"},
    {"id": "balatonfured", "name": "Balatonfüred", "shortName": "Balatonfüred", "lat": 46.9589, "lon": 17.8822, "isMajor": False, "city": "Balatonfüred"},
    {"id": "fonyod", "name": "Fonyód", "shortName": "Fonyód", "lat": 46.7456, "lon": 17.5539, "isMajor": False, "city": "Fonyód"},
    {"id": "keszthely", "name": "Keszthely", "shortName": "Keszthely", "lat": 46.7583, "lon": 17.2472, "isMajor": False, "city": "Keszthely"},
    {"id": "nagykanizsa", "name": "Nagykanizsa", "shortName": "Nagykanizsa", "lat": 46.4447, "lon": 16.9944, "isMajor": False, "city": "Nagykanizsa"},
    {"id": "dombovar", "name": "Dombóvár", "shortName": "Dombóvár", "lat": 46.3719, "lon": 18.1406, "isMajor": False, "city": "Dombóvár"},
    {"id": "komarom", "name": "Komárom", "shortName": "Komárom", "lat": 47.7458, "lon": 18.1189, "isMajor": False, "city": "Komárom"},
    {"id": "esztergom", "name": "Esztergom", "shortName": "Esztergom", "lat": 47.7775, "lon": 18.7408, "isMajor": False, "city": "Esztergom"},
    {"id": "hegyeshalom", "name": "Hegyeshalom", "shortName": "Hegyeshalom", "lat": 47.9133, "lon": 17.1528, "isMajor": False, "city": "Hegyeshalom"},
    {"id": "zahony", "name": "Záhony", "shortName": "Záhony", "lat": 48.4069, "lon": 22.1811, "isMajor": False, "city": "Záhony"},
]


def fetch_mav_stations() -> List[Dict[str, Any]]:
    """Visszaadja a főbb magyarországi vasútállomások listáját és koordinátáit."""
    return MAJOR_STATIONS


async def fetch_mav_station_details(station_name: str) -> Dict[str, Any]:
    """Lekéri egy adott vasútállomás (pl. Budapest-Keleti, Debrecen) élő menetrendjét és vágánykijelzőjét."""
    cache_key = f"mav_station:{station_name}"
    cached = mav_station_cache.get(cache_key)
    if cached:
        return cached

    payload = {
        "a": "STATION",
        "jo": {
            "a": station_name
        }
    }

    async with httpx.AsyncClient(timeout=10.0, follow_redirects=True) as client:
        resp = await client.post(VONATINFO_URL, json=payload, headers=HEADERS)
        resp.raise_for_status()
        raw = resp.json()

    val = raw.get("d", {})
    if isinstance(val, str):
        val = json.loads(val)

    html = val.get("result", "")
    if not isinstance(html, str):
        html = str(html)

    # Elvira onclick hívások átalakítása úgy, hogy a webes alkalmazás saját loadMavTrainDetails függvényét hívja meg
    html = re.sub(
        r"map\.getData\('TRAIN',\s*\{\s*v:\s*'([^']+)'(?:,\s*[^}]*)?\}\s*\)",
        r"loadMavTrainDetails('\1', '')",
        html
    )

    result = {
        "station": station_name,
        "html": html,
        "timestamp": int(time.time())
    }
    mav_station_cache.set(cache_key, result)
    return result

