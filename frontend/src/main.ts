import { html, render, type TemplateResult } from 'lit-html';

interface Section {
  start: number;
  end: number;
  speed: number;
}

interface ProcessResult {
  jobId: string;
  withAudio: boolean;
  segments: { file: string; url: string; spec: { start: number; end: number; speed: number } }[];
  merged: { file: string; url: string } | null;
}

interface Progress {
  done: boolean;
  step: string; // menschenlesbares Label des aktuellen Schritts
  index: number;
  total: number;
  expected: number; // erwartete Dauer des aktuellen Schritts (s)
  current: number; // aus ffmpeg geparste Zeit (s)
  lines: string[]; // ffmpeg-Ausgabe (rollend)
  error: string | null;
}

interface State {
  videos: string[];
  source: string | null;
  duration: number;
  currentTime: number;
  progress: Progress | null;
  // Trenner-Zeitpunkte (sortiert, exklusive 0 und Ende).
  splits: number[];
  // Geschwindigkeit je Abschnitt; speeds.length === splits.length + 1.
  speeds: number[];
  processing: boolean;
  uploading: boolean;
  result: ProcessResult | null;
  error: string | null;
}

const state: State = {
  videos: [],
  source: null,
  duration: 0,
  currentTime: 0,
  progress: null,
  splits: [],
  speeds: [1],
  processing: false,
  uploading: false,
  result: null,
  error: null,
};

const appRoot = document.getElementById('app')!;

// --- Hilfsfunktionen ---

function fmt(seconds: number): string {
  if (!isFinite(seconds)) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

function videoEl(): HTMLVideoElement | null {
  return appRoot.querySelector('video');
}

// --- Datenzugriff ---

async function loadVideos(retries = 0): Promise<void> {
  try {
    const res = await fetch('/api/videos');
    const data = await res.json();
    state.videos = data.videos ?? [];
    state.error = null;
    if (state.source && !state.videos.includes(state.source)) {
      state.source = null;
    }
    if (!state.source && state.videos.length > 0) {
      selectSource(state.videos[0]!);
      return;
    }
  } catch {
    // Beim Start ist das Backend (tsx) evtl. noch nicht bereit -> nachfassen.
    if (retries > 0) {
      setTimeout(() => void loadVideos(retries - 1), 700);
      return;
    }
    state.error = 'Backend nicht erreichbar. Läuft das Backend auf Port 3000?';
  }
  update();
}

async function uploadVideo(file: File): Promise<void> {
  state.uploading = true;
  state.error = null;
  update();
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) {
      state.error = data.error ?? `Upload fehlgeschlagen (${res.status})`;
    } else {
      await loadVideos();
      selectSource(data.file);
    }
  } catch (e) {
    state.error = String(e);
  } finally {
    state.uploading = false;
    update();
  }
}

/** Parst aus einer ffmpeg-Zeile die `time=HH:MM:SS.ss`-Angabe in Sekunden. */
function parseFfmpegTime(line: string): number | null {
  const m = line.match(/time=\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleProgressEvent(ev: any): void {
  const p = state.progress;
  if (!p) return;
  switch (ev.type) {
    case 'start':
      p.total = ev.total ?? p.total;
      break;
    case 'step':
      p.current = 0;
      p.expected = typeof ev.expected === 'number' ? ev.expected : 0;
      if (ev.step === 'segment') {
        p.index = ev.index;
        p.step = `Abschnitt ${ev.index}/${ev.total} wird extrahiert…`;
      } else if (ev.step === 'merge') {
        p.step = 'Abschnitte werden zusammengefügt…';
      }
      break;
    case 'log': {
      p.lines.push(ev.line);
      if (p.lines.length > 300) p.lines.splice(0, p.lines.length - 300);
      const t = parseFfmpegTime(ev.line);
      if (t !== null) p.current = t;
      break;
    }
    case 'done':
      p.done = true;
      p.step = 'Fertig';
      state.result = ev.result;
      break;
    case 'error':
      p.error = ev.message;
      p.step = 'Fehler';
      state.error = ev.message;
      break;
  }
  update();
}

function closeProgress(): void {
  state.progress = null;
  update();
}

async function process(): Promise<void> {
  if (!state.source) return;
  const segs = sections().filter((s) => s.end - s.start > 0.05);
  if (segs.length === 0) return;
  state.processing = true;
  state.error = null;
  state.result = null;
  state.progress = {
    done: false,
    step: 'Starte…',
    index: 0,
    total: segs.length,
    expected: 0,
    current: 0,
    lines: [],
    error: null,
  };
  update();

  try {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: state.source,
        segments: segs.map((s) => ({
          start: Number(s.start.toFixed(3)),
          end: Number(s.end.toFixed(3)),
          speed: s.speed,
        })),
      }),
    });

    if (!res.ok || !res.body) {
      let msg = `Fehler ${res.status}`;
      try {
        msg = (await res.json()).error ?? msg;
      } catch {
        /* ignore */
      }
      state.error = msg;
      state.progress = null;
      return;
    }

    // NDJSON-Stream zeilenweise lesen.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) handleProgressEvent(JSON.parse(line));
      }
    }
  } catch (e) {
    state.error = String(e);
    if (state.progress) state.progress.error = String(e);
  } finally {
    state.processing = false;
    update();
  }
}

