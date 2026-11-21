/**
 * Deliver a rendered version into its own thread, once. Older jobs never overwrite a newer version or a
 * newly started project. If the attachment path fails, the same MP4 goes out as a tap-to-play link and
 * the run is recorded as degraded.
 */
import fs from 'node:fs';
import { isWebChat, say } from './channel.js';
import { COPY, config } from './config.js';
import { one, q } from './db.js';
import { sendToChat, uploadAttachment } from './linq.js';
import { liveLinkLine, liveVersionReady } from './live.js';
import { errMsg, log } from './log.js';
import { ensureLocal } from './store.js';

export type DeliveryOutcome = 'accepted' | 'link_degraded' | 'superseded' | 'failed' | 'skipped';

export async function deliverVersion(versionId: string): Promise<DeliveryOutcome> {
  const v = await one(`UPDATE sticky.versions SET delivery = 'sending' WHERE id = $1 AND delivery = 'pending' RETURNING *`, [versionId]);
  if (!v) return 'skipped';
  const ctx = await one(
    `SELECT p.chat_id, t.current_project_id,
       EXISTS (SELECT 1 FROM sticky.versions n WHERE n.project_id = p.id AND n.version_no > $2
               AND n.delivery IN ('sending','accepted','delivered','link_degraded')) AS newer
     FROM sticky.projects p JOIN sticky.threads t ON t.chat_id = p.chat_id WHERE p.id = $1`,
    [v.project_id, v.version_no],
  );
  if (!ctx || ctx.current_project_id !== v.project_id || ctx.newer) {
    await q(`UPDATE sticky.versions SET delivery = 'superseded' WHERE id = $1`, [v.id]);
    log('deliver', { version: v.id, project: v.project_id, v: v.version_no, outcome: 'superseded' });
    return 'superseded';
  }
  // Made in a live session: everyone in the room sees it at once; only the host's Finish texts a cut.
  if (v.channel === 'live') {
    await q(`UPDATE sticky.versions SET delivery = 'delivered', accepted_at = now(), delivered_at = now() WHERE id = $1`, [v.id]);
    await liveVersionReady(v.project_id, v.version_no, v.explanation);
    log('deliver', { version: v.id, project: v.project_id, v: v.version_no, outcome: 'live' });
    return 'accepted';
  }
  // Browser thread: the page plays the version from /v/<token>.mp4; it is delivered the moment it exists.
  if (isWebChat(ctx.chat_id)) {
    await q(`UPDATE sticky.versions SET delivery = 'delivered', accepted_at = now(), delivered_at = now() WHERE id = $1`, [v.id]);
    await say(ctx.chat_id, COPY.delivered, v.id);
    log('deliver', { version: v.id, project: v.project_id, v: v.version_no, outcome: 'web' });
    return 'accepted';
  }
  if (config.forceLink) return sendLinkFallback(v.id, 'STICKY_FORCE_LINK');
  const t0 = Date.now();
  try {
    const file = await ensureLocal(v.out_key);
    const size = fs.statSync(file).size;
    const attachmentId = await uploadAttachment({ filename: `sticky-v${v.version_no}.mp4`, contentType: 'video/mp4', sizeBytes: size, body: fs.createReadStream(file) });
    const uploadMs = Date.now() - t0;
    // The first cut also carries the link to open this reel live in a browser.
    const liveLine = v.version_no === 1 ? await liveLinkLine(v.project_id).catch(() => '') : '';
    const sent = await sendToChat(ctx.chat_id, [{ type: 'text', value: COPY.delivered + liveLine }, { type: 'media', attachment_id: attachmentId }]);
    await q(`UPDATE sticky.versions SET delivery = 'accepted', provider_message_id = $2, accepted_at = now() WHERE id = $1`, [v.id, sent.providerMessageId]);
    log('deliver', { version: v.id, project: v.project_id, v: v.version_no, outcome: 'accepted', message: sent.providerMessageId, service: sent.service, bytes: size, uploadMs, sendMs: Date.now() - t0 - uploadMs });
    return 'accepted';
  } catch (err) {
    log('deliver', { version: v.id, attachment: 'failed', error: errMsg(err) }, 'warn');
    return sendLinkFallback(v.id, errMsg(err));
  }
}

export async function sendLinkFallback(versionId: string, reason: string): Promise<DeliveryOutcome> {
  const v = await one(
    `SELECT v.*, p.chat_id FROM sticky.versions v JOIN sticky.projects p ON p.id = v.project_id WHERE v.id = $1`,
    [versionId],
  );
  if (!v) return 'skipped';
  if (!config.publicBaseUrl) {
    await q(`UPDATE sticky.versions SET delivery = 'failed' WHERE id = $1`, [v.id]);
    await say(v.chat_id, COPY.failed('delivery')).catch(() => {});
    log('deliver', { version: v.id, outcome: 'failed', reason, note: 'no STICKY_PUBLIC_BASE_URL for link fallback' }, 'error');
    return 'failed';
  }
  const url = `${config.publicBaseUrl}/v/${v.link_token}.mp4`;
  try {
    const messageId = await say(v.chat_id, COPY.linkFallback(url));
    await q(`UPDATE sticky.versions SET delivery = 'link_degraded', provider_message_id = $2, accepted_at = COALESCE(accepted_at, now()) WHERE id = $1`, [v.id, messageId]);
    log('deliver', { version: v.id, v: v.version_no, outcome: 'link_degraded', reason });
    return 'link_degraded';
  } catch (err) {
    await q(`UPDATE sticky.versions SET delivery = 'failed' WHERE id = $1`, [v.id]);
    log('deliver', { version: v.id, outcome: 'failed', reason, error: errMsg(err) }, 'error');
    return 'failed';
  }
}
