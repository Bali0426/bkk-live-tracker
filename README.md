# 🚋 BKK Live Tracker & DIY API Hub (Rust Edition)

Könnyűsúlyú, szupergyors **Rust (Axum + Tokio)** alapú élő BKK térkép, megállóhelyi FUTÁR kijelző és API központ saját felhasználásra, Android widgetekhez (KWGT) és DIY (ESP32 / Home Assistant) projektekhez.

## ✨ Főbb funkciók & Rust Optimalizációk
- **Nagy Teljesítmény & Alacsony Memóriahasználat:** Pár megabájtos memórialábnyom a korábbi Python backendhez képest.
- **Request Coalescing Cache:** A `moka` gyorsítótár egyidejű lekérések esetén összevonja a hívásokat, megvédve a BKK/MÁV API kvótát.
- **Párhuzamosított hálózati lekérések:** A budapesti törzshálózat és a MÁV adatok szinkron/szekvenciális lekérés helyett korlátozott párhuzamossággal töltődnek be.
- **GTFS-Realtime (Protobuf) integráció:** Bináris `.pb` feed dekódolás közvetlenül Rust `prost` struktúrákkal.
- **Beágyazott statikus frontend:** `rust-embed` segítségével a HTML/CSS/JS frontend egyetlen önálló binárisba fordul be.
- **Élő Járműtérkép:** BKK és MÁV/GYSEV járatok valós idejű követése hivatalos színkódokkal és sebességszámítással.
- **vagonWEB integráció:** Tervezett és tényleges szerelvényösszeállítások.

---

## 🚀 Gyorsindítás

### Rust futtatás:
```bash
cargo run --release
```
Vagy kattints kétszer a `run.bat` fájlra Windows alatt.

Nyisd meg a böngésződben: **http://localhost:8000**

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