// --- Aktionen ---

function selectSource(name: string): void {
  state.source = name;
  state.splits = [];
  state.speeds = [1];
  state.result = null;
  state.error = null;
  state.duration = 0;
  state.currentTime = 0;
  update();
}

/** Grenzen aller Abschnitte: [0, ...Trenner, Ende]. */
function boundaries(): number[] {
  return [0, ...state.splits, state.duration];
}

/** Aus Trennern und Speeds abgeleitete Abschnitte. */
function sections(): Section[] {
  const b = boundaries();
  return state.speeds.map((speed, i) => ({ start: b[i]!, end: b[i + 1]!, speed }));
}

/** Fügt einen Trenner an Position t ein und teilt den betroffenen Abschnitt. */
function addSplit(t: number): void {
  const time = Number(t.toFixed(1));
  if (!(time > 0 && time < state.duration)) return;
  if (state.splits.some((s) => Math.abs(s - time) < 0.05)) return;
  const segIdx = state.splits.filter((s) => s < time).length; // betroffener Abschnitt
  state.splits.push(time);
  state.splits.sort((a, b) => a - b);
  // Neuer Trenner teilt segIdx -> Speed dieses Abschnitts duplizieren.
  state.speeds.splice(segIdx, 0, state.speeds[segIdx] ?? 1);
  update();
}

/** Entfernt den Trenner mit Index `index` und führt die zwei Abschnitte zusammen. */
function removeSplit(index: number): void {
  state.splits.splice(index, 1);
  state.speeds.splice(index + 1, 1); // rechten Abschnitt-Speed verwerfen
  update();
}

function setSpeed(segIdx: number, value: number): void {
  if (value > 0) state.speeds[segIdx] = value;
  update();
}

function seekTo(t: number): void {
  const v = videoEl();
  if (v) v.currentTime = t;
}

function pct(x: number): number {
  return state.duration > 0 ? (x / state.duration) * 100 : 0;
}

// Nach einem Drag kurz das Seek-Klicken der Zeitleiste unterdrücken.
let suppressSeekUntil = 0;

/** Startet das Verschieben eines Trenners (begrenzt durch die Nachbar-Grenzen). */
function startDragSplit(index: number, ev: PointerEvent): void {
  ev.preventDefault();
  ev.stopPropagation();
  const timelineEl = appRoot.querySelector('.timeline') as HTMLElement | null;
  if (!timelineEl) return;

  const eps = 0.1;
  let moved = false;

  const onMove = (e: PointerEvent) => {
    moved = true;
    const rect = timelineEl.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const lower = index === 0 ? 0 : state.splits[index - 1]!;
    const upper = index === state.splits.length - 1 ? state.duration : state.splits[index + 1]!;
    const t = Math.min(upper - eps, Math.max(lower + eps, ratio * state.duration));
    state.splits[index] = Number(t.toFixed(1));
    update();
  };
  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.body.classList.remove('dragging');
    if (moved) suppressSeekUntil = Date.now() + 250;
  };

  document.body.classList.add('dragging');
  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
}

// --- Templates ---

