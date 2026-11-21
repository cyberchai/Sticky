/**
 * Text and stickers over the cut ("put 'Animalliyah' on it", "a 🔥 on the last shot"). Each overlay sits on
 * one shot (by id, so it follows that shot through later moves and trims, and goes when the shot goes) or
 * on the whole reel. It is drawn to a PNG (text with Pango and the bundled Poppins; stickers are Noto Emoji
 * images) and burned in with ffmpeg's overlay filter, which every ffmpeg build has (Homebrew's has no
 * drawtext). Entrances are animated with a fade and/or an eased slide.
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Segment } from './edl.js';
import { log } from './log.js';
import { CANVAS } from './media.js';
import { cachePath, ensureDir } from './store.js';
import { timeline, type Transition } from './transitions.js';

const execFileP = promisify(execFile);
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');
const FONT_FILE = path.join(FONT_DIR, 'Poppins-ExtraBold.ttf');
// Pango finds fonts through fontconfig; a config that knows only our fonts skips a ~45 s system scan.
// Set before sharp (and so Pango) first loads, which is lazy below.
process.env.FONTCONFIG_FILE ??= path.join(FONT_DIR, 'fonts.conf');

export const OVERLAY_SIZES = ['small', 'medium', 'large'] as const;
export const OVERLAY_STYLES = ['clean', 'box', 'dark', 'yellow'] as const;
export const OVERLAY_ANIMATIONS = ['fade', 'pop', 'slide_up', 'slide_left', 'none'] as const;
export type OverlaySize = (typeof OVERLAY_SIZES)[number];
export type OverlayStyle = (typeof OVERLAY_STYLES)[number];
export type OverlayAnimation = (typeof OVERLAY_ANIMATIONS)[number];

export interface Overlay {
  id: string;
  kind: 'text' | 'sticker';
  text: string | null;       // text: the words (emoji go in their own sticker)
  emoji: string | null;      // sticker: one emoji
  segmentId: string | null;  // the shot it shows on; null = the whole reel
  x: number;                 // centre, as fractions of the frame
  y: number;
  size: OverlaySize;
  style: OverlayStyle | null; // text only
  animation: OverlayAnimation;
}

const MAX_OVERLAYS = 8;
const MAX_TEXT = 90;
/** "o1", "o2", …: the ids the model refers back to when it edits an overlay. */
const OVERLAY_ID = /^o(\d{1,3})$/;
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;
// Control characters: never meaningful in a title, and Pango would choke on some of them.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;
const EMOJI_PARTS = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200d|\ufe0f|\u20e3/gu;
const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const pick = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (list.includes(v as T) ? v as T : fallback);
// Number(null) and Number('') are 0, so those count as missing too.
const num = (v: unknown, fallback: number) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** The model's complete overlay list, checked against the cut it will sit on. */
export function normalizeOverlays(raw: unknown, segments: Segment[]): { overlays: Overlay[]; errors: string[] } {
  if (!Array.isArray(raw)) return { overlays: [], errors: ['overlays must be a list'] };
  const errors: string[] = [];
  const shots = new Set(segments.map((s) => s.id));
  const overlays: Overlay[] = [];
  if (raw.length > MAX_OVERLAYS) errors.push(`at most ${MAX_OVERLAYS} overlays`);
  for (const item of (raw as any[]).slice(0, MAX_OVERLAYS)) {
    const kind: Overlay['kind'] | null = item?.kind === 'text' || item?.kind === 'sticker' ? item.kind : null;
    if (!kind) { errors.push(`overlay kind "${item?.kind}" must be text or sticker`); continue; }
    const segmentId = item.segmentId === null || item.segmentId === undefined || item.segmentId === '' ? null : String(item.segmentId);
    if (segmentId && !shots.has(segmentId)) { errors.push(`overlay on shot ${segmentId}, which isn't in the cut`); continue; }
    const base = {
      id: String(item.id ?? ''),
      segmentId,
      x: clamp(num(item.x, 0.5), 0.04, 0.96),
      y: clamp(num(item.y, kind === 'text' ? 0.18 : 0.5), 0.04, 0.92),
      size: pick(OVERLAY_SIZES, item.size, 'medium'),
      animation: pick(OVERLAY_ANIMATIONS, item.animation, kind === 'sticker' ? 'pop' : 'fade'),
    };
    if (kind === 'text') {
      const text = String(item.text ?? '').replace(CONTROL, ' ').replace(EMOJI_PARTS, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
      if (!text) { errors.push('a text overlay has no words (put emoji in a sticker overlay)'); continue; }
      overlays.push({ ...base, kind, text, emoji: null, style: pick(OVERLAY_STYLES, item.style, 'clean') });
    } else {
      const first = [...graphemes.segment(String(item.emoji ?? '').trim())][0]?.segment ?? '';
      if (!EMOJI.test(first)) { errors.push(`sticker "${String(item.emoji ?? '')}" is not an emoji`); continue; }
      overlays.push({ ...base, kind, text: null, emoji: first, style: null });
    }
  }
  // Keep the model's ids when they're clean and unique, so "move the title" keeps the same overlay.
  const used = new Set<string>();
  let next = 1 + Math.max(0, ...overlays.map((o) => Number(OVERLAY_ID.exec(o.id)?.[1] ?? 0)));
  for (const o of overlays) {
    if (!OVERLAY_ID.test(o.id) || used.has(o.id)) o.id = `o${next++}`;
    used.add(o.id);
  }
  return { overlays, errors };
}

/** Overlays whose shot is still in the cut (whole-reel ones always stay). */
export function keepOverlays(overlays: Overlay[] | null | undefined, segments: Segment[]): Overlay[] {
  const shots = new Set(segments.map((s) => s.id));
  return (overlays ?? []).filter((o) => o.segmentId === null || shots.has(o.segmentId));
}

/** When each overlay is on screen, in ms of the output (after transitions overlap shots). */
export function overlayWindows(overlays: Overlay[], segments: Segment[], transitions: Transition[] = []): Array<{ startMs: number; endMs: number }> {
  const t = timeline(segments, transitions);
  return overlays.map((o) => {
    const i = o.segmentId === null ? -1 : segments.findIndex((s) => s.id === o.segmentId);
    return i < 0 ? { startMs: 0, endMs: t.totalMs } : { startMs: t.starts[i], endMs: t.ends[i] };
  });
}

/** Noto Emoji's file name for an emoji: lowercase hex code points joined by "_", without FE0F. */
export function notoName(emoji: string): string {
  const cps = [...emoji].map((c) => c.codePointAt(0)!.toString(16).padStart(4, '0')).filter((h) => h !== 'fe0f');
  return `emoji_u${cps.join('_')}.png`;
}

/** One plain sentence for "Why this cut?" and explanations. */
export function describeOverlays(overlays: Overlay[]): string {
  const where = (o: Overlay) => (o.segmentId ? `on ${o.segmentId}` : 'over the whole reel');
  return overlays.map((o) => (o.kind === 'text' ? `“${o.text}” ${where(o)}` : `${o.emoji} ${where(o)}`)).join('; ');
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

const NOTO = 'https://cdn.jsdelivr.net/gh/googlefonts/noto-emoji@v2.047/png/512';
const fetchNoto = (name: string) => fetch(`${NOTO}/${name}`, { signal: AbortSignal.timeout(15_000) });
const TEXT_PX: Record<OverlaySize, number> = { small: 44, medium: 64, large: 92 };
const STICKER_PX: Record<OverlaySize, number> = { small: 150, medium: 230, large: 330 };
const STYLE: Record<OverlayStyle, { fg: string; bg: string | null; bgOpacity: number }> = {
  clean: { fg: '#FFFFFF', bg: null, bgOpacity: 0 },
  box: { fg: '#111111', bg: '#FFFFFF', bgOpacity: 1 },
  dark: { fg: '#FFFFFF', bg: '#000000', bgOpacity: 0.62 },
  yellow: { fg: '#361118', bg: '#FDFB04', bgOpacity: 1 },
};
const MARGIN = 12;

let sharpModule: any = null;
async function sharp(): Promise<any> {
  return (sharpModule ??= (await import('sharp')).default);
}

/** sharp's text input is Pango markup: the user's words must never be read as tags or entities. */
export const markup = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

async function textPng(o: Overlay): Promise<Buffer> {
  const S = await sharp();
  const px = TEXT_PX[o.size];
  const style = STYLE[o.style ?? 'clean'];
  const draw = (color: string) => S({
    text: { text: `<span foreground="${color}">${markup(o.text!)}</span>`, font: `Poppins ExtraBold ${px}`, fontfile: FONT_FILE, rgba: true, width: 620, align: 'centre', wrap: 'word', dpi: 72 },
  }).png().toBuffer({ resolveWithObject: true });
  const { data: fg, info } = await draw(style.fg);
  if (!style.bg) {
    // White words over anything: a soft wide shadow plus a tight one, nudged down a few pixels.
    const pad = 18;
    const { data: dark } = await draw('#000000');
    const shadow = async (blur: number) => S(dark).extend({ top: pad + 3, bottom: pad - 3, left: pad, right: pad, background: { r: 0, g: 0, b: 0, alpha: 0 } }).blur(blur).png().toBuffer();
    const [wide, tight] = await Promise.all([shadow(7), shadow(1.6)]);
    return S(wide).composite([{ input: tight }, { input: fg, top: pad, left: pad }]).png().toBuffer();
  }
  const padX = Math.round(px * 0.45);
  const padY = Math.round(px * 0.26);
  const w = info.width + 2 * padX;
  const h = info.height + 2 * padY;
  const r = Math.round(Math.min(h / 2, px * 0.42));
  const box = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${style.bg}" fill-opacity="${style.bgOpacity}"/></svg>`);
  return S(box).composite([{ input: fg, top: padY, left: padX }]).png().toBuffer();
}

async function stickerPng(o: Overlay): Promise<Buffer> {
  const S = await sharp();
  let name = notoName(o.emoji!);
  const file = cachePath(`sticky/emoji/${name}`);
  if (!fs.existsSync(file)) {
    let res = await fetchNoto(name);
    if (res.status === 404 && name.includes('_')) {
      // A sequence Noto doesn't draw as one picture (rare ZWJ combos): fall back to its first emoji.
      name = notoName([...o.emoji!][0]);
      res = await fetchNoto(name);
    }
    if (!res.ok) throw new Error(`no sticker image for ${o.emoji} (HTTP ${res.status})`);
    await ensureDir(file);
    await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return S(file).resize(STICKER_PX[o.size]).png().toBuffer();
}

interface Box { left: number; top: number; width: number; height: number }

/** The overlay's PNG, shrunk if needed to fit the frame, and its box (centred on x, y). */
export async function place(o: Overlay): Promise<{ png: Buffer } & Box> {
  const S = await sharp();
  let png = o.kind === 'text' ? await textPng(o) : await stickerPng(o);
  let { width = 0, height = 0 } = await S(png).metadata();
  const maxW = CANVAS.w - 2 * MARGIN;
  if (width > maxW) {
    png = await S(png).resize({ width: maxW }).png().toBuffer();
    ({ width = 0, height = 0 } = await S(png).metadata());
  }
  const left = Math.round(clamp(o.x * CANVAS.w - width / 2, MARGIN, CANVAS.w - width - MARGIN));
  const top = Math.round(clamp(o.y * CANVAS.h - height / 2, MARGIN, CANVAS.h - height - MARGIN));
  return { png, left, top, width, height };
}

const GAP = 10;
const hits = (a: Box, b: Box) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/**
 * Nudge a box off anything already placed that is on screen at the same time ("a 🔥 top right" under a
 * title): just below the box it hits, or just above when there's no room below. Exported for tests.
 */
export function avoid(box: Box, placed: Box[]): Box {
  let b = { ...box };
  for (let tries = 0; tries < placed.length + 1; tries++) {
    const hit = placed.find((p) => hits(b, p));
    if (!hit) return b;
    const below = hit.top + hit.height + GAP;
    const above = hit.top - b.height - GAP;
    if (below + b.height <= CANVAS.h - MARGIN) b = { ...b, top: below };
    else if (above >= MARGIN) b = { ...b, top: above };
    else return b; // nowhere clean to go; overlap beats leaving the frame
  }
  return b;
}

const sec = (ms: number) => (ms / 1000).toFixed(3);

/**
 * Burn the overlays into a rendered cut. Same length, same encoder settings as the render, audio copied.
 * Each PNG is looped as a stream so its entrance can fade and slide over time.
 */
export async function burnOverlays(input: string, output: string, segments: Segment[], transitions: Transition[], overlays: Overlay[]): Promise<void> {
  const dir = cachePath(`tmp/overlays/${crypto.randomUUID()}`);
  await fsp.mkdir(dir, { recursive: true });
  try {
    const total = timeline(segments, transitions).totalMs;
    const windows = overlayWindows(overlays, segments, transitions);
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', input];
    const chains: string[] = [];
    let base = '0:v';
    const placed: Array<Box & { k: number }> = [];
    for (const [k, o] of overlays.entries()) {
      const { png, ...box } = await place(o);
      const sameTime = placed.filter((p) => windows[p.k].startMs < windows[k].endMs && windows[k].startMs < windows[p.k].endMs);
      const { left, top } = avoid(box, sameTime);
      placed.push({ ...box, left, top, k });
      const file = path.join(dir, `${o.id}.png`);
      await fsp.writeFile(file, png);
      args.push('-loop', '1', '-framerate', String(CANVAS.fps), '-t', sec(total), '-i', file);
      const n = k + 1; // input 0 is the cut
      const start = sec(windows[k].startMs);
      const end = sec(windows[k].endMs);
      const entranceS = o.animation === 'pop' ? 0.22 : 0.4;
      // 1 → 0 over the entrance, eased out (cubic).
      const ease = `pow(1-min(1,max(0,(t-${start})/${entranceS})),3)`;
      const dx = o.animation === 'slide_left' ? 140 : 0;
      const dy = o.animation === 'slide_up' ? 90 : o.animation === 'pop' ? 30 : 0;
      const fade = o.animation === 'none' ? '' : `,fade=t=in:st=${start}:d=${entranceS}:alpha=1`;
      chains.push(`[${n}:v]format=rgba${fade}[o${n}]`);
      const x = dx ? `${left}+${dx}*${ease}` : String(left);
      const y = dy ? `${top}+${dy}*${ease}` : String(top);
      chains.push(`[${base}][o${n}]overlay=x='${x}':y='${y}':enable='between(t,${start},${end})':eval=frame[b${n}]`);
      base = `b${n}`;
    }
    args.push(
      '-filter_complex', chains.join(';'),
      '-map', `[${base}]`, '-map', '0:a?', '-c:a', 'copy',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-profile:v', 'high', '-level:v', '4.1',
      '-pix_fmt', 'yuv420p', '-r', String(CANVAS.fps),
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
      '-movflags', '+faststart', output,
    );
    const t0 = Date.now();
    await execFileP('ffmpeg', args, { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
    log('overlays', { burned: overlays.length, ms: Date.now() - t0, what: describeOverlays(overlays).slice(0, 160) });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}
