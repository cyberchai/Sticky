/**
 * Prime the trend snapshot from the live public pages and print what the editor will see.
 *   npm run trends:prime            # refresh + print
 *   npm run trends:prime -- --dry   # parse pages only (no model call, no write)
 */
import { config, today } from '../src/config.js';
import { db, initDb } from '../src/db.js';
import { htmlToText, laterEntries, newEngenEntries, refreshSnapshot } from '../src/trends/refresh.js';
import { selectCandidates } from '../src/trends/select.js';

if (process.argv.includes('--dry')) {
  const get = async (u: string) => htmlToText(await (await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 StickyTrendReader/0.1' } })).text());
  const later = laterEntries(await get('https://later.com/blog/instagram-reels-trends/'));
  const ne = newEngenEntries(await get('https://newengen.com/insights/instagram-trends/'));
  console.log('Later entries:', later.length);
  for (const e of later.slice(0, 8)) console.log(`  ${e.observedOn}  ${e.title}`);
  console.log('New Engen page updated:', ne.pageUpdated, 'entries:', ne.entries.length);
  for (const e of ne.entries.slice(0, 16)) console.log(`  ${e.kind === 'dated' ? e.observedOn : 'evergreen '}  ${e.title}`);
  process.exit(0);
}

await initDb().catch(() => console.warn('(no database: refresh runs without the cross-process lock)'));
const snap = await refreshSnapshot('prime');
console.log(`snapshot ${snap.refreshedAt} → ${config.bucket ? `gs://${config.bucket}` : 'local store'}`);
for (const s of snap.sources) console.log(`  ${s.id}: ${s.ok ? 'ok' : `FAILED (${s.error}), kept ${s.entries}`} ${s.pageUpdated ? `page updated ${s.pageUpdated}` : ''}`);
const { candidates, freshCount } = selectCandidates(snap, today());
console.log(`\ntoday=${today()} fresh=${freshCount}`);
for (const c of candidates) console.log(`  #${c.rank} ${c.id}  ${c.kind === 'dated' ? `${c.observedOn} (${c.dateBasis}) x${c.corroboratedBy.length}` : 'evergreen'}`);
const excluded = snap.techniques.filter((t) => !t.renderable);
if (excluded.length) console.log(`\nexcluded (not renderable):\n${excluded.map((t) => `  ${t.id}: ${t.whyNotRenderable}`).join('\n')}`);
await db().end().catch(() => {});
