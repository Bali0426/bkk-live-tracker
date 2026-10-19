# 🚋 BKK & MÁV Live Tracker (Tauri v2 + TypeScript + Rust)

Natív, szupergyors **Tauri v2 + Rust + TypeScript** alapú élő BKK és MÁV/GYSEV térkép, megállóhelyi FUTÁR kijelző, vagonWEB szerelvény-összeállítás megjelenítő és DIY API központ **Windows Desktop** és **Android** platformokra.

## ✨ Architektúra & Főbb Funkciók
- **Natív Alkalmazás (Tauri v2):** Nem böngészőben fut, hanem önálló natív alkalmazásként indul saját ablakban (Windows WebView2 / Android WebView), közvetlen **Tauri IPC (`#[tauri::command]` ↔ `invoke`)** kommunikációval.
- **TypeScript + Vite Frontend (`src-ui/`):** Szigorúan típusos (`src-ui/types.ts`) moduláris kód:
  - `src-ui/api.ts`: Tauri v2 IPC kliens (`@tauri-apps/api/core`) automatikus HTTP visszalépéssel.
  - `src-ui/hull.ts`: Konvex burok és lekerekített poligon generátor a BKK csomópontokhoz.
  - `src-ui/vagonweb.ts`: Tervezett és valós vagonWEB szerelvény-összeállítás megjelenítő.
  - `src-ui/main.ts`: 60 FPS-es dead-reckoning jármű/vonat animáció, kereső, FUTÁR kijelző és MÁV menetrendek.
- **Rust Backend (`src/`):**
  - `src/lib.rs`: Tauri v2 mobil- és asztali belépési pont (`#[cfg_attr(mobile, tauri::mobile_entry_point)]`), 13 natív IPC parancs, valamint asztali gépen háttérben futó Axum HTTP API szerver (`127.0.0.1:8000`) a KWGT/ESP32 widgetekhez.
  - `moka` aszinkron TTL gyorsítótár **Request Coalescing** támogatással és `RawValue` nulla-másolásos JSON továbbítással.

---

## 🚀 Indítás (Windows Desktop)

### 1. Gyorsindítás
Kattints duplán a **`run.bat`** fájlra, vagy futtasd:
```powershell
npm.cmd run build
cargo run --release
```

### 2. Fejlesztői mód (Hot-Reload)
```powershell
npm.cmd run tauri dev
```

### 3. Telepítő (.exe / .msi) készítése Windowsra
```powershell
npm.cmd run tauri build
```

---

## 📱 Android Portolás (Tauri v2 Mobile)

A projekt felépítése (`src/lib.rs` `#[cfg_attr(mobile, tauri::mobile_entry_point)]`, `crate-type = ["staticlib", "cdylib", "rlib"]` és a Tauri IPC alapú `src-ui/api.ts`) készen áll az Androidos fordításra. Amikor telepítve van az Android SDK / NDK:

```powershell
# 1. Android projekt inicializálása (egyszer kell futtatni)
npm.cmd run tauri android init

# 2. Futtatás Android emulátoron vagy csatlakoztatott telefonon
npm.cmd run tauri android dev

# 3. APK / AAB csomag fordítása
npm.cmd run tauri android build
```

---

## 🔌 DIY Widget Végpontok (KWGT / ESP32)
Asztali gépen a Tauri alkalmazás a háttérben (ha a 8000-es port szabad) automatikusan elindítja a helyi HTTP REST API-t is:
- `GET http://127.0.0.1:8000/api/departures/{stop_id}?limit=6`
- `GET http://127.0.0.1:8000/api/vehicles?lat=47.4979&lon=19.0402`
- `GET http://127.0.0.1:8000/api/mav/trains`
- `GET http://127.0.0.1:8000/api/gtfs-rt/vehicles`
