@echo off
cd /d "%~dp0"
powershell -NoProfile -File "%~dp0Setup-Analysis.ps1" %*
if errorlevel 1 pause
