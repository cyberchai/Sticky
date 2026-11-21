/**
 * The edit decision list: pure functions, unit-tested. Milliseconds are relative to each clip's
 * normalized file. Revisions are applied as operations on existing segment ids, so a shot the
 * user did not mention keeps its exact boundaries.
 */
import { LIMITS } from './config.js';

export type Audio = 'keep' | 'mute';

export interface Segment {
  id: string;
  clipId: string;
  inMs: number;
  outMs: number;
  audio: Audio;
}

export interface ClipInfo {
  clipId: string;
  durationMs: number;
  hasAudio: boolean;
}

export const totalMs = (segments: Segment[]) => segments.reduce((sum, s) => sum + (s.outMs - s.inMs), 0);
export const usableMs = (clips: ClipInfo[]) => clips.reduce((sum, c) => sum + c.durationMs, 0);

/**
 * The shortest acceptable cut: 6s, shortening naturally for short footage (a 10s take that is half
 * setup may honestly be a 4s reel), but never below 40% of the footage or 2s.
 */
export function minTotalFor(clips: ClipInfo[]): number {
  const footage = usableMs(clips);
  return Math.min(LIMITS.minTotalMs, Math.max(2_000, Math.round(footage * 0.4)), footage);
}

/** Coerce model output into integers and known values; anything unusable stays visible to validate(). */
export function normalizeSegments(raw: unknown): Segment[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((r: any, i) => ({
    id: typeof r?.id === 'string' && r.id.trim() ? r.id.trim() : `s${i + 1}`,
    clipId: typeof r?.clipId === 'string' ? r.clipId.trim() : '',
    inMs: Math.round(Number(r?.inMs)),
    outMs: Math.round(Number(r?.outMs)),
    audio: r?.audio === 'mute' ? 'mute' : 'keep',
  }));
}

/** Every problem with a timeline, in words the model can act on when retried. Empty = valid. */
export function validateSegments(segments: Segment[], clips: ClipInfo[]): string[] {
  const errors: string[] = [];
  const byId = new Map(clips.map((c) => [c.clipId, c]));
  if (!segments.length) errors.push('segments is empty');
  if (segments.length > LIMITS.maxSegments) errors.push(`too many segments (${segments.length} > ${LIMITS.maxSegments})`);
  const seen = new Set<string>();
  for (const s of segments) {
    if (seen.has(s.id)) errors.push(`duplicate segment id ${s.id}`);
    seen.add(s.id);
    const clip = byId.get(s.clipId);
    if (!clip) { errors.push(`${s.id}: unknown clipId "${s.clipId}" (known: ${[...byId.keys()].join(', ')})`); continue; }
    if (!Number.isFinite(s.inMs) || !Number.isFinite(s.outMs)) { errors.push(`${s.id}: inMs/outMs must be integers`); continue; }
    if (s.inMs < 0) errors.push(`${s.id}: inMs ${s.inMs} < 0`);
    if (s.outMs > clip.durationMs) errors.push(`${s.id}: outMs ${s.outMs} > ${s.clipId} duration ${clip.durationMs}`);
    if (s.outMs - s.inMs < LIMITS.minSegmentMs) errors.push(`${s.id}: length ${s.outMs - s.inMs}ms < ${LIMITS.minSegmentMs}ms`);
  }
  const total = totalMs(segments);
  const min = minTotalFor(clips);
  if (segments.length && total < min) errors.push(`total ${total}ms < minimum ${min}ms`);
  if (total > LIMITS.maxTotalMs) errors.push(`total ${total}ms > maximum ${LIMITS.maxTotalMs}ms`);
  return errors;
}

export type OpName = 'move' | 'trim' | 'set_audio' | 'remove' | 'insert';

/** Flat shape (Gemini schemas have no tagged unions); applyOps checks each op's own fields. */
export interface Op {
  op: OpName;
  id?: string;
  toIndex?: number;
  inMs?: number;
  outMs?: number;
  audio?: Audio;
  clipId?: string;
  atIndex?: number;
}

const clampIndex = (i: number, len: number) => Math.max(0, Math.min(len, Math.round(i)));

const idNumber = (id: string) => Number(/^s(\d+)$/.exec(id)?.[1] ?? 0);

export function applyOps(segments: Segment[], ops: Op[]): { segments: Segment[]; errors: string[] } {
  const out = segments.map((s) => ({ ...s }));
  const errors: string[] = [];
  // New ids continue past every id the cut has had, so a removed id is never reused for a new shot.
  let lastId = segments.reduce((max, s) => Math.max(max, idNumber(s.id)), 0);
  const nextId = () => `s${++lastId}`;
  for (const [i, op] of ops.entries()) {
    const at = () => out.findIndex((s) => s.id === op.id);
    switch (op.op) {
      case 'move': {
        const idx = at();
        if (idx < 0 || op.toIndex === undefined) { errors.push(`op ${i} move: unknown id ${op.id} or missing toIndex`); break; }
        const [seg] = out.splice(idx, 1);
        out.splice(clampIndex(op.toIndex, out.length), 0, seg);
        break;
      }
      case 'trim': {
        const idx = at();
        if (idx < 0 || (op.inMs === undefined && op.outMs === undefined)) { errors.push(`op ${i} trim: unknown id ${op.id} or no new bounds`); break; }
        if (op.inMs !== undefined) out[idx].inMs = Math.round(op.inMs);
        if (op.outMs !== undefined) out[idx].outMs = Math.round(op.outMs);
        break;
      }
      case 'set_audio': {
        const idx = at();
        if (idx < 0) { errors.push(`op ${i} set_audio: unknown id ${op.id}`); break; }
        if (op.audio !== 'keep' && op.audio !== 'mute') { errors.push(`op ${i} set_audio: audio must be "keep" or "mute", got ${JSON.stringify(op.audio)} (op was ${JSON.stringify(op)})`); break; }
        out[idx].audio = op.audio;
        break;
      }
      case 'remove': {
        const idx = at();
        if (idx < 0) { errors.push(`op ${i} remove: unknown id ${op.id}`); break; }
        out.splice(idx, 1);
        break;
      }
      case 'insert': {
        if (!op.clipId || op.inMs === undefined || op.outMs === undefined) { errors.push(`op ${i} insert: needs clipId, inMs, outMs`); break; }
        const seg: Segment = { id: nextId(), clipId: op.clipId, inMs: Math.round(op.inMs), outMs: Math.round(op.outMs), audio: op.audio === 'mute' ? 'mute' : 'keep' };
        out.splice(clampIndex(op.atIndex ?? out.length, out.length), 0, seg);
        break;
      }
      default:
        errors.push(`op ${i}: unknown op "${(op as Op).op}"`);
    }
  }
  return { segments: out, errors };
}

export function fmtMs(ms: number): string {
  const s = Math.max(0, Math.round(ms / 100) / 10);
  const m = Math.floor(s / 60);
  const rest = (s - m * 60).toFixed(1).padStart(4, '0');
  return `${m}:${rest}`;
}
