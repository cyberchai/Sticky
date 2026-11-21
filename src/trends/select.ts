/**
 * Which techniques the editor may consider for one cut. Pure.
 * Fresh = observed (by the page's own date) within 14 days of today. Ranked by recency week first,
 * then by how many independent sources describe the same format. No fresh entry → evergreen only.
 * Footage fit is decided by Gemini, which takes the FIRST candidate in this order that fits.
 */
import { LIMITS } from '../config.js';
import { SEED } from './snapshot.js';
import type { Candidate, Snapshot, Technique } from './types.js';

const DAY = 86_400_000;
/** Always offered, in this order, after any page-specific evergreen technique. The last one fits anything. */
export const CORE_EVERGREEN = ['strong-line-first', 'realization-hook', 'close-up-to-wide', 'cut-to-the-action'];

export function ageDays(observedOn: string | null, today: string): number | null {
  if (!observedOn) return null;
  return Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${observedOn}T00:00:00Z`)) / DAY);
}

export function selectCandidates(
  snapshot: Snapshot,
  today: string,
  opts: { maxDated?: number; maxEvergreen?: number } = {},
): { candidates: Candidate[]; freshCount: number } {
  const maxDated = opts.maxDated ?? 5;
  const maxEvergreen = opts.maxEvergreen ?? 5;
  // A snapshot written before the core set existed still gets it, from the committed seed.
  const coreMissing = SEED.techniques.filter((t) => CORE_EVERGREEN.includes(t.formatKey) && !snapshot.techniques.some((x) => x.formatKey === t.formatKey));
  const renderable = [...snapshot.techniques, ...coreMissing].filter((t) => t.renderable);

  const fresh = renderable.filter((t) => {
    if (t.kind !== 'dated') return false;
    const age = ageDays(t.observedOn, today);
    return age !== null && age >= 0 && age <= LIMITS.freshDays;
  });

  // One candidate per format; every source that describes it is corroboration. Titles vary a little
  // across sources ("Dear Santa" vs "Dear Santa, I'm a Size"), so a key that extends another by whole
  // words is the same format.
  const byFormat = new Map<string, Technique[]>();
  const keys = [...new Set(fresh.map((t) => t.formatKey))].sort((a, b) => a.length - b.length);
  const canonical = (key: string) => keys.find((k) => key === k || key.startsWith(`${k}-`)) ?? key;
  for (const t of fresh) {
    const k = canonical(t.formatKey);
    byFormat.set(k, [...(byFormat.get(k) ?? []), t]);
  }
  const grouped = [...byFormat.values()].map((group) => {
    const sorted = [...group].sort((a, b) => (b.observedOn ?? '').localeCompare(a.observedOn ?? ''));
    const primary = sorted[0];
    const sources = new Map(sorted.map((t) => [t.source, t]));
    return {
      primary,
      age: ageDays(primary.observedOn, today) ?? 0,
      corroboration: sources.size,
      corroboratedBy: [...sources.values()].map((t) => ({ source: t.source, sourceName: t.sourceName, url: t.url, observedOn: t.observedOn })),
    };
  });
  grouped.sort((a, b) => Math.floor(a.age / 7) - Math.floor(b.age / 7) || b.corroboration - a.corroboration || a.age - b.age);

  const dated: Candidate[] = grouped.slice(0, maxDated).map((g) => ({
    ...g.primary,
    rank: 0,
    ageDays: g.age,
    corroboratedBy: g.corroboratedBy,
  }));
  // Evergreen: the core set first (fits talking, events, products, everyday footage), ending on
  // "cut to the action", which any footage can take; then whatever else the page offered.
  const rankOf = (t: Technique) => {
    const i = CORE_EVERGREEN.indexOf(t.formatKey);
    return i < 0 ? CORE_EVERGREEN.length : i;
  };
  const evergreenAll = renderable.filter((t) => t.kind === 'evergreen').sort((a, b) => rankOf(a) - rankOf(b));
  const core = evergreenAll.filter((t) => CORE_EVERGREEN.includes(t.formatKey));
  const extra = evergreenAll.filter((t) => !CORE_EVERGREEN.includes(t.formatKey)).slice(0, Math.max(0, maxEvergreen - core.length));
  const evergreen: Candidate[] = [...extra, ...core]
    .map((t) => ({ ...t, rank: 0, ageDays: null, corroboratedBy: [] }));

  const candidates = [...dated, ...evergreen].map((c, i) => ({ ...c, rank: i + 1 }));
  return { candidates, freshCount: dated.length };
}

/** How a candidate is described to the model and to the user. */
export function evidenceLabel(c: Pick<Candidate, 'kind' | 'sourceName' | 'observedOn' | 'dateBasis'> & { corroboratedBy?: Candidate['corroboratedBy'] }): string {
  if (c.kind === 'evergreen' || !c.observedOn) return `evergreen technique (${c.sourceName})`;
  const when = new Date(`${c.observedOn}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const basis = c.dateBasis === 'page_updated' ? `weekly list updated ${when}` : `dated ${when}`;
  const others = (c.corroboratedBy ?? []).filter((s) => s.sourceName !== c.sourceName).map((s) => s.sourceName);
  return `editorial signal: ${c.sourceName}, ${basis}${others.length ? `; also seen in ${others.join(', ')}` : ''}`;
}
