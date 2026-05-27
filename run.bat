@echo off

REM Stable runner: no nested parentheses (avoids "was unexpected at this time.")

REM Ensure window stays open when double-clicked
if /i "%~1" NEQ "stay" (
  start "Impression Share Analyzer" cmd /k call "%~f0" stay
  exit /b
)

setlocal EnableExtensions
cd /d "%~dp0"
chcp 65001 >nul
set PYTHONUTF8=1
set PIP_DISABLE_PIP_VERSION_CHECK=1
set "LOG=%cd%\run.log"

echo.>"%LOG%"
echo === Amazon Impression Share Analyzer ===
echo Working dir: %cd%
echo Log file: %LOG%
echo.

python --version >nul 2>nul
if errorlevel 1 goto :no_python

python -c "import streamlit" >nul 2>nul
if errorlevel 1 goto :install_deps
goto :run_app

:install_deps
echo Streamlit not found. Installing requirements...
echo If you're behind a proxy/offline, this may fail.
echo Full pip output is saved to run.log
echo.

call :fix_proxy_scheme

echo [1/2] Installing from default index...
python -m pip install -r requirements.txt >> "%LOG%" 2>&1
if errorlevel 1 goto :install_mirror
goto :run_app

:install_mirror
echo [2/2] Retry with Tsinghua mirror...
python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn >> "%LOG%" 2>&1
if errorlevel 1 goto :install_failed
goto :run_app

:install_failed
echo.
echo [ERROR] Dependency install failed.
echo Please open run.log to see full pip error.
echo.
echo Common causes:
echo   - Proxy set as https://127.0.0.1:xxxx (often should be http://...)
echo   - Corporate network blocks pypi
echo.
echo Try in PowerShell (example for local proxy 7890):
echo   $env:HTTP_PROXY  = "http://127.0.0.1:7890"
echo   $env:HTTPS_PROXY = "http://127.0.0.1:7890"
echo   pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
echo.
echo Or if you have NO proxy, clear them (new terminals after this):
echo   setx HTTP_PROXY ""
echo   setx HTTPS_PROXY ""
echo.
pause
exit /b 1

:run_app
echo Starting Streamlit...
echo (If browser doesn't open, visit http://localhost:8501)
echo.
python -m streamlit run app.py
echo.
echo Streamlit exited.
pause
exit /b 0

:no_python
echo.
echo [ERROR] Python not found in PATH.
echo Please install Python 3.10+ and check "Add Python to PATH".
echo.
pause
exit /b 1

:fix_proxy_scheme
REM Avoid parentheses here; proxy values can contain special chars.
if not defined HTTPS_PROXY goto :fix_http
echo Detected HTTPS_PROXY=%HTTPS_PROXY%
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$p=$env:HTTPS_PROXY; if($p){$p -replace '^https://','http://'}"`) do set "HTTPS_PROXY=%%A"

:fix_http
if not defined HTTP_PROXY goto :eof
echo Detected HTTP_PROXY=%HTTP_PROXY%
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$p=$env:HTTP_PROXY; if($p){$p -replace '^https://','http://'}"`) do set "HTTP_PROXY=%%A"
goto :eof
