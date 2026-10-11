@echo off
cd /d "%~dp0"
powershell -NoProfile -File "%~dp0Setup-Local-RAG.ps1" %*
if errorlevel 1 pause
