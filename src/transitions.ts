/**
 * Transitions between shots ("crossfade into the reveal", "slide between every shot"). Each one is the
 * transition INTO a shot from the shot before it, keyed by the shot's id, so it follows that shot through
 * later moves and trims. They are ffmpeg's xfade presets (video) with a matching acrossfade (audio), so
 * picture and sound stay in sync; each one overlaps two shots and shortens the reel by its length.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Segment } from './edl.js';
import { CANVAS } from './media.js';

const execFileP = promisify(execFile);

/** Friendly name → ffmpeg xfade preset (all present in ffmpeg 5.x and later). */
export const TRANSITIONS = {
  crossfade: 'fade',
  dissolve: 'dissolve',
  dip_to_black: 'fadeblack',
  dip_to_white: 'fadewhite',
  slide_left: 'slideleft',
  slide_right: 'slideright',
  slide_up: 'slideup',
  slide_down: 'slidedown',
  wipe: 'wipeleft',
  zoom: 'zoomin',
  circle: 'circleopen',
  whip: 'smoothleft',
} as const;
export type TransitionType = keyof typeof TRANSITIONS;
export const TRANSITION_TYPES = Object.keys(TRANSITIONS) as TransitionType[];

export interface Transition { segmentId: string; type: TransitionType; ms: number }

export const DEFAULT_TRANSITION_MS = 350;
const MIN_MS = 150;
const MAX_MS = 1000;

/**
 * The model's list, checked against the cut: known type, a shot that exists and isn't first, one per shot,
 * and short enough to fit inside both shots it joins (at most 40% of the shorter one).
 */
export function normalizeTransitions(raw: unknown, segments: Segment[]): { transitions: Transition[]; errors: string[] } {
  if (!Array.isArray(raw)) return { transitions: [], errors: ['transitions must be a list'] };
  const errors: string[] = [];
  const index = new Map(segments.map((s, i) => [s.id, i]));
  const seen = new Set<string>();
  const transitions: Transition[] = [];
  for (const t of raw as any[]) {
    const id = String(t?.segmentId ?? '');
    const type = String(t?.type ?? '') as TransitionType;
    const i = index.get(id);
    if (!Object.hasOwn(TRANSITIONS, type)) { // not `in`: that also matches "constructor" and friends
      errors.push(`transition type "${type}" is not one of ${TRANSITION_TYPES.join(', ')}`); continue; }
    if (i === undefined) { errors.push(`transition into shot ${id}, which isn't in the cut`); continue; }
    if (i === 0) continue; // nothing comes before the first shot
    if (seen.has(id)) continue;
    seen.add(id);
    const shorter = Math.min(segments[i - 1].outMs - segments[i - 1].inMs, segments[i].outMs - segments[i].inMs);
    const asked = Number.isFinite(Number(t?.ms)) ? Math.round(Number(t.ms)) : DEFAULT_TRANSITION_MS;
    const ms = Math.min(MAX_MS, Math.max(MIN_MS, asked), Math.floor(shorter * 0.4));
    if (ms < MIN_MS) continue; // shots too short to blend; a hard cut it is
    transitions.push({ segmentId: id, type, ms });
  }
  return { transitions, errors };
}

/** Transitions whose shot still exists and still isn't first (after moves, removes and re-plans). */
export function keepTransitions(transitions: Transition[] | null | undefined, segments: Segment[]): Transition[] {
  return normalizeTransitions(transitions ?? [], segments).transitions;
}

/** Where each shot starts and ends on the output timeline, and the total length, once transitions overlap them. */
export function timeline(segments: Segment[], transitions: Transition[] = []): { starts: number[]; ends: number[]; totalMs: number } {
  const into = new Map(transitions.map((t) => [t.segmentId, t.ms]));
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  segments.forEach((s, i) => {
    const start = i === 0 ? 0 : at - (into.get(s.id) ?? 0);
    starts.push(start);
    at = start + (s.outMs - s.inMs);
    ends.push(at);
  });
  return { starts, ends, totalMs: at };
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/**
 * Like media.ts render() (same per-shot normalization and encoder settings), but joins shots with xfade +
 * acrossfade where a transition is set and with a plain concat where it isn't.
 */
export async function renderWithTransitions(segments: Segment[], transitions: Transition[], clipPaths: Record<string, string>, output: string): Promise<void> {
  if (!segments.length) throw new Error('no segments');
  const into = new Map(transitions.map((t) => [t.segmentId, t]));
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  segments.forEach((s) => {
    const file = clipPaths[s.clipId];
    if (!file) throw new Error(`no file for ${s.clipId}`);
    args.push('-ss', sec(s.inMs), '-t', sec(s.outMs - s.inMs), '-i', file);
  });
  const chains: string[] = [];
  segments.forEach((s, i) => {
    const d = (s.outMs - s.inMs) / 1000;
    const fade = Math.min(0.015, d / 4);
    chains.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${CANVAS.fps},format=yuv420p,settb=AVTB[v${i}]`);
    chains.push(
      `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,volume=${s.audio === 'mute' ? 0 : 1},`
      + `afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, d - fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`,
    );
  });
  // Fold left: [joined so far] + next shot; xfade starts the next shot where timeline() puts it.
  const { starts } = timeline(segments, transitions);
  let v = 'v0';
  let a = 'a0';
  for (let i = 1; i < segments.length; i++) {
    const t = into.get(segments[i].id);
    const nv = `jv${i}`;
    const na = `ja${i}`;
    if (t) {
      chains.push(`[${v}][v${i}]xfade=transition=${TRANSITIONS[t.type]}:duration=${sec(t.ms)}:offset=${sec(starts[i])}[${nv}]`);
      chains.push(`[${a}][a${i}]acrossfade=d=${sec(t.ms)}:c1=tri:c2=tri[${na}]`);
    } else {
      chains.push(`[${v}][${a}][v${i}][a${i}]concat=n=2:v=1:a=1[${nv}][${na}]`);
    }
    v = nv;
    a = na;
  }
  args.push(
    '-filter_complex', chains.join(';'),
    '-map', `[${v}]`, '-map', `[${a}]`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level:v', '4.1',
    '-pix_fmt', 'yuv420p', '-r', String(CANVAS.fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', output,
  );
  await execFileP('ffmpeg', args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
}
