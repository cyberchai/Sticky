/**
 * The real edit path on local files, no phone, no database: normalize → proxy → current trend
 * snapshot → Gemini v1 → validated EDL → render → ffprobe, then optional revisions.
 *   npx tsx scripts/edit-local.ts clip1.mov [clip2 …] [--direction "…"] [--revise "…" …]
 * Output: .data/local/v1.mp4, v2.mp4 … plus the EDL and "Why this cut?" text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, config, today } from '../src/config.js';
import { totalMs, type Segment } from '../src/edl.js';
import { whyThisCut } from '../src/explain.js';
import { planV1, revise, type ClipForModel } from '../src/gemini.js';
import { normalize, probe, proxy, render, verify } from '../src/media.js';
import { selectCandidates } from '../src/trends/select.js';
import { loadSnapshot } from '../src/trends/snapshot.js';

const args = process.argv.slice(2);
const files: string[] = [];
const direction: string[] = [];
const revisions: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--direction') direction.push(args[++i]);
  else if (args[i] === '--revise') revisions.push(args[++i]);
  else files.push(args[i]);
}
const dir = path.join(config.workDir, 'local');
fs.mkdirSync(dir, { recursive: true });

const t0 = Date.now();
const clips: ClipForModel[] = [];
const normPaths: Record<string, string> = {};
for (const [i, f] of files.entries()) {
  const id = `c${i + 1}`;
  const info = await probe(f);
  const norm = path.join(dir, `${id}.norm.mp4`);
  const proxyFile = path.join(dir, `${id}.proxy.mp4`);
  await normalize(f, norm, info, LIMITS.maxSourceMs);
  await proxy(norm, proxyFile);
  const n = await probe(norm);
  normPaths[id] = norm;
  clips.push({ clipId: id, durationMs: n.durationMs, hasAudio: info.hasAudio, proxy: fs.readFileSync(proxyFile) });
  console.log(`${id}: ${path.basename(f)} ${info.width}x${info.height} ${n.durationMs}ms audio=${info.hasAudio} transfer=${info.colorTransfer}`);
}
console.log(`intake ${Date.now() - t0}ms`);

const snap = await loadSnapshot();
const { candidates, freshCount } = selectCandidates(snap, today());
console.log(`snapshot ${snap.origin} ${snap.refreshedAt}; fresh=${freshCount}; offered: ${candidates.map((c) => c.id).join(', ')}`);

const plan = await planV1({ clips, direction, candidates, targetMs: LIMITS.defaultTargetMs });
console.log(`\nv1 plan: ${plan.model} ${plan.ms}ms attempts=${plan.attempts}`);
console.log(`hook: ${JSON.stringify(plan.analysis.hook)}\npayoff: ${JSON.stringify(plan.analysis.payoff)}`);
console.log(`fits: ${plan.candidateFit.map((f) => `${f.techniqueId}=${f.fits}`).join(' ')}`);
console.log(`technique: ${plan.technique.id}\nexplanation: ${plan.explanation}`);
console.log(`segments: ${JSON.stringify(plan.segments)}`);

let segments: Segment[] = plan.segments;
const out = async (n: number) => {
  const file = path.join(dir, `v${n}.mp4`);
  const r0 = Date.now();
  await render(segments, normPaths, file);
  const info = await verify(file, totalMs(segments));
  console.log(`render v${n} ${Date.now() - r0}ms → ${file} ${info.durationMs}ms ${info.sizeBytes}B`);
};
await out(1);
console.log(`\nWhy this cut?\n${whyThisCut({ segments, technique: plan.technique, analysis: plan.analysis, explanation: plan.explanation, direction: direction.join(' ') || null, versionNo: 1 })}`);

for (const [i, text] of revisions.entries()) {
  const r = await revise({ clips, analysis: plan.analysis, segments, techniqueTitle: plan.technique.title, direction: text });
  console.log(`\nrevise "${text}": ${r.model} ${r.ms}ms attempts=${r.attempts} ops=${JSON.stringify(r.ops)}`);
  if (!r.segments) { console.log(`unsupported: ${r.unsupportedReason}`); continue; }
  segments = r.segments;
  console.log(`segments: ${JSON.stringify(segments)}`);
  await out(i + 2);
}
console.log(`\ntotal ${Date.now() - t0}ms`);
