/**
 * ffprobe/ffmpeg. Every argument is built here from validated numbers and known paths, never from
 * model text. Gemini and the renderer both read the NORMALIZED file of each clip, so a millisecond
 * the model names is the same millisecond ffmpeg cuts.
 */
import { spawn } from 'node:child_process';
import type { Segment } from './edl.js';

export const CANVAS = { w: 720, h: 1280, fps: 30 };

function run(cmd: string, args: string[], timeoutMs = 120_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${cmd} timed out after ${timeoutMs}ms`)); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; if (stderr.length > 200_000) stderr = stderr.slice(-100_000); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`));
    });
  });
}

export interface ProbeInfo {
  durationMs: number;
  width: number;
  height: number;
  rotation: number;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  colorTransfer: string | null;
  sizeBytes: number;
}

export async function probe(file: string): Promise<ProbeInfo> {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], 30_000);
  const j = JSON.parse(stdout) as { streams?: any[]; format?: any };
  const v = j.streams?.find((s) => s.codec_type === 'video');
  const a = j.streams?.find((s) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream');
  const rotation = Number(v.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0) || 0;
  const seconds = Number(v.duration ?? j.format?.duration ?? 0);
  return {
    durationMs: Math.round(seconds * 1000),
    width: Number(v.width),
    height: Number(v.height),
    rotation,
    hasAudio: Boolean(a),
    videoCodec: v.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    colorTransfer: v.color_transfer ?? null,
    sizeBytes: Number(j.format?.size ?? 0),
  };
}

let zscale: boolean | null = null;
async function hasZscale(): Promise<boolean> {
  if (zscale !== null) return zscale;
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-filters'], 10_000);
    zscale = /\bzscale\b/.test(stdout);
  } catch {
    zscale = false;
  }
  return zscale;
}

const isHdr = (transfer: string | null) => transfer === 'arib-std-b67' || transfer === 'smpte2084';
const sec = (ms: number) => (ms / 1000).toFixed(3);

/**
 * One clip → 720×1280 (full frame kept, black pad), 30fps CFR, yuv420p bt709, AAC 48k stereo
 * (silence when the phone recorded none), timestamps from zero, rotation applied.
 */
export async function normalize(input: string, output: string, info: ProbeInfo, maxMs: number): Promise<void> {
  const tonemap = isHdr(info.colorTransfer) && await hasZscale()
    ? 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,'
    : '';
  const vf = `${tonemap}scale=${CANVAS.w}:${CANVAS.h}:force_original_aspect_ratio=decrease,`
    + `pad=${CANVAS.w}:${CANVAS.h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${CANVAS.fps},format=yuv420p`;
  const durMs = Math.min(info.durationMs, maxMs);
  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
  if (!info.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-map', '0:v:0', '-map', info.hasAudio ? '0:a:0' : '1:a:0',
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-t', sec(durMs), '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart',
    output,
  );
  await run('ffmpeg', args, 180_000);
}

/** Small copy for Gemini (inline bytes): same timeline, 360×640, 10fps, mono audio. */
export async function proxy(normalized: string, output: string): Promise<void> {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', normalized,
    '-vf', 'scale=360:640,fps=10', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30',
    '-c:a', 'aac', '-b:a', '48k', '-ac', '1', '-movflags', '+faststart', output,
  ], 120_000);
}

