# 🚋 BKK Live Tracker & DIY API Hub

Könnyűsúlyú, **Python (FastAPI)** alapú élő BKK térkép, megállóhelyi FUTÁR kijelző és API központ saját felhasználásra, Android widgetekhez (KWGT) és DIY (ESP32 / Home Assistant) projektekhez.

## ✨ Főbb funkciók
- **Élő Járműtérkép:** Buszok, villamosok, trolik, metrók és HÉV-ek valós idejű követése hivatalos BKK színkódokkal.
- **Megállóhelyi FUTÁR Kijelző:** Kattints bármelyik megállóra a térképen (vagy keress `stopId` alapján), és lásd percre pontosan a következő indulásokat.
- **Beépített Cache & CORS védelem:** A Python backend kezeli a BKK API hívásokat, elrejti az API kulcsot, és memóriabeli gyorsítótárral védi a kvótádat.
- **GTFS-Realtime (Protobuf) támogatás:** Kész modul a bináris `.pb` feedek (`VehiclePositions.pb`) dekódolására.
- **Widget-barát JSON API:** Tiszta, sallangmentes végpontok Android KWGT widgethez vagy ESP32 kijelzőhöz.

---

## 🚀 Gyorsindítás (Helyi gépen vagy Antigravity-ben)

### 1. Virtuális környezet és függőségek telepítése
```bash
python -m venv venv
# Windows esetén:
venv\Scripts\activate
# Mac/Linux esetén:
source venv/bin/activate

pip install -r requirements.txt
```

### 2. BKK API kulcs beállítása
Másold le a `.env.example` fájlt `.env` néven, és írd bele a [BKK OpenData](https://opendata.bkk.hu/) portálon igényelt kulcsodat:
```bash
cp .env.example .env
```
*(Tipp: Ha nem állítasz be `.env` fájlt, a webes felületen a ⚙️ Beállítások gombbal böngészőből is megadhatod a kulcsot!)*

### 3. Alkalmazás indítása
```bash
python run.py
```
Nyisd meg a böngésződben: **http://localhost:8000**

Interaktív Swagger API dokumentáció: **http://localhost:8000/docs**

---

## 📱 Végpontok Android Widgethez / DIY projektekhez

Ha a szervert futtatod (pl. otthoni Raspberry Pi-n, NAS-on vagy ingyenes felhőben), az alábbi egyszerűsített végpontokat hívhatod:

- **`GET /api/departures/{stop_id}?limit=6`**
  - Példa: `/api/departures/BKK_F01046`
  - Visszaadja a megálló nevét és a következő indulásokat kiszámolt hátralévő percekkel (`minutesUntil`), járatszámmal és színkóddal.
- **`GET /api/vehicles?lat=47.4979&lon=19.0402&lat_span=0.03&lon_span=0.04`**
  - Visszaadja az adott területen mozgó összes járművet.
- **`GET /api/stops?lat=47.4979&lon=19.0402&lat_span=0.015&lon_span=0.02`**
  - Visszaadja a környékbeli megállókat és azok `stopId` azonosítóit.
- **`GET /api/gtfs-rt/vehicles`**
  - A teljes budapesti GTFS-Realtime Protobuf (`VehiclePositions.pb`) feedet dekódolja JSON formátumba.

---

## 📄 Licenc és Adatforrás
Adatforrás: **BKK Zrt., CC BY 4.0**
