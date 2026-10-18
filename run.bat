@echo off
echo Starting BKK Live Tracker...
if exist "venv\Scripts\python.exe" (
    venv\Scripts\python.exe run.py
) else if exist "..\venv\Scripts\python.exe" (
    ..\venv\Scripts\python.exe run.py
) else (
    py -3 run.py
)
pause
