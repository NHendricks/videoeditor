@echo off
setlocal

set INPUT=input.mp4
set OUTPUT=output.mp4

ffmpeg -ss 197 -i input.mp4 -c copy output.mp4
echo.
echo Fertig! Ausgabe: %OUTPUT%
pause