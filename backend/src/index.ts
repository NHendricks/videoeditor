import 'dotenv/config';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { stream } from 'hono/streaming';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  extractSegment,
  mergeSegments,
  probeHasAudio,
  ffmpegPath,
  type SegmentSpec,
} from './ffmpeg.js';

const PORT = Number(process.env.PORT) || 3000;
const VIDEO_EXT = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'];

// Verzeichnisse relativ zum Backend-Root (cwd = backend/).
const VIDEOS_DIR = path.resolve('videos');
const OUTPUT_DIR = path.resolve('videos', 'output');

const app = new Hono();
app.use('*', cors());

/** Liefert Quell- und generierte Videos unter /videos/... aus. */
app.use('/videos/*', serveStatic({ root: './' }));

/** Verfügbare Quellvideos (Top-Level im videos-Ordner, ohne den output-Unterordner). */
app.get('/api/videos', async (c) => {
  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  const entries = await fs.readdir(VIDEOS_DIR, { withFileTypes: true });
  const videos = entries
    .filter((e) => e.isFile() && VIDEO_EXT.includes(path.extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return c.json({ videos });
});

/** Erzeugt einen sicheren, kollisionsfreien Dateinamen im videos-Ordner. */
async function safeTargetName(original: string): Promise<string> {
  const base = path.basename(original).replace(/[^a-zA-Z0-9._ -]/g, '_');
  const ext = path.extname(base).toLowerCase();
  const stem = path.basename(base, ext) || 'video';
  let name = `${stem}${ext}`;
  let i = 1;
  // Vorhandene Datei nicht überschreiben.
  while (true) {
    try {
      await fs.access(path.join(VIDEOS_DIR, name));
      name = `${stem}_${i++}${ext}`;
    } catch {
      return name;
    }
  }
}

/** Nimmt ein hochgeladenes Video entgegen und speichert es im videos-Ordner. */
app.post('/api/upload', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.parseBody();
  } catch {
    return c.json({ error: 'Upload konnte nicht gelesen werden.' }, 400);
  }
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'Kein Feld "file" im Upload.' }, 400);
  }
  const ext = path.extname(file.name).toLowerCase();
  if (!VIDEO_EXT.includes(ext)) {
    return c.json(
      { error: `Nicht unterstütztes Format "${ext}". Erlaubt: ${VIDEO_EXT.join(', ')}` },
      400,
    );
  }

  await fs.mkdir(VIDEOS_DIR, { recursive: true });
  const name = await safeTargetName(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  await fs.writeFile(path.join(VIDEOS_DIR, name), buffer);

  return c.json({ file: name });
});

interface ProcessBody {
  source: string;
  segments: SegmentSpec[];
  overlayTime?: boolean;
}

/**
 * Erstellt aus den definierten Bereichen je einen separaten Clip und fügt sie
 * anschließend zu einem Gesamtvideo zusammen.
 */
app.post('/api/process', async (c) => {
  let body: ProcessBody;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Ungültiger JSON-Body.' }, 400);
  }

  const { source, segments } = body;
  const overlayTime = body.overlayTime === true;

  // --- Validierung ---
  if (!source || typeof source !== 'string') {
    return c.json({ error: 'Feld "source" fehlt.' }, 400);
  }
  // Pfad-Traversal verhindern.
  if (source.includes('/') || source.includes('\\') || source.includes('..')) {
    return c.json({ error: 'Ungültiger Dateiname.' }, 400);
  }
  const inputPath = path.join(VIDEOS_DIR, source);
  try {
    await fs.access(inputPath);
  } catch {
    return c.json({ error: `Quellvideo "${source}" nicht gefunden.` }, 404);
  }
  if (!Array.isArray(segments) || segments.length === 0) {
    return c.json({ error: 'Mindestens ein Bereich ist erforderlich.' }, 400);
  }
  for (const [i, s] of segments.entries()) {
    if (
      typeof s.start !== 'number' ||
      typeof s.end !== 'number' ||
      typeof s.speed !== 'number' ||
      s.start < 0 ||
      s.end <= s.start ||
      s.speed <= 0
    ) {
      return c.json({ error: `Bereich ${i + 1} ist ungültig (start < end, speed > 0).` }, 400);
    }
  }

  // --- Verarbeitung (Fortschritt als NDJSON-Stream) ---
  const jobId = new Date().toISOString().replace(/[:.]/g, '-');
  const jobDir = path.join(OUTPUT_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
  c.header('Cache-Control', 'no-cache, no-transform');
  c.header('X-Accel-Buffering', 'no');

  return stream(c, async (s) => {
    const send = (ev: Record<string, unknown>) => s.writeln(JSON.stringify(ev));

    // Bei Client-Abbruch (Cancel/Verbindung getrennt) ffmpeg beenden.
    const ac = new AbortController();
    s.onAbort(() => ac.abort());
    c.req.raw.signal?.addEventListener('abort', () => ac.abort(), { once: true });

    try {
      const withAudio = await probeHasAudio(inputPath);
      const sourceBase = path.basename(source, path.extname(source));

      await send({ type: 'start', total: segments.length, withAudio });

      const segmentFiles: string[] = [];
      const segmentResults: { file: string; url: string; spec: SegmentSpec }[] = [];

      for (const [i, seg] of segments.entries()) {
        if (ac.signal.aborted) return;
        const name = `${sourceBase}_part${String(i + 1).padStart(3, '0')}.mp4`;
        const outPath = path.join(jobDir, name);
        // Erwartete Ausgabedauer für den Fortschrittsbalken im Frontend.
        const expected = (seg.end - seg.start) / seg.speed;
        await send({ type: 'step', step: 'segment', index: i + 1, total: segments.length, expected });
        await extractSegment(
          inputPath,
          outPath,
          seg,
          withAudio,
          overlayTime,
          (line) => void send({ type: 'log', line }),
          ac.signal,
        );
        segmentFiles.push(outPath);
        segmentResults.push({ file: name, url: `/videos/output/${jobId}/${name}`, spec: seg });
      }

      let merged: { file: string; url: string } | null = null;
      if (segmentFiles.length >= 1) {
        if (ac.signal.aborted) return;
        const mergedName = `${sourceBase}_merged.mp4`;
        const mergedPath = path.join(jobDir, mergedName);
        const expected = segments.reduce((sum, sg) => sum + (sg.end - sg.start) / sg.speed, 0);
        await send({ type: 'step', step: 'merge', expected });
        await mergeSegments(
          segmentFiles,
          mergedPath,
          (line) => void send({ type: 'log', line }),
          ac.signal,
        );
        merged = { file: mergedName, url: `/videos/output/${jobId}/${mergedName}` };
      }

      await send({ type: 'done', result: { jobId, withAudio, segments: segmentResults, merged } });
    } catch (err) {
      if (ac.signal.aborted) return; // Abbruch ist kein Fehler.
      const message = err instanceof Error ? err.message : String(err);
      await send({ type: 'error', message });
    }
  });
});

app.get('/api/health', (c) => c.json({ ok: true, ffmpeg: ffmpegPath() }));

await fs.mkdir(OUTPUT_DIR, { recursive: true });

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`videoeditor backend läuft auf http://localhost:${info.port}`);
  console.log(`ffmpeg: ${ffmpegPath()}`);
  console.log(`videos: ${VIDEOS_DIR}`);
});
