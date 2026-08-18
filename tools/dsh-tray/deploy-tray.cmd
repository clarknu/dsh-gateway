@echo off
rem ============================================================
rem dsh-tray build & deploy script
rem   dev source : C:\Sync\DSH Tools\dsh-tray
rem   deploy     : C:\Soft\dsh-tray  (override: deploy-tray.cmd <target-dir>)
rem Usage: double-click, or: deploy-tray.cmd [target-dir]
rem ============================================================
setlocal
set "DEV=%~dp0"
if "%~1"=="" ( set "DEPLOY=C:\Soft\dsh-tray" ) else ( set "DEPLOY=%~1" )
set "BUILD=%TEMP%\dsh-tray-deploy"

echo [1/4] build Release...
dotnet publish "%DEV%app\dsh-tray.csproj" -c Release -o "%BUILD%" >nul
if errorlevel 1 ( echo BUILD FAILED & exit /b 1 )
echo       ok.

echo [2/4] stop running tray...
taskkill /IM dsh-tray.exe /F >nul 2>&1
echo       ok.

echo [3/4] deploy to %DEPLOY%...
if not exist "%DEPLOY%\bin" mkdir "%DEPLOY%\bin"
xcopy /E /I /Y "%BUILD%" "%DEPLOY%\bin" >nul
copy /Y "%DEV%config.json" "%DEPLOY%config.json" >nul
echo       ok.

echo [4/4] start tray from %DEPLOY%...
start "" "%DEPLOY%\bin\dsh-tray.exe"
echo done.
endlocal
