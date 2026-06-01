@echo off
cd /d "%~dp0"
echo Starting New24h local control server...
echo Use News Ops to turn Auto News Loading and Auto Telegram on/off.
npm.cmd run local-auto
pause
