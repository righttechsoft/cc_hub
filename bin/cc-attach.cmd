@echo off
setlocal
set "ROOT=%~dp0.."
call "%ROOT%\node_modules\.bin\tsx.cmd" "%ROOT%\src\attach\cli.ts" %*
exit /b %errorlevel%
