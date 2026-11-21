/**
 * Auto-captions: what's said, burned in as short reel-style chunks. Gemini gets the WORDS right, but its
 * word timestamps drift by seconds (measured), so timing comes from the audio itself: each sentence (from
 * the first watch's transcript, or a fresh transcription for clips that have none) is snapped to the speech
 * around it (ffmpeg silencedetect), and its words are spread over the voiced stretches by length. The timed
 * words are cached per clip; each version maps them through its cut (moves, trims, mutes, transitions).
 */
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import { promisify } from 'node:util';
import { q } from './db.js';
import type { Segment } from './edl.js';
// Type-only: gemini.ts imports this module for the revise schema, so the runtime import is lazy (below).
import type { Analysis } from './gemini.js';
import { errMsg, log } from './log.js';
import { OVERLAY_SIZES, OVERLAY_STYLES, type OverlaySize, type OverlayStyle, type TimedOverlay } from './overlays.js';
import { cachePath, ensureDir, ensureLocal } from './store.js';
import { timeline, type Transition } from './transitions.js';

const execFileP = promisify(execFile);

export interface Word { w: string; startMs: number; endMs: number }
export interface Sentence { text: string; startMs: number; endMs: number }
export interface Chunk { text: string; startMs: number; endMs: number }
type Span = [number, number];

export const CAPTION_POSITIONS = ['bottom', 'middle', 'top'] as const;
export type CaptionPosition = (typeof CAPTION_POSITIONS)[number];
export interface Captions { style: OverlayStyle; position: CaptionPosition; size: OverlaySize }
const POSITION_Y: Record<CaptionPosition, number> = { bottom: 0.72, middle: 0.5, top: 0.24 };

/** The model's captions request: null = unchanged, false = off, Captions = on (defaults filled in). */
export function normalizeCaptions(raw: unknown): Captions | false | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.enabled === false) return false;
  return {
    style: OVERLAY_STYLES.includes(r.style as OverlayStyle) ? r.style as OverlayStyle : 'clean',
    position: CAPTION_POSITIONS.includes(r.position as CaptionPosition) ? r.position as CaptionPosition : 'bottom',
    size: OVERLAY_SIZES.includes(r.size as OverlaySize) ? r.size as OverlaySize : 'medium',
  };
}

// ---------------------------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------------------------

