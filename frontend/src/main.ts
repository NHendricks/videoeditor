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

interface State {
  videos: string[];
  source: string | null;
  duration: number;
  currentTime: number;
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

async function process(): Promise<void> {
  if (!state.source) return;
  const segs = sections().filter((s) => s.end - s.start > 0.05);
  if (segs.length === 0) return;
  state.processing = true;
  state.error = null;
  state.result = null;
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
    const data = await res.json();
    if (!res.ok) {
      state.error = data.error ?? `Fehler ${res.status}`;
    } else {
      state.result = data;
    }
  } catch (e) {
    state.error = String(e);
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

// --- Templates ---

function timeline(): TemplateResult {
  const secs = sections();
  return html`
    <div
      class="timeline"
      title="Klicken zum Springen"
      @click=${(e: MouseEvent) => {
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
          title="Trenner bei ${fmt(t)} – klicken zum Entfernen"
          @click=${(e: MouseEvent) => {
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
}

update();
loadVideos(8);
