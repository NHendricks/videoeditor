@echo off
setlocal

REM Alte Liste löschen
del filelist.txt 2>nul

REM Alphabetische Liste aller .mp4-Dateien erstellen
for %%F in (*.mp4) do (
  echo file '%%F'>>filelist.txt
)

REM Dateien zusammenfügen
ffmpeg -f concat -safe 0 -i filelist.txt -c copy merged.mp4

echo Merge fertig: merged.mp4
pause