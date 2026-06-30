# videoeditor

Kleine Web-App zum Definieren von Video-Bereichen (Anfang, Ende, Geschwindigkeitsfaktor),
die per ffmpeg als **separate Clips** extrahiert und anschließend zu einem Gesamtvideo
**zusammengefügt** werden.

- **Frontend:** Vite + TypeScript + [lit-html](https://lit.dev/docs/libraries/standalone-templates/)
- **Backend:** [Hono](https://hono.dev/) (Node) + ffmpeg

## Voraussetzungen

- Node.js ≥ 20
- ffmpeg (und ffprobe) installiert. Pfad wird im Backend per `.env` konfiguriert.

## Setup

```bash
# Abhängigkeiten installieren (Root + Backend + Frontend)
npm run install:all

# Backend-Konfiguration anlegen
cp backend/.env.example backend/.env
# in backend/.env den FFMPEG_PATH setzen, z. B.:
#   FFMPEG_PATH=C:\tools\ffmpeg\bin\ffmpeg.exe
```

Quellvideos in den Ordner `backend/videos/` legen (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`).
Dieser Ordner ist per `.gitignore` ausgenommen.

## Starten

```bash
npm run dev
```

- Backend: <http://localhost:3000>
- Frontend: <http://localhost:5173>

Das Frontend leitet `/api` und `/videos` im Dev-Modus an das Backend weiter.

## Ablauf

1. Quellvideo im Dropdown wählen (liegt in `backend/videos/`).
2. Video abspielen, an gewünschter Stelle **„Bereich hinzufügen“**.
3. Pro Bereich Anfang, Ende und Geschwindigkeitsfaktor anpassen.
4. **„Clips erstellen & zusammenfügen“** – das Backend erzeugt:
   - je Bereich einen separaten Clip,
   - ein zusammengefügtes Gesamtvideo,
   abgelegt unter `backend/videos/output/<jobId>/`.

## ffmpeg-Logik

Die ffmpeg-Aufrufe orientieren sich an den Skripten unter [`scripts/`](scripts/):

- **Bereich + Geschwindigkeit** (`ffmpeg_speedup_part.bat`):
  `trim`/`atrim` + `setpts=(PTS-STARTPTS)/speed` und `atempo`-Kette.
- **Zusammenfügen** (`ffmpeg_merge.bat`): concat-Demuxer mit `-c copy`.

Geschwindigkeitsfaktoren außerhalb von 0.5–2.0 werden für Audio automatisch in
mehrere `atempo`-Filter zerlegt. Hat die Quelle keinen Audio-Stream, wird ohne Audio
verarbeitet (per ffprobe erkannt).

## API

- `GET /api/videos` – Liste der Quellvideos
- `POST /api/process` – `{ source, segments: [{ start, end, speed }] }`
- `GET /videos/...` – Auslieferung von Quell- und Ergebnisvideos
- `GET /api/health` – Status + aktiver ffmpeg-Pfad
