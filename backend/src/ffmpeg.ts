import { spawn } from 'node:child_process';
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

function run(bin: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
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
export async function extractSegment(
  input: string,
  output: string,
  seg: SegmentSpec,
  withAudio: boolean,
): Promise<void> {
  const { start, end, speed } = seg;
  const vChain = `[0:v]trim=start=${start}:end=${end},setpts=(PTS-STARTPTS)/${speed}[v]`;

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

  const { code, stderr } = await run(ffmpegPath(), args);
  if (code !== 0) {
    throw new Error(`ffmpeg (Segment) fehlgeschlagen (Code ${code}):\n${tail(stderr)}`);
  }
}

/**
 * Fügt mehrere Clips per concat-Demuxer zusammen (analog scripts/ffmpeg_merge.bat).
 * Erwartet, dass alle Clips dieselben Codec-Parameter besitzen (-c copy).
 */
export async function mergeSegments(files: string[], output: string): Promise<void> {
  if (files.length === 0) throw new Error('Keine Clips zum Zusammenfügen.');

  // concat-Demuxer liest eine Liste; wir übergeben sie über stdin via "pipe".
  // Stattdessen schreiben wir eine Liste mit absoluten Pfaden in eine temporäre Datei.
  const fs = await import('node:fs/promises');
  const listPath = path.join(path.dirname(output), 'filelist.txt');
  const listContent = files
    .map((f) => `file '${path.resolve(f).replace(/\\/g, '/')}'`)
    .join('\n');
  await fs.writeFile(listPath, listContent, 'utf8');

  const { code, stderr } = await run(ffmpegPath(), [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    output,
  ]);

  await fs.rm(listPath, { force: true });

  if (code !== 0) {
    throw new Error(`ffmpeg (Merge) fehlgeschlagen (Code ${code}):\n${tail(stderr)}`);
  }
}

function tail(s: string, lines = 15): string {
  return s.trim().split('\n').slice(-lines).join('\n');
}
