@echo off
setlocal
set INPUT=0301_todo.show_app.mp4
set OUTPUT=0301_90-100-output_cut_speed.mp4
set START=90
set END=99
set SPEED=1

ffmpeg -i "%INPUT%" ^
  -filter_complex "[0:v]trim=start=%START%:end=%END%,setpts=(PTS-STARTPTS)/%SPEED%[v]" ^
  -map "[v]" -an -c:v libx264 "%OUTPUT%"

echo Fertig: %OUTPUT%
pause