import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Segment } from '../src/edl.js';
import { avoid, keepOverlays, markup, normalizeOverlays, notoName, overlayWindows, place } from '../src/overlays.js';
import { keepTransitions, normalizeTransitions, timeline } from '../src/transitions.js';

const seg = (id: string, ms: number): Segment => ({ id, clipId: 'c1', inMs: 0, outMs: ms, audio: 'keep' });
const cut = [seg('s1', 3000), seg('s2', 2000), seg('s3', 4000)];

test('text overlays keep the words, drop emoji, and default sensibly', () => {
  const { overlays, errors } = normalizeOverlays([{ kind: 'text', text: '  Animalliyah 🐶  ', segmentId: null }], cut);
  assert.deepEqual(errors, []);
  assert.equal(overlays[0].text, 'Animalliyah');
  assert.equal(overlays[0].style, 'clean');
  assert.equal(overlays[0].animation, 'fade');
  assert.equal(overlays[0].y, 0.18);
  assert.equal(overlays[0].id, 'o1');
});

test('stickers take one emoji; words or unknown shots are rejected for a retry', () => {
  const { overlays, errors } = normalizeOverlays([
    { kind: 'sticker', emoji: '❤️❤️', segmentId: 's2', x: 2, y: -1 },
    { kind: 'sticker', emoji: 'heart' },
    { kind: 'text', text: 'hi', segmentId: 's9' },
    { kind: 'text', text: '🔥🔥' },
  ], cut);
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].emoji, '❤️');
  assert.equal(overlays[0].animation, 'pop');
  assert.deepEqual([overlays[0].x, overlays[0].y], [0.96, 0.04]);
  assert.equal(errors.length, 3);
});

test('clean model ids are kept so an overlay can be edited; bad or duplicate ids are renumbered', () => {
  const { overlays } = normalizeOverlays([
    { id: 'o4', kind: 'text', text: 'a' },
    { id: 'o4', kind: 'text', text: 'b' },
    { id: 'title', kind: 'text', text: 'c' },
  ], cut);
  assert.deepEqual(overlays.map((o) => o.id), ['o4', 'o5', 'o6']);
});

test('overlays on a removed shot go with it; whole-reel ones stay', () => {
  const { overlays } = normalizeOverlays([{ kind: 'text', text: 'all', segmentId: null }, { kind: 'sticker', emoji: '🔥', segmentId: 's2' }], cut);
  assert.deepEqual(keepOverlays(overlays, [cut[0], cut[2]]).map((o) => o.id), ['o1']);
});

test('transitions: known types, not into the first shot, clamped to fit both shots', () => {
  const { transitions, errors } = normalizeTransitions([
    { segmentId: 's1', type: 'crossfade', ms: 300 },
    { segmentId: 's2', type: 'slide_left', ms: 5000 },
    { segmentId: 's3', type: 'spin', ms: 300 },
  ], cut);
  assert.deepEqual(transitions, [{ segmentId: 's2', type: 'slide_left', ms: 800 }]); // 40% of the 2 s shot
  assert.equal(errors.length, 1);
  assert.deepEqual(keepTransitions(transitions, [cut[1], cut[0]]), []); // s2 is now first
});

test('the timeline overlaps shots by each transition, and overlay windows follow it', () => {
  const transitions = [{ segmentId: 's2', type: 'crossfade' as const, ms: 400 }];
  const t = timeline(cut, transitions);
  assert.deepEqual(t.starts, [0, 2600, 4600]);
  assert.equal(t.totalMs, 8600);
  const { overlays } = normalizeOverlays([{ kind: 'text', text: 'x', segmentId: 's2' }, { kind: 'text', text: 'y', segmentId: null }], cut);
  assert.deepEqual(overlayWindows(overlays, cut, transitions), [{ startMs: 2600, endMs: 4600 }, { startMs: 0, endMs: 8600 }]);
});

test('Noto file names drop FE0F and pad code points', () => {
  assert.equal(notoName('❤️'), 'emoji_u2764.png');
  assert.equal(notoName('🐶'), 'emoji_u1f436.png');
  assert.equal(notoName('👍🏽'), 'emoji_u1f44d_1f3fd.png');
});

test('an overlay that would cover one already on screen moves just below it', () => {
  const title = { left: 200, top: 150, width: 320, height: 110 };
  const fire = { left: 460, top: 140, width: 230, height: 230 };
  assert.deepEqual(avoid(fire, [title]), { ...fire, top: 270 });
  assert.deepEqual(avoid({ ...fire, left: 20, width: 100 }, [title]), { ...fire, left: 20, width: 100 }); // no overlap, no move
});

test('overlay text is escaped for Pango and stripped of control characters', () => {
  assert.equal(markup(`Tom & Jerry <3 "hi" it's`), 'Tom &amp; Jerry &lt;3 &quot;hi&quot; it&#39;s');
  const { overlays } = normalizeOverlays([{ kind: 'text', text: 'line\u0000one\u0007\ntwo' }], cut);
  assert.equal(overlays[0].text, 'line one two');
});

test('markup in overlay text is drawn as words, never applied', async () => {
  const base = { id: 'o1', kind: 'text' as const, emoji: null, segmentId: null, x: 0.5, y: 0.2, size: 'medium' as const, style: 'clean' as const, animation: 'none' as const };
  const plain = await place({ ...base, text: 'Tom & Jerry <3' });
  assert.ok(plain.width > 100 && plain.width < 720);
  // Parsed, size='99999' would make the text thousands of pixels tall; escaped, it lays out exactly like
  // the same number of ordinary characters.
  const injected = await place({ ...base, text: `<span size='99999'>x</span>` });
  const control = await place({ ...base, text: `Xspan sizeX'99999'XxX/spanX` });
  assert.ok(Math.abs(injected.height - control.height) < 60 && injected.height < 400, `${injected.height} vs ${control.height}`);
});
