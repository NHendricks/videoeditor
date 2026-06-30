import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Pfad zur ffmpeg-Executable aus der .env. Fällt auf "ffmpeg" (PATH) zurück.
 */
export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

/**
 * Pfad zu ffprobe. Wird aus FFMPEG_PATH abgeleitet, falls nicht explizit gesetzt.
 */
export function ffprobePath(): string {
  const explicit = process.env.FFPROBE_PATH?.trim();
  if (explicit) return explicit;
  const ff = ffmpegPath();
  // "ffmpeg" -> "ffprobe", auch mit Verzeichnis/Endung.
  const dir = path.dirname(ff);
  const base = path.basename(ff).replace(/ffmpeg/i, 'ffprobe');
  return dir === '.' ? base : path.join(dir, base);
}

interface RunResult {
  code: number;
  stderr: string;
}

function run(
  bin: string,
  args: string[],
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ code: -1, stderr: 'aborted' });
      return;
    }
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let buf = '';
    // Bei Abbruch den ffmpeg-Prozess hart beenden.
    const onAbort = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (onLine) {
        // ffmpeg überschreibt die Fortschrittszeile mit \r -> auf \r und \n splitten.
        buf += text;
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop() ?? '';
        for (const p of parts) {
          const line = p.trim();
          if (line) onLine(line);
        }
      }
    });
    child.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (onLine && buf.trim()) onLine(buf.trim());
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/**
 * Prüft per ffprobe, ob die Datei mindestens einen Audio-Stream besitzt.
 * Bei Fehlern wird konservativ "kein Audio" angenommen.
 */
export async function probeHasAudio(input: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      ffprobePath(),
      [
        '-v', 'error',
        '-select_streams', 'a',
        '-show_entries', 'stream=index',
        '-of', 'csv=p=0',
        input,
      ],
      { windowsHide: true },
    );
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.on('error', () => resolve(false));
    child.on('close', () => resolve(stdout.trim().length > 0));
  });
}

/**
 * Baut eine atempo-Filterkette für einen beliebigen Geschwindigkeitsfaktor.
 * atempo akzeptiert pro Instanz nur 0.5–2.0, daher wird der Faktor zerlegt.
 */
export function atempoChain(speed: number): string {
  const factors: number[] = [];
  let remaining = speed;
  while (remaining > 2.0) {
    factors.push(2.0);
    remaining /= 2.0;
  }
  while (remaining < 0.5) {
    factors.push(0.5);
    remaining /= 0.5;
  }
  factors.push(remaining);
  return factors.map((f) => `atempo=${f.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`).join(',');
}

export interface SegmentSpec {
  start: number;
  end: number;
  speed: number;
}

/**
 * Extrahiert einen Bereich [start, end] und beschleunigt ihn um `speed`.
 * Folgt dem Muster aus scripts/ffmpeg_speedup_part.bat bzw. ffmpeg_range_and_speedup.bat.
 */
/** Mögliche Standard-Schriftdateien je Plattform (erste vorhandene wird genutzt). */
function defaultFontCandidates(): string[] {
  switch (process.platform) {
    case 'win32':
      return ['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/arial.ttf'];
    case 'darwin':
      return [
        '/System/Library/Fonts/Menlo.ttc',
        '/System/Library/Fonts/SFNSMono.ttf',
        '/System/Library/Fonts/Supplemental/Courier New.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/Library/Fonts/Arial.ttf',
      ];
    default: // linux & sonstige
      return [
        '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
        '/usr/share/fonts/TTF/DejaVuSansMono.ttf',
        '/usr/share/fonts/dejavu/DejaVuSansMono.ttf',
      ];
  }
}

/** Schriftdatei fürs Zeit-Overlay (per .env überschreibbar, sonst plattformabhängig). */
function overlayFontFile(): string {
  const explicit = process.env.OVERLAY_FONTFILE?.trim();
  if (explicit) return explicit;
  const candidates = defaultFontCandidates();
  return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
}

/**
 * drawtext-Filter, der die laufende ORIGINAL-Zeit als hh:mm:ss.zehntel oben rechts einblendet.
 * Nutzt die Frame-Zeit `t`; muss VOR dem setpts (Speed/Reset) angewandt werden, damit `t`
 * die unveränderten Originalzeitstempel trägt.
 */
