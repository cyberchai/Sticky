/**
 * One background job: read the newest dated sections of public Instagram trend pages, keep only
 * techniques the renderer can implement, write one small JSON snapshot atomically.
 *
 * Dates are taken by CODE from the page text next to each entry (Later: per entry; New Engen:
 * the weekly list's "Last updated" line; the page's "Published" date is never used). The model
 * only paraphrases and classifies; it never supplies a date. A failed source keeps its last good
 * entries; a total failure leaves the previous snapshot in place.
 */
import { config, today } from '../config.js';
import { db } from '../db.js';
import { classifyHooks, extractTechniques, type RawEntry } from '../gemini.js';
import { fetchOutliers, thumbnailsOf, type Outlier } from './outliers.js';
import { errMsg, log } from '../log.js';
import { putJson } from '../store.js';
import { SEED, SNAPSHOT_KEY, loadSnapshot, setSnapshot } from './snapshot.js';
import { formatKeyOf, type Snapshot, type SourceId, type SourceReport, type Technique } from './types.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) StickyTrendReader/0.1';
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DATE_RE = /(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}), (\d{4})/;

export function isoDate(text: string): string | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h[1-6][^>]*>/gi, '\n## ')
    .replace(/<\/(h[1-6]|p|li|div|section|article|tr)>|<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”').replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return htmlToText(await res.text());
}

interface DatedEntry extends RawEntry { dateText: string; observedOn: string; dateBasis: 'entry' | 'page_updated'; kind: 'dated' | 'evergreen' }