function timeline(): TemplateResult {
  const secs = sections();
  return html`
    <div
      class="timeline"
      title="Klicken zum Springen"
      @click=${(e: MouseEvent) => {
        // Klicks auf Marker oder direkt nach einem Drag nicht als Seek werten.
        if ((e.target as HTMLElement).classList.contains('split')) return;
        if (Date.now() < suppressSeekUntil) return;
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        seekTo(ratio * state.duration);
      }}
    >
      ${secs.map(
        (s, i) => html`<div
          class="seg seg-${i % 2}"
          style="left:${pct(s.start)}%;width:${pct(s.end - s.start)}%"
          title="Abschnitt ${i + 1}: ${fmt(s.start)}–${fmt(s.end)} · ${s.speed}×"
        >
          <span>${i + 1} · ${s.speed}×</span>
        </div>`,
      )}
      ${state.splits.map(
        (t, i) => html`<div
          class="split"
          style="left:${pct(t)}%"
          title="Trenner bei ${fmt(t)} – ziehen zum Verschieben, Doppelklick zum Entfernen"
          @pointerdown=${(e: PointerEvent) => startDragSplit(i, e)}
          @dblclick=${(e: MouseEvent) => {
            e.stopPropagation();
            removeSplit(i);
          }}
        ></div>`,
      )}
      <div id="playhead" class="playhead" style="left:0%"></div>
    </div>
  `;
}

function sectionRow(s: Section, i: number): TemplateResult {
  return html`
    <tr>
      <td>${i + 1}</td>
      <td>
        <div class="cell">
          <span class="time-display">${fmt(s.start)}</span>
          <button class="ghost" title="Zum Anfang springen" @click=${() => seekTo(s.start)}>▶</button>
        </div>
      </td>
      <td><span class="time-display">${fmt(s.end)}</span></td>
      <td>${fmt(s.end - s.start)}</td>
      <td>
        <input
          type="number"
          step="0.1"
          min="0.1"
          .value=${String(s.speed)}
          @change=${(e: Event) => setSpeed(i, Number((e.target as HTMLInputElement).value))}
        />×
      </td>
      <td>
        ${i > 0
          ? html`<button
              class="danger"
              title="Trenner vor diesem Abschnitt entfernen (mit vorherigem zusammenführen)"
              @click=${() => removeSplit(i - 1)}
            >
              ✕ Trenner
            </button>`
          : html`<span class="hint">—</span>`}
      </td>
    </tr>
  `;
}

function progressPopup(p: Progress): TemplateResult {
  const percent = p.expected > 0 ? Math.min(100, (p.current / p.expected) * 100) : null;
  const finished = p.done || !!p.error;
  return html`
    <div class="modal-overlay">
      <div class="modal">
        <h2 style="margin:0 0 6px;font-size:18px">
          ${p.error ? '❌ Fehler' : p.done ? '✅ Fertig' : '⚙ Verarbeitung läuft…'}
        </h2>
        <p class="hint" style="margin:0 0 12px">${p.step}</p>
        ${percent !== null && !finished
          ? html`
              <div class="progressbar"><div class="bar" style="width:${percent}%"></div></div>
              <p class="hint" style="margin:4px 0 12px">
                ${Math.round(percent)}% · ${fmt(p.current)} / ${fmt(p.expected)}
              </p>
            `
          : ''}
        <pre id="ff-log" class="ff-log">${p.lines.join('\n')}</pre>
        ${p.error ? html`<div class="error" style="margin-top:12px">${p.error}</div>` : ''}
        <div class="row" style="justify-content:flex-end;margin-top:14px">
          ${finished
            ? html`<button @click=${closeProgress}>Schließen</button>`
            : html`<span class="hint"><span class="spinner"></span>ffmpeg arbeitet…</span>`}
        </div>
      </div>
    </div>
  `;
}

function resultsPanel(r: ProcessResult): TemplateResult {
  return html`
    <div class="panel results">
      <h2 style="font-size:16px;margin:0 0 12px">Ergebnis ${r.withAudio ? '🔊' : '🔇 (ohne Audio)'}</h2>
      <p class="hint">Einzelne Clips:</p>
      <ul>
        ${r.segments.map(
          (s) => html`<li>
            <a href=${s.url} target="_blank">${s.file}</a>
            <span class="hint">(${fmt(s.spec.start)}–${fmt(s.spec.end)}, ${s.spec.speed}×)</span>
          </li>`,
        )}
      </ul>
      ${r.merged
        ? html`
            <p class="hint">Zusammengefügtes Gesamtvideo:</p>
            <video controls src=${r.merged.url}></video>
            <p><a href=${r.merged.url} download>⬇ ${r.merged.file} herunterladen</a></p>
          `
        : ''}
    </div>
  `;
}

