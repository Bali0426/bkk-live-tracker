from typing import Optional
from fastapi import FastAPI, HTTPException, Header, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.services.futar_client import (
    fetch_vehicles_for_location,
    fetch_stops_for_location,
    fetch_departures_for_stop
)
from app.services.gtfs_rt_client import fetch_gtfs_rt_vehicle_positions

app = FastAPI(
    title="BKK Live Tracker & DIY API",
    description="Saját BKK élő térkép, megállóhelyi kijelző és widget API.",
    version="1.0.0"
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="app/static"), name="static")


def get_key(query_key: Optional[str], header_key: Optional[str]) -> str:
    k = (query_key or header_key or settings.BKK_API_KEY or "").strip()
    if not k or k == "ide_ird_a_bkk_api_kulcsodat":
        return "bkk-web"
    return k


@app.get("/", include_in_schema=False)
async def root():
    return FileResponse("app/static/index.html")


@app.get("/api/status")
async def api_status():
    has_env_key = bool(settings.BKK_API_KEY and settings.BKK_API_KEY != "ide_ird_a_bkk_api_kulcsodat")
    return {
        "status": "ok",
        "hasEnvApiKey": has_env_key,
        "cacheTtlSeconds": settings.CACHE_TTL_SECONDS
    }


@app.get("/api/vehicles")
async def get_vehicles(
    lat: float = Query(47.4979, description="Középpont szélességi fok"),
    lon: float = Query(19.0402, description="Középpont hosszúsági fok"),
    lat_span: float = Query(0.03, description="Látómező magassága fokban"),
    lon_span: float = Query(0.04, description="Látómező szélessége fokban"),
    key: Optional[str] = Query(None, description="Opcionális BKK API kulcs"),
    x_bkk_key: Optional[str] = Header(None)
):
    try:
        api_key = get_key(key, x_bkk_key)
        return await fetch_vehicles_for_location(lat, lon, lat_span, lon_span, api_key)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BKK API hiba: {str(e)}")


@app.get("/api/stops")
async def get_stops(
    lat: float = Query(47.4979),
    lon: float = Query(19.0402),
    lat_span: float = Query(0.015),
    lon_span: float = Query(0.02),
    key: Optional[str] = Query(None),
    x_bkk_key: Optional[str] = Header(None)
):
    try:
        api_key = get_key(key, x_bkk_key)
        return await fetch_stops_for_location(lat, lon, lat_span, lon_span, api_key)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BKK API hiba: {str(e)}")


@app.get("/api/departures/{stop_id}")
async def get_stop_departures(
    stop_id: str,
    limit: int = Query(8, ge=1, le=30),
    minutes_after: int = Query(45, ge=5, le=120),
    key: Optional[str] = Query(None),
    x_bkk_key: Optional[str] = Header(None)
):
    """
    Ideális végpont Android KWGT widgetekhez, HTTP Shortcuts-hoz vagy ESP32 kijelzőkhöz.
    Példa stop_id: BKK_F01046 (Deák Ferenc tér M)
    """
    try:
        api_key = get_key(key, x_bkk_key)
        return await fetch_departures_for_stop(stop_id, limit, minutes_after, api_key)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"BKK API hiba: {str(e)}")


@app.get("/api/gtfs-rt/vehicles")
async def get_gtfs_rt_vehicles(
    limit: int = Query(100, ge=1, le=1000),
    key: Optional[str] = Query(None),
    x_bkk_key: Optional[str] = Header(None)
):
    """Bináris GTFS-Realtime Protobuf feed dekódolása JSON-re."""
    try:
        api_key = get_key(key, x_bkk_key)
        return await fetch_gtfs_rt_vehicle_positions(api_key, limit)
    except ValueError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"GTFS-RT hiba: {str(e)}")
