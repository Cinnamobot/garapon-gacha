@echo off
rem Open the kuji app in Microsoft Edge (fullscreen). Press F11 to exit fullscreen.
start "" msedge --new-window --start-fullscreen "%~dp0index.html"
if errorlevel 1 start "" "%~dp0index.html"
