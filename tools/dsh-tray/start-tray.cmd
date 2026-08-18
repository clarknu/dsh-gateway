@echo off
rem dsh-tray 双击启动器：以隐藏窗口方式拉起托盘（无黑窗口）
start "" pwsh -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0dsh-tray.ps1"
