@echo off
setlocal

rem Parameter
set INPUT=input.mp4
set OUTPUT=output_speed_part.mp4
set START=10
set END=120
set SPEED=5

rem Video-/Audio-Teil START–END um Faktor SPEED beschleunigen
ffmpeg -i "%INPUT%" -filter_complex "[0:v]trim=start=%START%:end=%END%,setpts=(PTS-STARTPTS)/%SPEED%[v];[0:a]atrim=start=%START%:end=%END%,asetpts=PTS-STARTPTS,atempo=%SPEED%[a]" -map "[v]" -map "[a]" -c:v libx264 -c:a aac "%OUTPUT%"

echo Fertig: %OUTPUT%
pause