@echo off
title osu!helper

python --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Python not found. Download from https://python.org
    pause
    exit /b 1
)

echo Installing dependencies...
pip install -r requirements.txt --quiet

echo Launching osu!helper...
python desktop.py