/** Hard cuts between source ranges; muted segments get silence; 15ms fades kill clicks at the cuts. */
export async function render(segments: Segment[], clipPaths: Record<string, string>, output: string): Promise<void> {
  if (!segments.length) throw new Error('no segments');
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  segments.forEach((s) => {
    const file = clipPaths[s.clipId];
    if (!file) throw new Error(`no file for ${s.clipId}`);
    args.push('-ss', sec(s.inMs), '-t', sec(s.outMs - s.inMs), '-i', file);
  });
  const chains: string[] = [];
  let concatInputs = '';
  segments.forEach((s, i) => {
    const d = (s.outMs - s.inMs) / 1000;
    const fade = Math.min(0.015, d / 4);
    chains.push(`[${i}:v]setpts=PTS-STARTPTS,fps=${CANVAS.fps},format=yuv420p[v${i}]`);
    chains.push(
      `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,volume=${s.audio === 'mute' ? 0 : 1},`
      + `afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${Math.max(0, d - fade).toFixed(3)}:d=${fade.toFixed(3)}[a${i}]`,
    );
    concatInputs += `[v${i}][a${i}]`;
  });
  chains.push(`${concatInputs}concat=n=${segments.length}:v=1:a=1[v][a]`);
  args.push(
    '-filter_complex', chains.join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level:v', '4.1',
    '-pix_fmt', 'yuv420p', '-r', String(CANVAS.fps),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart', output,
  );
  await run('ffmpeg', args, 180_000);
}

/** The exported file is what we promised: H.264 720×1280 + AAC, duration within tolerance. */
/** An exact [inMs, outMs) stretch of a normalized clip, re-encoded (frame-accurate), audio included. */
export async function extractSpan(input: string, inMs: number, outMs: number, output: string): Promise<void> {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-ss', sec(inMs), '-t', sec(outMs - inMs), '-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(CANVAS.fps),
    '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart', output,
  ], 120_000);
}

/** The edited picture with the ORIGINAL sound (speech stays the user's real audio), cut to the original length. */
export async function withOriginalAudio(editedVideo: string, originalSpan: string, output: string): Promise<void> {
  const original = await probe(originalSpan);
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', editedVideo, '-i', originalSpan,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-t', sec(original.durationMs), '-movflags', '+faststart', output,
  ], 120_000);
}

/**
 * Lay a music bed on a rendered cut. "under": music at a low level that ducks further whenever the
 * original audio (speech, the tear) is present. "replace": music only. Picture is copied untouched.
 */
export async function mixMusic(cut: string, music: string, mode: 'under' | 'replace', durationMs: number, output: string): Promise<void> {
  const d = durationMs / 1000;
  const fadeOut = Math.min(0.8, d / 4);
  const bed = `[1:a]aresample=48000,atrim=0:${d.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=0.25,afade=t=out:st=${Math.max(0, d - fadeOut).toFixed(3)}:d=${fadeOut.toFixed(3)}`;
  const graph = mode === 'replace'
    ? `${bed},volume=0.9[a]`
    : `${bed},volume=0.35[m];[0:a]asplit=2[v1][v2];[m][v1]sidechaincompress=threshold=0.03:ratio=6:attack=15:release=350[md];[v2][md]amix=inputs=2:duration=first:normalize=0[a]`;
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', cut, '-i', music,
    '-filter_complex', graph, '-map', '0:v:0', '-map', '[a]',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
    '-t', d.toFixed(3), '-movflags', '+faststart', output,
  ], 120_000);
}

export async function verify(file: string, expectedMs: number): Promise<ProbeInfo> {
  const info = await probe(file);
  const problems: string[] = [];
  if (info.videoCodec !== 'h264') problems.push(`video codec ${info.videoCodec}`);
  if (info.width !== CANVAS.w || info.height !== CANVAS.h) problems.push(`size ${info.width}x${info.height}`);
  if (info.audioCodec !== 'aac') problems.push(`audio codec ${info.audioCodec}`);
  if (Math.abs(info.durationMs - expectedMs) > 350) problems.push(`duration ${info.durationMs}ms vs ${expectedMs}ms`);
  if (problems.length) throw new Error(`export check failed: ${problems.join(', ')}`);
  return info;
}

/** A known-good test MP4 (scripts/linq-check): colour bars + tone. */
export async function testPattern(output: string, seconds = 5): Promise<void> {
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${CANVAS.w}x${CANVAS.h}:rate=${CANVAS.fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-shortest', '-movflags', '+faststart', output,
  ], 60_000);
}
