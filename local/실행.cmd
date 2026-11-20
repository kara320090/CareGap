@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto start
echo 먼저 설치.cmd를 실행하세요. Python 3.12와 인터넷 연결이 필요합니다.
pause
exit /b 1
:start
".venv\Scripts\python.exe" -m streamlit run app.py --server.address 127.0.0.1
set "caregapExit=%ERRORLEVEL%"
if not "%caregapExit%"=="0" pause
exit /b %caregapExit%
