@echo off
python "%~dp0scripts\local_voice\manage.py" setup %*
if errorlevel 1 pause