function drawtextOriginalTime(): string {
  // Logischer Text mit echten ":" und ",". Wird danach für filter_complex escaped:
  // Im filter_complex muss ":" als "\\:" (zwei Ebenen) und "," als "\," kodiert werden,
  // damit weder Graph- noch drawtext-Parser fälschlich splitten.
  const logical =
    '%{eif:floor(t/3600):d:2}:' + // hh
    '%{eif:floor(mod(t,3600)/60):d:2}:' + // mm
    '%{eif:floor(mod(t,60)):d:2}.' + // ss
    '%{eif:floor(mod(t*10,10)):d:1}'; // Zehntel
  const text = logical.replace(/:/g, '\\\\:').replace(/,/g, '\\,');
  const font = overlayFontFile().replace(/\\/g, '/').replace(/:/g, '\\\\:');
  return (
    `drawtext=fontfile=${font}:text=${text}` +
    ':x=w-tw-20:y=20:fontsize=28:fontcolor=white:borderw=2:bordercolor=black'
  );
}

export async function extractSegment(
  input: string,
  output: string,
  seg: SegmentSpec,
  withAudio: boolean,
  overlayTime: boolean,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const { start, end, speed } = seg;
  if (overlayTime) {
    const f = overlayFontFile();
    if (!existsSync(f)) {
      throw new Error(
        `Schriftdatei für das Zeit-Overlay nicht gefunden: "${f}". ` +
          `Bitte OVERLAY_FONTFILE in backend/.env auf eine vorhandene .ttf/.ttc-Datei setzen.`,
      );
    }
  }
  // drawtext nach dem trim (nur relevante Frames), aber vor setpts (Originalzeit erhalten).
  const overlay = overlayTime ? `,${drawtextOriginalTime()}` : '';
  const vChain = `[0:v]trim=start=${start}:end=${end}${overlay},setpts=(PTS-STARTPTS)/${speed}[v]`;

  let args: string[];
  if (withAudio) {
    const aChain = `[0:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,${atempoChain(speed)}[a]`;
    args = [
      '-y',
      '-i', input,
      '-filter_complex', `${vChain};${aChain}`,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      output,
    ];
  } else {
    args = [
      '-y',
      '-i', input,
      '-filter_complex', vChain,
      '-map', '[v]',
      '-an',
      '-c:v', 'libx264',
      output,
    ];
  }

  const { code, stderr } = await run(ffmpegPath(), args, onLine, signal);
  if (signal?.aborted) throw new Error('abgebrochen');
  if (code !== 0) {
    throw new Error(`ffmpeg (Segment) fehlgeschlagen (Code ${code}):\n${tail(stderr)}`);
  }
}

/**
 * Fügt mehrere Clips per concat-Demuxer zusammen (analog scripts/ffmpeg_merge.bat).
 * Erwartet, dass alle Clips dieselben Codec-Parameter besitzen (-c copy).
 */
export async function mergeSegments(
  files: string[],
  output: string,
  onLine?: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  if (files.length === 0) throw new Error('Keine Clips zum Zusammenfügen.');

  // concat-Demuxer liest eine Liste; wir übergeben sie über stdin via "pipe".
  // Stattdessen schreiben wir eine Liste mit absoluten Pfaden in eine temporäre Datei.
  const fs = await import('node:fs/promises');
  const listPath = path.join(path.dirname(output), 'filelist.txt');
  const listContent = files
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/')}'`)
    .join('\n');
  await fs.writeFile(listPath, listContent, 'utf8');

  const { code, stderr } = await run(
    ffmpegPath(),
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output],
    onLine,
    signal,
  );

  await fs.rm(listPath, { force: true });

  if (signal?.aborted) throw new Error('abgebrochen');
  if (code !== 0) {
    throw new Error(`ffmpeg (Merge) fehlgeschlagen (Code ${code}):\n${tail(stderr)}`);
  }
}

function tail(s: string, lines = 15): string {
  return s.trim().split('\n').slice(-lines).join('\n');
}
