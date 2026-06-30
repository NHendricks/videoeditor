# videoeditor

Kleine Web-App, um in einem Video per **Trenner** Abschnitte zu definieren, diese mit
individuellem **Geschwindigkeitsfaktor** als separate Clips per ffmpeg zu extrahieren und
anschließend zu einem Gesamtvideo **zusammenzufügen**. Einzelne Abschnitte lassen sich
auslassen, und optional kann die laufende Originalzeit eingeblendet werden.

- **Frontend:** Vite + TypeScript + [lit-html](https://lit.dev/docs/libraries/standalone-templates/)
- **Backend:** [Hono](https://hono.dev/) (Node) + ffmpeg

Läuft unter **Windows, macOS und Linux**.

## Features

- 🎬 **Quellvideo wählen** aus `backend/videos/` oder **per Upload** direkt in der App.
- ✂️ **Trenner auf der Zeitleiste** setzen – die Abschnitte ergeben sich automatisch
  zwischen den Trennern (`0 → Trenner₁ → … → Ende`).
- 🖱️ Trenner per **Drag verschieben** (begrenzt durch die Nachbarn), **Doppelklick** entfernt sie.
- ⏩ **Geschwindigkeitsfaktor pro Abschnitt** (Video via `setpts`, Audio via `atempo`-Kette,
  auch außerhalb 0.5–2.0).
- ⏭️ **Abschnitte auslassen** – ausgeschlossene Abschnitte landen weder als Clip noch im
  Gesamtvideo.
- 🕑 Optional **laufende Originalzeit** oben rechts einblenden (`hh:mm:ss.zehntel`), bezogen
  auf die echte Position im Quellvideo (unabhängig von Trim und Speed).
- ⚙️ **Verarbeiten** erzeugt je Abschnitt einen separaten Clip **und** ein zusammengefügtes
  Gesamtvideo.
- 📊 **Live-Fortschritt** der ffmpeg-Ausgabe in einem Popup (Fortschrittsbalken + Log),
  mit **Abbrechen**-Button (stoppt den laufenden ffmpeg-Prozess).
- 💾 **Projekt-Persistenz** in `localStorage` (Quellvideo, Trenner, Speeds, Auslassen,
  Overlay) – nach Reload ist der letzte Stand wieder da.

## Voraussetzungen

- Node.js ≥ 20
- ffmpeg (inkl. ffprobe) installiert:
  - **Windows:** Build von [ffmpeg.org](https://ffmpeg.org/download.html) (mit `drawtext`/libfreetype für das Zeit-Overlay)
  - **macOS:** `brew install ffmpeg`
  - **Linux:** `sudo apt install ffmpeg` (bzw. Paketmanager der Distribution)

Der ffmpeg-Pfad wird im Backend per `.env` konfiguriert (oder einfach `ffmpeg`, wenn es im PATH liegt).

## Setup

```bash
# Abhängigkeiten installieren (Root + Backend + Frontend)
npm run install:all

# Backend-Konfiguration anlegen
cp backend/.env.example backend/.env      # Windows PowerShell: copy backend\.env.example backend\.env
# bei Bedarf FFMPEG_PATH in backend/.env anpassen
```

Quellvideos in den Ordner `backend/videos/` legen (`.mp4`, `.mov`, `.mkv`, `.webm`, `.m4v`)
oder direkt in der App hochladen. Dieser Ordner ist per `.gitignore` ausgenommen.

## Starten

```bash
npm run dev
```

- Frontend: <http://localhost:5173>
- Backend: <http://localhost:3000>

Das Frontend leitet `/api` und `/videos` im Dev-Modus an das Backend weiter. (Kommt das
Backend etwas später hoch, fasst das Frontend automatisch nach.)

Einzeln starten geht auch:

```bash
npm run dev:backend     # nur Hono-Backend (Auto-Reload via node --watch)
npm run dev:frontend    # nur Vite-Frontend
```

## Ablauf

1. **Quellvideo** im Dropdown wählen oder per **⬆ Video hochladen** hinzufügen.
2. Video abspielen und an gewünschten Stellen **✂ Trenner** setzen. Trenner per Drag
   feinjustieren, Doppelklick entfernt sie. Klick auf die Zeitleiste springt zur Position.
3. Pro Abschnitt den **Speed** wählen und nicht benötigte Abschnitte über **Aktiv**
   abwählen.
4. Optional **🕑 Originalzeit einblenden** aktivieren.
5. **⚙ Clips erstellen & zusammenfügen** – ein Popup zeigt den ffmpeg-Fortschritt; bei
   Bedarf **Abbrechen**.
6. Ergebnis: je aktiver Abschnitt ein Clip plus das zusammengefügte Gesamtvideo unter
   `backend/videos/output/<jobId>/` (direkt im Popup abspiel- und herunterladbar).

Der Bearbeitungsstand wird automatisch im Browser gespeichert und beim nächsten Öffnen
wiederhergestellt.

## Konfiguration (`backend/.env`)

| Variable          | Default                        | Beschreibung                                                        |
| ----------------- | ------------------------------ | ------------------------------------------------------------------- |
| `FFMPEG_PATH`     | `ffmpeg`                       | Pfad zur ffmpeg-Executable (oder im PATH).                          |
| `FFPROBE_PATH`    | aus `FFMPEG_PATH` abgeleitet   | Pfad zu ffprobe (für die Audio-Erkennung).                          |
| `PORT`            | `3000`                         | Port des Backends.                                                  |
| `OVERLAY_FONTFILE`| plattformabhängig (s. u.)      | Schriftdatei fürs Zeit-Overlay (`.ttf`/`.ttc`).                     |

Die Standard-Schrift fürs Overlay wird je nach Betriebssystem automatisch gewählt
(Windows: Consolas, macOS: Menlo, Linux: DejaVu Sans Mono) – bei Bedarf per
`OVERLAY_FONTFILE` überschreiben.

## ffmpeg-Logik

Die ffmpeg-Aufrufe orientieren sich an den Skripten unter [`scripts/`](scripts/):

- **Abschnitt + Geschwindigkeit** (vgl. `ffmpeg_speedup_part.bat`):
  `trim`/`atrim` + `setpts=(PTS-STARTPTS)/speed` und eine `atempo`-Kette für Audio.
  Faktoren außerhalb 0.5–2.0 werden automatisch in mehrere `atempo`-Filter zerlegt.
- **Zeit-Overlay** (vgl. `ffmpeg_time.bat`): `drawtext` **nach** dem `trim`, aber **vor**
  dem `setpts` – so trägt das eingeblendete `hh:mm:ss.zehntel` die unveränderte
  Originalzeit, nicht die durch Trim/Speed veränderte Ausgabezeit.
- **Zusammenfügen** (vgl. `ffmpeg_merge.bat`): concat-Demuxer mit `-c copy`.

Hat die Quelle keinen Audio-Stream, wird per ffprobe erkannt und ohne Audio verarbeitet.

## API

- `GET /api/videos` – Liste der Quellvideos in `backend/videos/`.
- `POST /api/upload` – Multipart-Upload (`file`); speichert kollisionsfrei in `videos/`.
- `POST /api/process` – Body: `{ source, overlayTime, segments: [{ start, end, speed }] }`.
  Antwort ist ein **NDJSON-Stream** mit Fortschritt; pro Zeile ein Event:
  `start` · `step` (Abschnitt/Merge) · `log` (ffmpeg-Ausgabe) · `done` (Ergebnis) · `error`.
  Abbruch durch Schließen der Verbindung beendet den laufenden ffmpeg-Prozess.
- `GET /videos/...` – Auslieferung von Quell- und Ergebnisvideos.
- `GET /api/health` – Status + aktiver ffmpeg-Pfad.

## Projektstruktur

```
videoeditor/
├── backend/            # Hono + ffmpeg (TypeScript)
│   ├── src/index.ts    # API, Streaming, statische Auslieferung
│   ├── src/ffmpeg.ts   # Segment-Extraktion, Merge, Overlay, Abbruch
│   └── videos/         # Quell- und Ergebnisvideos (gitignored)
├── frontend/           # Vite + lit-html (TypeScript)
│   └── src/main.ts     # UI: Player, Zeitleiste/Trenner, Tabelle, Fortschritt
└── scripts/            # ffmpeg-Referenzskripte (.bat)
```
