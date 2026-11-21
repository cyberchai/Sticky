import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyOps, normalizeSegments, totalMs, validateSegments, type ClipInfo, type Segment } from '../src/edl.js';

const clips: ClipInfo[] = [
  { clipId: 'c1', durationMs: 10_000, hasAudio: true },
  { clipId: 'c2', durationMs: 8_000, hasAudio: false },
];
const base: Segment[] = [
  { id: 's1', clipId: 'c1', inMs: 4_000, outMs: 7_000, audio: 'keep' },
  { id: 's2', clipId: 'c2', inMs: 1_000, outMs: 5_000, audio: 'keep' },
  { id: 's3', clipId: 'c1', inMs: 8_000, outMs: 10_000, audio: 'keep' },
];

test('valid timeline passes', () => {
  assert.deepEqual(validateSegments(base, clips), []);
  assert.equal(totalMs(base), 9_000);
});

test('unknown clip, out of bounds, too short, duplicate id are all reported', () => {
  const errors = validateSegments([
    { id: 's1', clipId: 'c9', inMs: 0, outMs: 3000, audio: 'keep' },
    { id: 's2', clipId: 'c1', inMs: 9000, outMs: 12000, audio: 'keep' },
    { id: 's2', clipId: 'c2', inMs: 100, outMs: 300, audio: 'keep' },
  ], clips);
  assert.ok(errors.some((e) => e.includes('unknown clipId')));
  assert.ok(errors.some((e) => e.includes('> c1 duration')));
  assert.ok(errors.some((e) => e.includes('< 400ms')));
  assert.ok(errors.some((e) => e.includes('duplicate segment id')));
});

test('total length bounds: 6s minimum unless the footage is shorter, 20s maximum', () => {
  const short = [{ id: 's1', clipId: 'c1', inMs: 0, outMs: 3000, audio: 'keep' as const }];
  assert.ok(validateSegments(short, clips).some((e) => e.includes('< minimum')));
  const tiny: ClipInfo[] = [{ clipId: 'c1', durationMs: 4_000, hasAudio: true }];
  assert.deepEqual(validateSegments([{ id: 's1', clipId: 'c1', inMs: 200, outMs: 3_950, audio: 'keep' }], tiny), []);
  const long = Array.from({ length: 3 }, (_, i) => ({ id: `s${i + 1}`, clipId: 'c1', inMs: 0, outMs: 8_000, audio: 'keep' as const }));
  assert.ok(validateSegments(long, clips).some((e) => e.includes('> maximum')));
});

test('move reorders without touching boundaries', () => {
  const { segments, errors } = applyOps(base, [{ op: 'move', id: 's3', toIndex: 0 }]);
  assert.deepEqual(errors, []);
  assert.deepEqual(segments.map((s) => s.id), ['s3', 's1', 's2']);
  assert.deepEqual(segments.find((s) => s.id === 's1'), base[0]);
});

test('set_audio mutes only the named segment', () => {
  const { segments } = applyOps(base, [{ op: 'set_audio', id: 's2', audio: 'mute' }]);
  assert.equal(segments[1].audio, 'mute');
  assert.equal(segments[0].audio, 'keep');
  assert.equal(segments[2].audio, 'keep');
});

test('trim, remove, insert; inserted ids continue the sequence', () => {
  const { segments, errors } = applyOps(base, [
    { op: 'trim', id: 's2', outMs: 3_000 },
    { op: 'remove', id: 's3' },
    { op: 'insert', clipId: 'c1', inMs: 0, outMs: 1_500, audio: 'keep', atIndex: 0 },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(segments.map((s) => s.id), ['s4', 's1', 's2']);
  assert.equal(segments[2].outMs, 3_000);
  assert.equal(segments[1].inMs, 4_000);
});

test('ops on unknown ids are errors, not silent no-ops', () => {
  const { errors } = applyOps(base, [{ op: 'move', id: 's9', toIndex: 0 }, { op: 'remove', id: 'nope' }]);
  assert.equal(errors.length, 2);
});

test('normalizeSegments coerces model output', () => {
  const segs = normalizeSegments([{ id: 's1', clipId: 'c1', inMs: '1400.4', outMs: 3700, audio: 'whatever' }]);
  assert.deepEqual(segs, [{ id: 's1', clipId: 'c1', inMs: 1400, outMs: 3700, audio: 'keep' }]);
});
