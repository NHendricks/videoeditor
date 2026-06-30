@echo off
setlocal

rem Parameter
set INPUT=4_generating_todo_speed10.mp4
set OUTPUT=output_speed_full.mp4
set SPEED=10

rem Komplettes Video um Faktor SPEED beschleunigen
ffmpeg -i "%INPUT%" -filter_complex "[0:v]setpts=PTS/%SPEED%[v];[0:a]atempo=%SPEED%[a]" -map "[v]" -map "[a]" -c:v libx264 -c:a aac "%OUTPUT%"

echo Fertig: %OUTPUT%
pause