function appTemplate(): TemplateResult {
  return html`
    <h1>🎬 Video Editor</h1>
    <p class="subtitle">
      Trenner auf der Zeitleiste setzen → Abschnitte ergeben sich automatisch. Pro Abschnitt einen
      Geschwindigkeitsfaktor wählen, als Clips extrahieren und zusammenfügen.
    </p>

    ${state.error ? html`<div class="error">${state.error}</div>` : ''}

    <div class="panel">
      <div class="row">
        <label>Quellvideo:</label>
        <select
          @change=${(e: Event) => selectSource((e.target as HTMLSelectElement).value)}
          .value=${state.source ?? ''}
        >
          ${state.videos.length === 0
            ? html`<option value="">— keine Videos im videos/-Ordner —</option>`
            : state.videos.map(
                (v) => html`<option value=${v} ?selected=${v === state.source}>${v}</option>`,
              )}
        </select>
        <button class="secondary" @click=${() => loadVideos()}>↻ Aktualisieren</button>
        <span class="flex-spacer"></span>
        <label class="upload-btn">
          ${state.uploading ? html`<span class="spinner"></span>Lade hoch…` : '⬆ Video hochladen'}
          <input
            type="file"
            accept="video/*,.mp4,.mov,.mkv,.webm,.m4v"
            ?disabled=${state.uploading}
            @change=${(e: Event) => {
              const input = e.target as HTMLInputElement;
              const f = input.files?.[0];
              if (f) void uploadVideo(f);
              input.value = '';
            }}
          />
        </label>
      </div>

      ${state.source
        ? html`
            <video
              controls
              src=${`/videos/${encodeURIComponent(state.source)}`}
              @loadedmetadata=${(e: Event) => {
                state.duration = (e.target as HTMLVideoElement).duration;
                update();
              }}
              @timeupdate=${(e: Event) => {
                state.currentTime = (e.target as HTMLVideoElement).currentTime;
                updateTimeDisplay();
              }}
            ></video>
            <div class="row" style="margin-top:10px">
              <span>Aktuelle Position:
                <span class="time-display" id="cur">0:00</span> /
                ${fmt(state.duration)}</span>
              <span class="flex-spacer"></span>
              <button @click=${() => addSplit(state.currentTime)} ?disabled=${state.duration <= 0}>
                ✂ Trenner an aktueller Position
              </button>
            </div>
            ${state.duration > 0
              ? html`${timeline()}
                  <p class="hint" style="margin:8px 0 0">
                    Spiele das Video bis zur gewünschten Stelle und setze einen Trenner. Die
                    Abschnitte ergeben sich automatisch zwischen den Trennern. Klick auf einen
                    Trenner-Marker entfernt ihn.
                  </p>`
              : ''}
          `
        : ''}
    </div>

    ${state.source && state.duration > 0
      ? html`
          <div class="panel">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Von</th>
                  <th>Bis</th>
                  <th>Dauer</th>
                  <th>Speed</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${sections().map((s, i) => sectionRow(s, i))}
              </tbody>
            </table>
            <div class="row" style="margin-top:16px">
              <button @click=${process} ?disabled=${state.processing}>
                ${state.processing
                  ? html`<span class="spinner"></span>Verarbeite…`
                  : '⚙ Clips erstellen & zusammenfügen'}
              </button>
              <span class="hint"
                >${state.speeds.length} Abschnitt(e), ${state.splits.length} Trenner</span
              >
            </div>
          </div>
        `
      : ''}

    ${state.result ? resultsPanel(state.result) : ''}
    ${state.progress ? progressPopup(state.progress) : ''}
  `;
}

// --- Render ---

function update(): void {
  render(appTemplate(), appRoot);
  // Aktuelle Zeit nach dem Render wiederherstellen (Span enthält bewusst KEINE
  // lit-Binding, damit updateTimeDisplay() den Inhalt gefahrlos setzen darf).
  updateTimeDisplay();
}

// Leichtgewichtiges Update nur des Zeit-Anzeigers (timeupdate feuert häufig).
// Wichtig: #cur ist statischer Text (keine lit-Binding), sonst würde das
// Setzen von textContent lit-html's Marker-Knoten zerstören.
function updateTimeDisplay(): void {
  const el = document.getElementById('cur');
  if (el) el.textContent = fmt(state.currentTime);
  // Playhead in der Zeitleiste mitführen (kein lit-Part, daher direkt setzbar).
  const ph = document.getElementById('playhead');
  if (ph) ph.style.left = `${pct(state.currentTime)}%`;
  // ffmpeg-Log automatisch nach unten scrollen.
  const log = document.getElementById('ff-log');
  if (log) log.scrollTop = log.scrollHeight;
}

update();
loadVideos(8);
