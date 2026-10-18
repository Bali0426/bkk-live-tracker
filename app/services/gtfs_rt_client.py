from typing import Dict, Any, Optional
import httpx
from google.transit import gtfs_realtime_pb2
from app.config import settings
from app.services.futar_client import resolve_api_key, cache


async def fetch_gtfs_rt_vehicle_positions(
    api_key: Optional[str] = None,
    limit: int = 200
) -> Dict[str, Any]:
    """
    Letölti és dekódolja a BKK bináris GTFS-Realtime (VehiclePositions.pb) feedjét.
    Hasznos, ha az egész várost egyszerre szeretnéd elemezni.
    """
    key = resolve_api_key(api_key)
    cache_key = f"gtfs_rt_vehicles:{limit}"
    cached = cache.get(cache_key)
    if cached:
        return cached

    url = f"{settings.GTFS_RT_BASE_URL}/VehiclePositions.pb"
    params = {"key": key}

    async with httpx.AsyncClient(timeout=12.0) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        raw_bytes = resp.content

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(raw_bytes)

    vehicles = []
    for entity in feed.entity[:limit]:
        if entity.HasField("vehicle"):
            v = entity.vehicle
            pos = v.position
            trip = v.trip
            veh_desc = v.vehicle
            vehicles.append({
                "entityId": entity.id,
                "vehicleId": veh_desc.id if veh_desc else "",
                "label": veh_desc.label if veh_desc else "",
                "licensePlate": veh_desc.license_plate if veh_desc else "",
                "routeId": trip.route_id if trip else "",
                "tripId": trip.trip_id if trip else "",
                "lat": round(pos.latitude, 6) if pos else None,
                "lon": round(pos.longitude, 6) if pos else None,
                "bearing": round(pos.bearing, 1) if pos else None,
                "speedKmh": round((pos.speed or 0) * 3.6) if pos else 0,
                "timestamp": v.timestamp
            })

    result = {
        "feedTimestamp": feed.header.timestamp,
        "totalEntitiesInFeed": len(feed.entity),
        "returnedCount": len(vehicles),
        "vehicles": vehicles
    }
    cache.set(cache_key, result)
    return result
