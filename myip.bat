@echo off
echo Your IP Address:
ipconfig | findstr /C:"IPv4 Address" | findstr "192.168"
pause
