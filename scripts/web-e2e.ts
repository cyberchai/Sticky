/**
 * End-to-end check of the browser channel, exactly as the page drives it:
 *   npx tsx scripts/web-e2e.ts <clip> [--base https://…] [--say "Make it eight seconds" …]
 * Prints time from upload to v1 and from each message to its result.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const clip = args[0];
const base = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'https://sticky-editor-1097661752215.us-central1.run.app';
const says: string[] = [];
args.forEach((a, i) => { if (a === '--say') says.push(args[i + 1]); });
if (!clip) { console.error('usage: web-e2e.ts <clip> [--base url] [--say text]…'); process.exit(1); }

const thread = crypto.randomBytes(16).toString('hex');
const api = (p: string) => `${base}/web/threads/${thread}${p}`;
const state = async () => (await fetch(api(''))).json() as Promise<any>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(label: string, pick: (s: any) => T | null | undefined, timeoutMs = 150_000): Promise<T> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await state();
    const v = pick(s);
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const bytes = fs.readFileSync(clip);
const uploadId = crypto.randomBytes(16).toString('hex');
const t0 = Date.now();
for (let off = 0; off < bytes.length; off += 8 * 1024 * 1024) {
  const chunk = bytes.subarray(off, Math.min(bytes.length, off + 8 * 1024 * 1024));
  const r = await fetch(api(`/uploads/${uploadId}?offset=${off}&total=${bytes.length}`), { method: 'POST', body: chunk });
  if (!r.ok) throw new Error(`upload ${r.status} ${await r.text()}`);
}
const mime = clip.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4';
const posted = await fetch(api('/clips'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clips: [{ uploadId, name: path.basename(clip), mime, total: bytes.length }], caption: '' }) });
console.log(`thread ${thread}\nupload+post ${Date.now() - t0}ms → HTTP ${posted.status}`);

const v1 = await waitFor('v1', (s) => s.projects?.[0]?.versions?.[0]);
console.log(`v1 after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${v1.technique.title} (${v1.technique.evidence}) ${v1.durationMs}ms\n  ${v1.explanation}\n  ${base}${v1.url}`);

for (const text of says) {
  const before = await state();
  const nVersions = before.projects[0]?.versions.length ?? 0;
  const nReplies = before.conversation.filter((m: any) => m.from === 'sticky').length;
  const t1 = Date.now();
  await fetch(api('/messages'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
  const out = await waitFor(`reply to "${text}"`, (s) => {
    const p = s.projects[0];
    if (p && p.versions.length > nVersions) return { kind: 'version', v: p.versions[p.versions.length - 1] };
    const replies = s.conversation.filter((m: any) => m.from === 'sticky');
    const last = replies[replies.length - 1]?.body ?? '';
    if (replies.length > nReplies && !/^Here's your reel/.test(last) && !/generating one with Veo|Editing your footage with Gemini Omni|Scoring your reel/.test(last)) return { kind: 'reply', body: last };
    return null;
  });
  const secs = ((Date.now() - t1) / 1000).toFixed(1);
  if (out.kind === 'version') console.log(`"${text}" → v${out.v.versionNo} in ${secs}s (${out.v.durationMs}ms, ${out.v.mutedShots} muted)`);
  else console.log(`"${text}" → reply in ${secs}s:\n  ${String(out.body).replace(/\n/g, '\n  ')}`);
}
