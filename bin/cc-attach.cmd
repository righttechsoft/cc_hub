@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
call npx tsx "%SCRIPT_DIR%..\src\attach\cli.ts" %*
exit /b %errorlevel%
