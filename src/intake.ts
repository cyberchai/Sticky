/**
 * Source intake: download from Linq's CDN (pinned host, no redirects, byte cap) or pick up a browser
 * upload, keep the original, then normalize + make the Gemini proxy while the quiet window is open.
 */
import fs from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { LIMITS, config } from './config.js';
import { one, q } from './db.js';
import { isLinqMediaUrl, sendToChat, uploadAttachment } from './linq.js';
import { errMsg, log } from './log.js';
import { normalize, probe, proxy } from './media.js';
import { cachePath, ensureDir, ensureLocal, putFile } from './store.js';

/** A source whose bytes came from the browser: `upload:<store key>`. */
export const UPLOAD_SCHEME = 'upload:';

function byteCap(limit: number): Transform & { bytes: number } {
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      t.bytes += chunk.length;
      if (t.bytes > limit) cb(new Error('too_large'));
      else cb(null, chunk);
    },
  }) as Transform & { bytes: number };
  t.bytes = 0;
  return t;
}

function extFor(mime: string): string {
  switch (mime) {
    case 'video/quicktime': return 'mov';
    case 'video/x-m4v': return 'm4v';
    default: return 'mp4';
  }
}

export async function intakeSource(sourceId: string): Promise<void> {
  const src = await one(
    `UPDATE sticky.sources SET status = 'downloading', attempts = attempts + 1, updated_at = now()
     WHERE id = $1 AND status = 'pending' RETURNING *`,
    [sourceId],
  );
  if (!src) return;
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  try {
    const base = `sticky/${src.project_id}/${src.clip_id}`;
    const normKey = `${base}/norm.mp4`;
    const proxyKey = `${base}/proxy.mp4`;
    const normPath = cachePath(normKey);
    const proxyPath = cachePath(proxyKey);
    let originalKey: string;
    let originalPath: string;
    let keepOriginal: Promise<void>;
    let bytes: number;

    if (src.url.startsWith(UPLOAD_SCHEME)) {
      // Browser upload: already stored (and kept intact) under its own key by the upload route.
      originalKey = src.url.slice(UPLOAD_SCHEME.length);
      originalPath = await ensureLocal(originalKey);
      bytes = fs.statSync(originalPath).size;
      keepOriginal = Promise.resolve();
    } else {
      if (!isLinqMediaUrl(src.url)) throw new Error('not a Linq media URL');
      originalKey = `${base}/original.${extFor(src.mime)}`;
      originalPath = cachePath(originalKey);
      await ensureDir(originalPath);
      const res = await fetch(src.url, { redirect: 'manual', signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) throw new Error(`download HTTP ${res.status}`);
      const cap = byteCap(LIMITS.maxDownloadBytes);
      await pipeline(Readable.fromWeb(res.body as never), cap, fs.createWriteStream(originalPath));
      bytes = cap.bytes;
      keepOriginal = putFile(originalKey, originalPath, src.mime); // originals stay intact
    }
    timings.downloadMs = Date.now() - t0;
    await ensureDir(normPath);

    const info = await probe(originalPath);
    timings.originalMs = info.durationMs;
    const t1 = Date.now();
    await normalize(originalPath, normPath, info, LIMITS.maxSourceMs);
    timings.normalizeMs = Date.now() - t1;
    const norm = await probe(normPath);
    const t2 = Date.now();
    await proxy(normPath, proxyPath);
    timings.proxyMs = Date.now() - t2;
    await Promise.all([keepOriginal, putFile(normKey, normPath, 'video/mp4'), putFile(proxyKey, proxyPath, 'video/mp4')]);
    timings.totalMs = Date.now() - t0;

    await q(
      `UPDATE sticky.sources SET status = 'normalized', original_key = $2, norm_key = $3, proxy_key = $4, duration_ms = $5,
         has_audio = $6, width = $7, height = $8, color_transfer = $9, timings = $10, error = NULL, updated_at = now()
       WHERE id = $1`,
      [src.id, originalKey, normKey, proxyKey, norm.durationMs, info.hasAudio, info.width, info.height, info.colorTransfer, timings],
    );
    log('intake', {
      source: src.id, clip: src.clip_id, project: src.project_id, bytes,
      orig: `${info.width}x${info.height}r${info.rotation}`, hdr: info.colorTransfer, audio: info.hasAudio, durMs: norm.durationMs, ...timings,
    });

    if (config.echo) await echo(src.project_id, normKey, src.clip_id, norm.durationMs);
  } catch (err) {
    const failed = src.attempts >= 2;
    await q(`UPDATE sticky.sources SET status = $2, error = $3, timings = $4, updated_at = now() WHERE id = $1`, [src.id, failed ? 'failed' : 'pending', errMsg(err), timings]);
    log('intake', { source: src.id, clip: src.clip_id, failed: errMsg(err), final: failed }, 'warn');
  }
}

/** First-20-minute round-trip test: send the normalized clip straight back into the thread. */
async function echo(projectId: string, normKey: string, clipId: string, durMs: number): Promise<void> {
  const p = await one('SELECT chat_id FROM sticky.projects WHERE id = $1', [projectId]);
  const file = cachePath(normKey);
  const size = fs.statSync(file).size;
  const att = await uploadAttachment({ filename: `echo-${clipId}.mp4`, contentType: 'video/mp4', sizeBytes: size, body: fs.createReadStream(file) });
  const sent = await sendToChat(p.chat_id, [{ type: 'text', value: `echo ${clipId}: ${(durMs / 1000).toFixed(1)}s, normalized 720×1280` }, { type: 'media', attachment_id: att }]);
  log('echo', { project: projectId, clip: clipId, message: sent.providerMessageId, status: sent.status });
}
