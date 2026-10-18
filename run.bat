@echo off
echo Starting BKK Live Tracker (Rust)...
where cargo >nul 2>nul
if %ERRORLEVEL% equ 0 (
    cargo run --release
) else if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
    "%USERPROFILE%\.cargo\bin\cargo.exe" run --release
) else if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe run.py
) else (
    py -3 run.py
)
pause
