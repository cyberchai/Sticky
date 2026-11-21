import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isoDate, laterEntries, newEngenEntries } from '../src/trends/refresh.js';
import { ageDays, evidenceLabel, selectCandidates } from '../src/trends/select.js';
import { SEED } from '../src/trends/snapshot.js';

test('fresh = within 14 days of today by the page date; ranked by week, then corroboration', () => {
  const { candidates, freshCount } = selectCandidates(SEED, '2026-11-21');
  const dated = candidates.filter((c) => c.kind === 'dated');
  assert.equal(freshCount, dated.length);
  assert.ok(!dated.some((c) => c.formatKey === 'the-process'), 'Sept entry is stale');
  // Nov 20 entries (age 1) before the Nov 13 entry (age 8); the corroborated one first among Nov 20.
  assert.equal(dated[0].formatKey, 'i-feel-like-i-havent-done-much-this-year');
  assert.equal(dated[0].corroboratedBy.length, 2);
  assert.equal(dated[dated.length - 1].formatKey, 'outfit-transition');
  // one candidate per format
  assert.equal(new Set(dated.map((c) => c.formatKey)).size, dated.length);
  // evergreen comes after every dated candidate
  const firstEvergreen = candidates.findIndex((c) => c.kind === 'evergreen');
  assert.ok(firstEvergreen >= dated.length);
});

test('with only stale evidence, only evergreen techniques are offered', () => {
  const { candidates, freshCount } = selectCandidates(SEED, '2026-12-20');
  assert.equal(freshCount, 0);
  assert.ok(candidates.length > 0);
  assert.ok(candidates.every((c) => c.kind === 'evergreen'));
  assert.match(evidenceLabel(candidates[0]), /^evergreen technique/);
});

test('a future-dated entry is never fresh', () => {
  assert.equal(ageDays('2026-11-25', '2026-11-21'), -4);
  const { candidates } = selectCandidates(SEED, '2026-11-12');
  assert.ok(!candidates.some((c) => c.observedOn && c.observedOn > '2026-11-12'));
});

test('labels say editorial signal with the page date basis', () => {
  const ne = SEED.techniques.find((t) => t.id === 'newengen:christmas-wrapping-paper-reveal')!;
  assert.equal(evidenceLabel(ne), 'editorial signal: New Engen, weekly list updated Nov 20, 2026');
});

test('date parsing and Later entry extraction take dates from the entry heading', () => {
  assert.equal(isoDate('Trend: Outfit transition — November 13, 2026'), '2026-11-13');
  const text = 'intro\n## Trend: Dear Santa — November 20, 2026\nTrend Recap: wishlist.\nAudio: x\n## Trend: Outfit transition — November 13, 2026\nTrend Recap: one spot.';
  const entries = laterEntries(text);
  assert.deepEqual(entries.map((e) => [e.title, e.observedOn]), [['Dear Santa', '2026-11-20'], ['Outfit transition', '2026-11-13']]);
});

test('New Engen weekly entries use "Last updated", never the publish date', () => {
  const text = '03.09.26\nInstagram Trends\nLast updated: November 20, 2026\n## What Instagram Trends Are Going Viral Right Now?\nsummary\n## Trend #1: Paid Me No Mind\nLip-sync.\n## Trend #2: Add to Cart\nHands.\n## Hooks That Stop the Scroll\nThe first two seconds.\n1. The Realization Hook. Opens on a moment of change.\n2. The Confession. Disarms.';
  const { pageUpdated, entries } = newEngenEntries(text);
  assert.equal(pageUpdated, '2026-11-20');
  const dated = entries.filter((e) => e.kind === 'dated');
  assert.deepEqual(dated.map((e) => e.title), ['Paid Me No Mind', 'Add to Cart']);
  assert.ok(dated.every((e) => e.observedOn === '2026-11-20' && e.dateBasis === 'page_updated'));
  assert.deepEqual(entries.filter((e) => e.kind === 'evergreen').map((e) => e.title), ['Realization Hook', 'Confession']);
});
