@echo off
set "voice_data=%AGENTDEMO_DATA_DIR%"
if not defined voice_data set "voice_data=%~dp0.data"
"%voice_data%\voice-asr-python\Scripts\python.exe" "%~dp0scripts\local_voice\manage.py" start
if errorlevel 1 pause