/** Later: "Trend: <title> — <Month D, YYYY>" headings, newest first. Newest ~40 entries only. */
export function laterEntries(text: string): DatedEntry[] {
  const chunks = text.split(/\n(?:## )?Trend:\s*/).slice(1, 40);
  const out: DatedEntry[] = [];
  chunks.forEach((chunk, i) => {
    const [heading, ...rest] = chunk.split('\n');
    const observedOn = isoDate(heading);
    const dateText = DATE_RE.exec(heading)?.[0];
    if (!observedOn || !dateText) return;
    const title = heading.replace(DATE_RE, '').replace(/[\s—–-]+$/, '').trim();
    out.push({ entryId: `later-${i}`, title, body: rest.join('\n').split(/\n## /)[0].slice(0, 900), dateText, observedOn, dateBasis: 'entry', kind: 'dated' });
  });
  return out;
}

/** New Engen: this week's list (dated by "Last updated") + the evergreen hooks/camera sections (undated). */
export function newEngenEntries(text: string): { pageUpdated: string | null; entries: DatedEntry[] } {
  const updated = /Last updated:\s*((January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4})/.exec(text);
  const pageUpdated = updated ? isoDate(updated[1]) : null;
  const entries: DatedEntry[] = [];
  const weeklyStart = text.search(/What Instagram Trends Are Going Viral/i);
  const hooksStart = text.search(/Hooks That Stop the Scroll/i);
  if (pageUpdated && updated && weeklyStart >= 0) {
    const weekly = text.slice(weeklyStart, hooksStart > weeklyStart ? hooksStart : weeklyStart + 20_000);
    const detailed = weekly.split(/Trend #\d+:\s*/).slice(1);
    detailed.forEach((chunk, i) => {
      const [title, ...rest] = chunk.split('\n');
      entries.push({ entryId: `newengen-${i}`, title: title.trim(), body: rest.join('\n').slice(0, 1200), dateText: updated[1], observedOn: pageUpdated, dateBasis: 'page_updated', kind: 'dated' });
    });
  }
  if (hooksStart >= 0) {
    const evergreen = text.slice(hooksStart, hooksStart + 9_000);
    // <ol> items arrive as "- The X. ..." (numbering is CSS) or "1. The X. ..." depending on markup.
    const items = [...evergreen.matchAll(/\n(?:- |\d+\.\s*)(The [^.\n]{3,60})\.\s*([^\n]+)/g)];
    items.forEach((m, i) => {
      entries.push({ entryId: `newengen-evergreen-${i}`, title: m[1].replace(/^The /, '').trim(), body: m[2].slice(0, 700), dateText: '', observedOn: '', dateBasis: 'entry', kind: 'evergreen' });
    });
  }
  return { pageUpdated, entries };
}

const SOURCES: Array<{ id: SourceId; name: string; url: string; parse: (text: string) => { pageUpdated: string | null; entries: DatedEntry[] } }> = [
  { id: 'later', name: 'Later', url: 'https://later.com/blog/instagram-reels-trends/', parse: (t) => ({ pageUpdated: null, entries: laterEntries(t) }) },
  { id: 'newengen', name: 'New Engen', url: 'https://newengen.com/insights/instagram-trends/', parse: newEngenEntries },
];

async function readSource(src: (typeof SOURCES)[number], todayIso: string): Promise<{ report: SourceReport; techniques: Technique[] }> {
  const fetchedAt = new Date().toISOString();
  const text = await fetchText(src.url);
  const { pageUpdated, entries } = src.parse(text);
  // Newest relevant only: dated entries from the last 45 days (selection narrows to 14), plus evergreen.
  const recent = entries.filter((e) => e.kind === 'evergreen' || (e.observedOn <= todayIso && Date.parse(todayIso) - Date.parse(e.observedOn) <= 45 * 86_400_000));
  // Guard: every date we keep is literally on the page.
  const verified = recent.filter((e) => e.kind === 'evergreen' || text.includes(e.dateText));
  const extracted = await extractTechniques(src.name, verified.map(({ entryId, title, body }) => ({ entryId, title, body })));
  const byId = new Map(extracted.map((x) => [x.entryId, x]));
  const techniques: Technique[] = [];
  for (const e of verified) {
    const x = byId.get(e.entryId);
    if (!x || x.generic) continue;
    const formatKey = formatKeyOf(e.title);
    const evergreen = e.kind === 'evergreen';
    const source: SourceId = evergreen ? 'evergreen' : src.id;
    techniques.push({
      id: `${source}:${formatKey}`,
      formatKey,
      title: e.title,
      source,
      sourceName: evergreen ? `${src.name} evergreen guidance` : src.name,
      url: src.url,
      kind: e.kind,
      observedOn: evergreen ? null : e.observedOn,
      dateBasis: evergreen ? null : e.dateBasis,
      dateText: evergreen ? null : e.dateText,
      summary: x.summary,
      requires: x.requires,
      ops: x.ops,
      renderable: x.renderable,
      whyNotRenderable: x.whyNotRenderable,
    });
  }
  return {
    report: { id: src.id, url: src.url, ok: true, fetchedAt, pageUpdated, entries: techniques.length },
    techniques,
  };
}

/** Measured outliers from the trending feed, each labeled with its opening pattern (caption + thumbnail). */
export async function refreshOutliers(): Promise<Outlier[]> {
  const outliers = await fetchOutliers();
  if (!outliers.length) return outliers;
  const thumbs = await thumbnailsOf(outliers);
  const hooks = await classifyHooks(outliers.map((o) => ({ id: o.id, platform: o.platform, caption: o.caption, thumbnail: thumbs.get(o.id) ?? null })));
  const byId = new Map(hooks.map((h) => [h.id, h]));
  return outliers.map((o) => ({ ...o, hook: byId.get(o.id)?.hook ?? 'other', opening: byId.get(o.id)?.opening ?? '' }));
}

export async function refreshSnapshot(reason = 'manual'): Promise<Snapshot> {
  if (!config.trendsFetch) throw new Error('trend fetching is disabled (STICKY_TRENDS_FETCH=off)');
  // One refresh at a time across processes (Mac + Cloud Run share the database). Advisory locks are
  // per session, so lock and unlock on one dedicated client.
  const client = await Promise.resolve().then(() => db().connect()).catch(() => null);
  if (client) {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(424242) AS ok');
    if (!rows[0]?.ok) { client.release(); throw new Error('another refresh is running'); }
  }
  const t0 = Date.now();
  try {
    const prev = await loadSnapshot();
    const todayIso = today();
    const results = await Promise.allSettled(SOURCES.map((s) => readSource(s, todayIso)));
    const reports: SourceReport[] = [];
    let techniques: Technique[] = [];
    let anyOk = false;
    results.forEach((r, i) => {
      const src = SOURCES[i];
      if (r.status === 'fulfilled' && r.value.techniques.length) {
        anyOk = true;
        reports.push(r.value.report);
        techniques.push(...r.value.techniques);
      } else {
        const error = r.status === 'rejected' ? errMsg(r.reason) : 'no usable entries';
        const kept = prev.techniques.filter((t) => t.source === src.id || (src.id === 'newengen' && t.source === 'evergreen' && t.url === src.url));
        reports.push({ id: src.id, url: src.url, ok: false, fetchedAt: new Date().toISOString(), error, retainedFrom: prev.refreshedAt, entries: kept.length });
        techniques.push(...kept);
      }
    });
    if (!anyOk) throw new Error(`no source refreshed: ${reports.map((r) => `${r.id}: ${r.error}`).join('; ')}`);
    // The core evergreen set (our compact wording of New Engen's hooks guidance) is always present, so
    // every kind of footage has a labeled fallback whatever the page extraction kept this time.
    const core = SEED.techniques.filter((t) => t.kind === 'evergreen' && !techniques.some((x) => x.formatKey === t.formatKey));
    techniques.push(...core);
    // De-duplicate ids (same entry seen twice).
    techniques = [...new Map(techniques.map((t) => [t.id, t])).values()];
    // Measured outliers ride along; a failed feed keeps the last good list.
    let outliers = prev.outliers ?? [];
    try {
      outliers = await refreshOutliers();
      reports.push({ id: 'viraloutliers', url: 'https://viraloutliers.com/api/v1/trending', ok: true, fetchedAt: new Date().toISOString(), entries: outliers.length });
    } catch (err) {
      reports.push({ id: 'viraloutliers', url: 'https://viraloutliers.com/api/v1/trending', ok: false, fetchedAt: new Date().toISOString(), error: errMsg(err), retainedFrom: prev.refreshedAt, entries: outliers.length });
    }
    const snapshot: Snapshot = { version: 1, refreshedAt: new Date().toISOString(), origin: 'refresh', market: 'US/en', sources: reports, techniques, outliers };
    await putJson(SNAPSHOT_KEY, snapshot);
    setSnapshot(snapshot);
    log('trends', {
      refresh: 'ok', reason, ms: Date.now() - t0,
      dated: techniques.filter((t) => t.kind === 'dated' && t.renderable).length,
      evergreen: techniques.filter((t) => t.kind === 'evergreen').length,
      sources: reports.map((r) => `${r.id}:${r.ok ? 'ok' : 'kept'}`).join(','),
    });
    return snapshot;
  } finally {
    if (client) {
      await client.query('SELECT pg_advisory_unlock(424242)').catch(() => {});
      client.release();
    }
  }
}
