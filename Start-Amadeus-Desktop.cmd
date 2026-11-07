@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Amadeus-Desktop.ps1"
if errorlevel 1 pause
