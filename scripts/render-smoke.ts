/**
 * Renderer smoke test, no network: a portrait clip with audio + a LANDSCAPE clip with NO audio →
 * normalize → a 3-segment cut that reorders and mutes → ffprobe check.
 *   npx tsx scripts/render-smoke.ts [optional real clip]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { validateSegments, totalMs, type Segment } from '../src/edl.js';
import { normalize, probe, proxy, render, verify } from '../src/media.js';

const dir = path.join(config.workDir, 'smoke');
fs.mkdirSync(dir, { recursive: true });
const ff = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
};
const portrait = process.argv[2] ?? path.join(dir, 'portrait.mov');
if (!process.argv[2]) {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', portrait]);
}
const landscape = path.join(dir, 'landscape-silent.mp4');
ff(['-f', 'lavfi', '-i', 'smptebars=size=1920x1080:rate=24:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', landscape]);

const t0 = Date.now();
const clips: Record<string, string> = {};
const infos = [];
for (const [id, file] of [['c1', portrait], ['c2', landscape]] as const) {
  const info = await probe(file);
  const norm = path.join(dir, `${id}.norm.mp4`);
  await normalize(file, norm, info, 60_000);
  await proxy(norm, path.join(dir, `${id}.proxy.mp4`));
  const n = await probe(norm);
  console.log(`${id}: ${info.width}x${info.height} audio=${info.hasAudio} → norm ${n.width}x${n.height} ${n.durationMs}ms audio=${n.audioCodec}`);
  clips[id] = norm;
  infos.push({ clipId: id, durationMs: n.durationMs, hasAudio: info.hasAudio });
}
console.log(`normalize+proxy ${Date.now() - t0}ms`);

const segments: Segment[] = [
  { id: 's1', clipId: 'c2', inMs: 1000, outMs: 3500, audio: 'keep' },
  { id: 's2', clipId: 'c1', inMs: 2000, outMs: 5000, audio: 'mute' },
  { id: 's3', clipId: 'c1', inMs: 6000, outMs: 7800, audio: 'keep' },
];
const errors = validateSegments(segments, infos);
console.log('validate:', errors.length ? errors : 'ok', `total=${totalMs(segments)}ms`);
const out = path.join(dir, 'cut.mp4');
const t1 = Date.now();
await render(segments, clips, out);
const info = await verify(out, totalMs(segments));
console.log(`render ${Date.now() - t1}ms → ${out} ${info.width}x${info.height} ${info.videoCodec}/${info.audioCodec} ${info.durationMs}ms ${info.sizeBytes}B`);

// Audible check: the muted segment (2.5s–5.5s of the output) must be silent; the last must not.
const vol = (ss: number, t: number) => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(ss), '-t', String(t), '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
  return /max_volume: (-?[\d.]+|-inf) dB/.exec(r.stderr.toString())?.[1];
};
console.log(`max volume muted segment: ${vol(2.7, 2.5)} dB, last segment: ${vol(5.7, 1.5)} dB`);
