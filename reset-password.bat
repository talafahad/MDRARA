@echo off
cd /d "%~dp0"
rem Reads the database settings from start-mssql.bat, so the password is kept in one place only.
for /f "usebackq delims=" %%L in (`findstr /b /i "set" "start-mssql.bat"`) do %%L
echo Users in the database:
node scripts\reset-password.js
echo.
set /p "EMAIL=Email of the user to reset: "
set /p "NEWPW=New password (8+ characters): "
node scripts\reset-password.js "%EMAIL%" "%NEWPW%"
pause
