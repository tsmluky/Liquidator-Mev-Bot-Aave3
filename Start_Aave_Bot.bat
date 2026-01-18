@echo off
TITLE Aave V3 Liquidation Fleet
cd /d "%~dp0"
echo Starting Launcher...
powershell -NoProfile -ExecutionPolicy Bypass -File ".\Liquidator_Aave3.ps1"
pause
