@echo off
title osu!helper — Build Installer
echo.
echo  ================================
echo   osu!helper Installer Builder
echo  ================================
echo.

:: Check Python
python --version >nul 2>&1
if errorlevel 1 (
    echo  ERROR: Python not found. Download from https://python.org
    pause & exit /b 1
)

:: Install build deps
echo  [1/3] Installing dependencies...
pip install pyinstaller numpy flask requests pywebview --quiet

:: Run PyInstaller
echo  [2/3] Building app with PyInstaller...
pyinstaller osuhelper.spec --clean --noconfirm

if not exist "dist\osuhelper\osuhelper.exe" (
    echo.
    echo  ERROR: PyInstaller build failed. Check output above.
    pause & exit /b 1
)

echo  Build successful!

:: Try Inno Setup (common install paths)
set ISCC=
if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" set ISCC=C:\Program Files (x86)\Inno Setup 6\ISCC.exe
if exist "C:\Program Files\Inno Setup 6\ISCC.exe"       set ISCC=C:\Program Files\Inno Setup 6\ISCC.exe

if "%ISCC%"=="" (
    echo.
    echo  [3/3] Inno Setup not found — skipping installer creation.
    echo        Download from: https://jrsoftware.org/isinfo.php
    echo        Then re-run this script to get osuhelper_setup.exe
    echo.
    echo  Your built app is at: dist\osuhelper\osuhelper.exe
    echo  You can zip the dist\osuhelper\ folder and share it as-is.
) else (
    echo  [3/3] Building installer with Inno Setup...
    mkdir output 2>nul
    "%ISCC%" installer.iss
    echo.
    echo  ✓ Installer ready: output\osuhelper_setup.exe
)

echo.
pause
