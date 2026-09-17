@echo off
rem ===  Budget 2026 launcher  ===
rem Double-click this file to open the budgeting app in your browser.
rem It starts a tiny local web server in this folder (needed so the app can
rem auto-save to budget-data.json) and then opens the app. Close the small
rem server window when you're done.

cd /d "%~dp0"

rem start the local server in its own minimised window
start "Budget 2026 server (close to quit)" /min cmd /c "python -m http.server 8777 --bind 127.0.0.1"

rem give it a moment, then open the app in the default browser
timeout /t 1 >nul
start "" "http://localhost:8777/budget-app.html"
