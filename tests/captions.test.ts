import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignClip, captionChunks, normalizeCaptions, silencesIn, spansBetween, type Sentence } from '../src/captions.js';
import type { Segment } from '../src/edl.js';

// Measured on the test clip (ffmpeg silencedetect -35 dB, 0.2 s): speech between these pauses.
const spans = spansBetween([[0, 3028], [3413, 3734], [4459, 4820], [5312, 5644], [8453, 8784], [11272, 11614], [13782, 16021]], 16021);
const text = ['Okay, is it recording? Hold on.', "So here's the thing nobody tells you about opening a cafe.", 'The first customer is the hardest one you will ever get.', "After that, it's just showing up every morning."];
const at = (s: Array<[number, number]>): Sentence[] => s.map(([startMs, endMs], i) => ({ text: text[i], startMs, endMs }));
const onset = (words: ReturnType<typeof alignClip>, w: string) => words.find((x) => x.w === w)!.startMs;

test('silencedetect output becomes the voiced spans between pauses', () => {
  const log = '[silencedetect] silence_start: 0\n[silencedetect] silence_end: 3.028 | silence_duration: 3.028\n[silencedetect] silence_start: 13.782';
  assert.deepEqual(spansBetween(silencesIn(log, 16021), 16021), [[3028, 13782]]);
  assert.deepEqual(spans[0], [3028, 3413]);
});

test('each sentence lands on its real speech onset, even when Gemini\'s sentence times are off', () => {
  for (const guess of [
    at([[3000, 5000], [5000, 8150], [8150, 11100], [11100, 13500]]),
    at([[3000, 4900], [4900, 8000], [8000, 10850], [10850, 13600]]), // the run that put words ~0.5 s early
  ]) {
    const words = alignClip(guess, spans);
    assert.equal(words.length, 36);
    assert.equal(onset(words, 'Okay,'), 3028);
    assert.equal(onset(words, 'So'), 5644);
    assert.equal(onset(words, 'The'), 8784);
    assert.equal(onset(words, 'After'), 11614);
    assert.equal(words[words.length - 1].endMs, 13782);
    assert.ok(words.every((w, i) => i === 0 || w.startMs >= words[i - 1].startMs));
  }
});

test('chunks follow the cut: reordered shots, muted shots skipped, short and non-overlapping', () => {
  const words = alignClip(at([[3000, 5000], [5000, 8150], [8150, 11100], [11100, 13500]]), spans);
  const cut: Segment[] = [
    { id: 's1', clipId: 'c1', inMs: 8600, outMs: 11300, audio: 'keep' },
    { id: 's2', clipId: 'c1', inMs: 5500, outMs: 8500, audio: 'mute' },
    { id: 's3', clipId: 'c1', inMs: 11400, outMs: 13800, audio: 'keep' },
  ];
  const chunks = captionChunks(cut, [], { c1: words });
  assert.ok(chunks[0].text.startsWith('The first'), chunks[0].text);
  assert.ok(!chunks.some((c) => /cafe|nobody/.test(c.text)), 'muted shot has no captions');
  assert.ok(chunks.some((c) => c.text.startsWith('After that')));
  assert.equal(chunks[0].startMs, 8784 - 8600);
  for (const [k, c] of chunks.entries()) {
    assert.ok(c.text.split(' ').length <= 3, c.text);
    assert.ok(c.endMs > c.startMs);
    if (chunks[k + 1]) assert.ok(c.endMs <= chunks[k + 1].startMs);
  }
});

test('caption settings: null keeps, false turns off, defaults fill in', () => {
  assert.equal(normalizeCaptions(null), null);
  assert.equal(normalizeCaptions({ enabled: false }), false);
  assert.deepEqual(normalizeCaptions({ enabled: true, style: 'box' }), { style: 'box', position: 'bottom', size: 'medium' });
});

test('empty or missing transcript entries are skipped without shifting the others', () => {
  const guess = at([[3000, 5000], [5000, 8150], [8150, 11100], [11100, 13500]]);
  const withGaps = [guess[0], { text: '', startMs: 4000, endMs: 4500 }, guess[1], { startMs: 0, endMs: 0 } as any, guess[2], guess[3]];
  assert.deepEqual(alignClip(withGaps, spans), alignClip(guess, spans));
});
