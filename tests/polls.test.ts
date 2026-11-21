import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Segment } from '../src/edl.js';
import { choicesStillNeeded, suggestions } from '../src/polls.js';

const seg = (id: string, ms: number): Segment => ({ id, clipId: 'c1', inMs: 0, outMs: ms, audio: 'keep' });
const talking = { transcript: [{ clipId: 'c1', startMs: 0, endMs: 2000, text: 'The first customer is the hardest.' }], moments: [] } as any;

test('a talking first cut gets captions, a pace-matched transition, music and a title', () => {
  const slow = suggestions({ segments: [seg('s1', 3000), seg('s2', 3000), seg('s3', 2700)], durationMs: 8700 }, talking);
  assert.deepEqual(slow.map((s) => s.label), ['Auto captions', 'Crossfade between shots', 'Add a music bed', 'Title from the hook']);
  const fast = suggestions({ segments: [seg('s1', 1200), seg('s2', 1300), seg('s3', 1100), seg('s4', 1400)], durationMs: 5000 }, talking);
  assert.equal(fast[1].label, 'Whip transitions');
});

test('what the cut already has is not offered again, and silent footage gets no captions or title', () => {
  const has = suggestions({ segments: [seg('s1', 6000), seg('s2', 6000)], durationMs: 12000, captions: { style: 'clean' }, transitions: [{}], music: { label: 'x' }, overlays: [{ kind: 'text' }] }, talking);
  assert.deepEqual(has.map((s) => s.label), ['Make it shorter']);
  const silent = suggestions({ segments: [seg('s1', 4000), seg('s2', 4000)], durationMs: 8000 }, { transcript: [], moments: [] } as any);
  assert.deepEqual(silent.map((s) => s.label), ['Crossfade between shots', 'Add a music bed']);
});

test('never more than four options, each with an instruction a revision understands', () => {
  const all = suggestions({ segments: [seg('s1', 6000), seg('s2', 6000)], durationMs: 12000 }, talking);
  assert.equal(all.length, 4);
  assert.ok(all.every((s) => s.label.length <= 25 && s.instruction.length > 10));
});

test('standing group picks: only the ones the cut does not already have', () => {
  const picks = [
    { label: 'Auto captions', instruction: 'Add auto captions.' },
    { label: 'Add a music bed', instruction: 'Add music.' },
    { label: 'Title from the hook', instruction: 'Add a title.' },
    { label: 'Crossfade between shots', instruction: 'Crossfade.' },
  ];
  const fresh = { captions: null, music: null, overlays: [], transitions: [] };
  assert.deepEqual(choicesStillNeeded(picks, fresh).map((c) => c.label), picks.map((c) => c.label));
  const carried = { captions: { style: 'bold' }, music: { key: 'm' }, overlays: [{ kind: 'text' }], transitions: [] };
  assert.deepEqual(choicesStillNeeded(picks, carried).map((c) => c.label), ['Crossfade between shots']);
});