/** Voiced stretches of a file: everything between silences (≥ 200 ms below -35 dB). */
export async function speechSpans(file: string, durationMs: number): Promise<Span[]> {
  const { stderr } = await execFileP('ffmpeg', ['-hide_banner', '-i', file, '-vn', '-af', 'silencedetect=noise=-35dB:d=0.2', '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 });
  return spansBetween(silencesIn(stderr, durationMs), durationMs);
}

export function silencesIn(ffmpegLog: string, durationMs: number): Span[] {
  const silences: Span[] = [];
  let open: number | null = null;
  for (const m of ffmpegLog.matchAll(/silence_(start|end): ([\d.]+)/g)) {
    const ms = Math.round(Number(m[2]) * 1000);
    if (m[1] === 'start') open = ms;
    else if (open !== null) { silences.push([open, ms]); open = null; }
  }
  if (open !== null) silences.push([open, durationMs]);
  return silences;
}

export function spansBetween(silences: Span[], durationMs: number): Span[] {
  const spans: Span[] = [];
  let at = 0;
  for (const [a, b] of silences) { if (a - at >= 60) spans.push([at, a]); at = Math.max(at, b); }
  if (durationMs - at >= 60) spans.push([at, durationMs]);
  return spans;
}

/** Rough speaking time of a word: its letters and digits, plus a beat. */
const weight = (w: string) => Math.max(2, (w.match(/[\p{L}\p{N}]/gu) ?? []).length) + 1;
const nearestIndex = (values: number[], target: number) => values.reduce((best, v, i) => (Math.abs(v - target) < Math.abs(values[best] - target) ? i : best), 0);

/** Words spread over voiced pieces by length (each word's share of the speaking time). */
function spread(words: string[], voiced: Span[]): Word[] {
  if (!words.length || !voiced.length) return [];
  const total = voiced.reduce((t, [x, y]) => t + (y - x), 0);
  const at = (frac: number) => {
    let left = frac * total;
    for (const [x, y] of voiced) {
      if (left <= y - x) return x + left;
      left -= y - x;
    }
    return voiced[voiced.length - 1][1];
  };
  const totalWeight = words.reduce((t, w) => t + weight(w), 0);
  let acc = 0;
  return words.map((w) => {
    const startMs = Math.round(at(acc / totalWeight));
    acc += weight(w);
    return { w, startMs, endMs: Math.round(at(acc / totalWeight)) };
  });
}

/**
 * A clip's words timed to its real speech. Sentence ends almost always fall on pauses, so each sentence
 * gets a run of consecutive voiced spans; a small DP picks the runs whose speaking time best matches each
 * sentence's length, nudged toward Gemini's rough sentence times. Then words spread inside their run.
 */
export function alignClip(all: Sentence[], spans: Span[]): Word[] {
  // Drop empty entries first, so every index below means the same sentence in both lists.
  const sentences = all.filter((x) => typeof x?.text === 'string' && x.text.trim());
  const said = sentences.map((x) => x.text.split(/\s+/).filter(Boolean));
  const n = said.length;
  if (!n || !spans.length) return [];
  const first = nearestIndex(spans.map(([a]) => a), sentences[0].startMs);
  const last = Math.max(first, nearestIndex(spans.map(([, b]) => b), sentences[sentences.length - 1].endMs));
  const run = spans.slice(first, last + 1);
  if (run.length < n) return spread(said.flat(), run); // fewer pauses than sentences: one stretch
  const len = run.map(([a, b]) => b - a);
  const voicedTotal = len.reduce((t, x) => t + x, 0);
  const weights = said.map((w) => w.reduce((t, x) => t + weight(x), 0));
  const totalWeight = weights.reduce((t, x) => t + x, 0);
  const prefix = [0];
  for (const x of len) prefix.push(prefix[prefix.length - 1] + x);
  const voiced = (from: number, to: number) => prefix[to + 1] - prefix[from];
  const cost = (j: number, from: number, to: number) =>
    Math.abs(voiced(from, to) - (weights[j] / totalWeight) * voicedTotal) + 0.5 * Math.abs(sentences[j].startMs - run[from][0]);
  // best[j][t]: sentences 0..j cover spans 0..t; back[j][t]: where sentence j starts.
  const m = run.length;
  const best = Array.from({ length: n }, () => new Array<number>(m).fill(Infinity));
  const back = Array.from({ length: n }, () => new Array<number>(m).fill(0));
  for (let t = 0; t < m; t++) best[0][t] = cost(0, 0, t);
  for (let j = 1; j < n; j++) {
    for (let t = j; t < m; t++) {
      for (let from = j; from <= t; from++) {
        const c = best[j - 1][from - 1] + cost(j, from, t);
        if (c < best[j][t]) { best[j][t] = c; back[j][t] = from; }
      }
    }
  }
  const words: Word[][] = new Array(n);
  let to = m - 1;
  for (let j = n - 1; j >= 0; j--) {
    const from = j === 0 ? 0 : back[j][to];
    words[j] = spread(said[j], run.slice(from, to + 1));
    to = from - 1;
  }
  return words.flat();
}

/**
 * A clip's timed words, aligned once and cached on the source row. Veo shots have no speech; an
 * Omni-edited clip keeps the original audio but has no transcript of its own, so it's transcribed.
 */
export async function wordsFor(source: any, analysis: Analysis | null): Promise<Word[]> {
  if (Array.isArray(source.words)) return source.words;
  let words: Word[] = [];
  const veo = source.generated && !/^AI-edited/.test(source.name ?? '');
  if (!veo && source.has_audio !== false) {
    const file = await ensureLocal(source.norm_key);
    const spans = await speechSpans(file, source.duration_ms);
    let sentences: Sentence[] = (analysis?.transcript ?? []).filter((t) => t.clipId === source.clip_id);
    if (!sentences.length && spans.length) {
      const mp3 = cachePath(`tmp/captions/${source.id}.mp3`);
      await ensureDir(mp3);
      try {
        await execFileP('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', mp3], { timeout: 60_000 });
        const { transcribeAudio } = await import('./gemini.js');
        const text = (await transcribeAudio(await fsp.readFile(mp3))).trim();
        if (text) sentences = [{ text, startMs: spans[0][0], endMs: spans[spans.length - 1][1] }];
      } catch (err) {
        log('captions', { source: source.id, transcribe: 'failed', error: errMsg(err).slice(0, 200) }, 'warn');
      } finally {
        await fsp.rm(mp3, { force: true });
      }
    }
    words = alignClip(sentences, spans);
  }
  await q(`UPDATE sticky.sources SET words = $2 WHERE id = $1`, [source.id, JSON.stringify(words)]);
  log('captions', { source: source.id, clip: source.clip_id, words: words.length });
  return words;
}

// ---------------------------------------------------------------------------------------------
// Chunking onto the cut
// ---------------------------------------------------------------------------------------------

const MAX_WORDS = 3;
const MAX_CHARS = 18;
const BREAK_GAP_MS = 350;
const HOLD_MS = 400;
const MIN_MS = 300;
const LINGER_MS = 150;

/** The cut's captions: words that play (unmuted shots only) moved onto the output timeline, in chunks. */
export function captionChunks(segments: Segment[], transitions: Transition[], wordsByClip: Record<string, Word[]>): Chunk[] {
  const t = timeline(segments, transitions);
  const chunks: Chunk[] = [];
  segments.forEach((s, i) => {
    if (s.audio === 'mute') return;
    const words = (wordsByClip[s.clipId] ?? [])
      .filter((w) => { const mid = (w.startMs + w.endMs) / 2; return mid >= s.inMs && mid < s.outMs; })
      .map((w) => ({ w: w.w, startMs: Math.max(t.starts[i], t.starts[i] + w.startMs - s.inMs), endMs: Math.min(t.ends[i], t.starts[i] + w.endMs - s.inMs) }));
    let cur: typeof words = [];
    const flush = () => {
      if (!cur.length) return;
      chunks.push({ text: cur.map((w) => w.w).join(' ').replace(/[.,;:]+$/, ''), startMs: cur[0].startMs, endMs: cur[cur.length - 1].endMs });
      cur = [];
    };
    for (const w of words) {
      const last = cur[cur.length - 1];
      const chars = cur.reduce((n, x) => n + x.w.length + 1, 0) + w.w.length;
      if (last && (cur.length >= MAX_WORDS || chars > MAX_CHARS || w.startMs - last.endMs > BREAK_GAP_MS || /[.,!?;:]$/.test(last.w))) flush();
      cur.push(w);
    }
    flush();
  });
  // Hold each chunk until the next when it's close (no flicker); never overlap, never past the end.
  chunks.sort((a, b) => a.startMs - b.startMs);
  chunks.forEach((c, k) => {
    const next = chunks[k + 1];
    const until = next && next.startMs - c.endMs < HOLD_MS ? next.startMs : c.endMs + LINGER_MS;
    c.endMs = Math.min(Math.max(c.startMs + MIN_MS, until), next ? next.startMs : t.totalMs, t.totalMs);
  });
  return chunks.filter((c) => c.text && c.endMs > c.startMs);
}

/** Chunks as text overlays (with their own time windows) for burnOverlays. */
export function captionOverlays(chunks: Chunk[], captions: Captions): TimedOverlay[] {
  return chunks.map((c, k) => ({
    overlay: { id: `cap${k + 1}`, kind: 'text', text: c.text, emoji: null, segmentId: null, x: 0.5, y: POSITION_Y[captions.position], size: captions.size, style: captions.style, animation: 'pop' },
    startMs: c.startMs,
    endMs: c.endMs,
  }));
}
