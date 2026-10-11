@echo off
cd /d "%~dp0"
powershell -NoProfile -File "%~dp0Start-Local-RAG.ps1" %*
if errorlevel 1 pause
