# BKK Live Tracker – Projekt Kontextus (Antigravity / AI Agent számára)

## Projekt célja
Saját felhasználású, alacsony erőforrás-igényű Python (FastAPI) alapú alkalmazás a BKK OpenData (FUTÁR REST API és GTFS-Realtime Protobuf) adatainak megjelenítésére:
1. **Webes élő térkép** (Leaflet.js) járműpozíciókkal és megállóhelyi FUTÁR indulási kijelzővel.
2. **Egyszerűsített JSON végpontok** Android widgetekhez (KWGT, HTTP Shortcuts) és DIY mikrokontrolleres (ESP32) projektekhez.

## Architektúra
- `app/config.py`: Környezeti változók (`.env`) és BKK végpont URL-ek kezelése.
- `app/services/futar_client.py`: Aszinkron HTTP kliens (`httpx`) rövid idejű memóriabeli (TTL) gyorsítótárazással a BKK API kvóta védelmére.
- `app/services/gtfs_rt_client.py`: Bináris Protocol Buffers (`VehiclePositions.pb`, `TripUpdates.pb`, `Alerts.pb`) letöltése és dekódolása.
- `app/main.py`: FastAPI szerver, REST API végpontok és statikus fájlok kiszolgálása.
- `app/static/`: Frontend (HTML5, CSS3, Vanilla JS + Leaflet).

## BKK API Szabályok és Konvenciók
- Lekérdezési gyakoriság: A BKK adatai ~10 másodpercenként frissülnek. A backend TTL cache megakadályozza a túl gyakori hívásokat.
- Járatazonosítók (`routeId`): `BKK_0040` (4-es villamos), `BKK_5100` (M1 metró), stb. A megjelenítéshez a `references.routes` szótárból vesszük a `shortName`, `color` és `textColor` értékeket.
- Megálló azonosítók (`stopId`): Pl. `BKK_F01046`.
