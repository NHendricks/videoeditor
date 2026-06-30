@echo off
setlocal
set INPUT=input.mp4
set OUTPUT=output_cut.mp4
set START=140
set END=180

ffmpeg -i "%INPUT%" -filter_complex "[0:v]trim=start=%START%:end=%END%,setpts=PTS-STARTPTS[v];[0:a]atrim=start=%START%:end=%END%,asetpts=PTS-STARTPTS[a]" -map "[v]" -map "[a]" -c:v libx264 -c:a aac "%OUTPUT%"

echo Fertig: %OUTPUT%
pause