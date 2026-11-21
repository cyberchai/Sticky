export type SourceId = 'later' | 'newengen' | 'socialbee' | 'evergreen' | 'viraloutliers';

export interface EditOps {
  opening: string;
  order: string;
  pacing: string;
  audio: string;
  ending: string;
}

/** One technique, in our own words, with the dated evidence it came from. */
export interface Technique {
  id: string;               // "<source>:<formatKey>"
  formatKey: string;        // cross-source merge key, derived from the title in code
  title: string;
  source: SourceId;
  sourceName: string;
  url: string;
  kind: 'dated' | 'evergreen';
  observedOn: string | null;               // YYYY-MM-DD from the page's own date, never the fetch date
  dateBasis: 'entry' | 'page_updated' | null;
  dateText: string | null;                 // the literal date text found on the page
  summary: string;
  requires: string[];                      // what the footage must visibly/audibly contain
  ops: EditOps;
  renderable: boolean;
  whyNotRenderable?: string | null;
}

export interface SourceReport {
  id: SourceId;
  url: string;
  ok: boolean;
  fetchedAt: string;
  pageUpdated?: string | null;
  entries?: number;
  error?: string;
  retainedFrom?: string;    // refreshedAt of the snapshot whose entries were kept when this source failed
}

export interface Snapshot {
  version: 1;
  refreshedAt: string;
  origin: 'seed' | 'refresh';
  market: 'US/en';
  sources: SourceReport[];
  techniques: Technique[];
  /** Measured outliers (real counts from the source); evidence for the opening pattern, never a prediction. */
  outliers?: import('./outliers.js').Outlier[];
}

/** A technique as offered to the editor for one cut, with its rank and corroboration. */
export interface Candidate extends Technique {
  /** Set on the stored version when the opening borrows a measured outlier's pattern. */
  hookEvidence?: (import('./outliers.js').Outlier & { sharedPattern: string }) | null;
  rank: number;
  ageDays: number | null;
  corroboratedBy: Array<{ source: SourceId; sourceName: string; url: string; observedOn: string | null }>;
}

export function formatKeyOf(title: string): string {
  return title.toLowerCase().normalize('NFKD').replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
