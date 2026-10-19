@echo off
chcp 65001 >nul
echo Starting BKK & MAV Live Tracker (Native Tauri v2 Desktop App)...

set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

if not exist "target\release\bkk-live-tracker.exe" (
    echo Building native Tauri v2 desktop application...
    call npm.cmd run tauri -- build --no-bundle
)

start "" "target\release\bkk-live-tracker.exe"
