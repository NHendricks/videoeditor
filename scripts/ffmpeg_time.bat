@echo off
setlocal
set INPUT=0301_todo.show_app.mp4
set OUTPUT=output.mp4

ffmpeg -i "%INPUT%" ^
-vf "drawtext=fontfile=C\\:/Windows/Fonts/consola.ttf:text=%%{pts\\:hms}:x=w-tw-20:y=20:fontsize=28:fontcolor=white:borderw=2:bordercolor=black" ^
-c:a copy "%OUTPUT%"

echo.
echo Fertig! Ausgabe: %OUTPUT%
pause