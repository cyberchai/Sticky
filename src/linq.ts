/**
 * Linq partner API v3 on Sticky's own Linq Sandbox account (separate from Asaply). Shapes adapted from
 * core-api: linqClient.ts `linqCall`, linqProvider.ts `uploadLinqAttachment` / `send`, photon.ts parts.
 * Sticky always posts into a known chat id (1:1 or group), so a reply can never land in another thread.
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { config } from './config.js';
import { errMsg, log } from './log.js';

export interface LinqResponse { status: number; body: any }

export async function linqCall(method: 'GET' | 'POST' | 'PUT' | 'PATCH', path: string, body?: unknown, timeoutMs = 8_000): Promise<LinqResponse> {
  if (!config.linq.apiKey) return { status: 0, body: { error: 'LINQ_API_KEY not set' } };
  try {
    const res = await fetch(`${config.linq.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.linq.apiKey}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    return { status: res.status, body: parsed };
  } catch (err) {
    return { status: 0, body: { error: errMsg(err) } };
  }
}

const ok = (r: LinqResponse) => r.status >= 200 && r.status < 300;

/** POST /attachments, then PUT the bytes to the presigned URL. Up to 100MB. Returns attachment_id. */
export async function uploadAttachment(file: {
  filename: string;
  contentType: string;
  sizeBytes: number;
  body: Buffer | NodeJS.ReadableStream;
}): Promise<string> {
  const created = await linqCall('POST', '/attachments', {
    filename: file.filename,
    content_type: file.contentType,
    size_bytes: file.sizeBytes,
  }, 15_000);
  const raw = (created.body ?? {}) as Record<string, any>;
  const data = (raw.data && typeof raw.data === 'object' ? raw.data : raw) as Record<string, any>;
  const uploadUrl = typeof data.upload_url === 'string' ? data.upload_url : '';
  const attachmentId = typeof data.attachment_id === 'string' ? data.attachment_id : typeof data.id === 'string' ? data.id : '';
  if (!ok(created) || !uploadUrl || !attachmentId) {
    throw new Error(`attachment create failed: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  }
  const required = (data.required_headers && typeof data.required_headers === 'object' ? data.required_headers : {}) as Record<string, string>;
  const isBuffer = Buffer.isBuffer(file.body);
  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.contentType, 'Content-Length': String(file.sizeBytes), ...required },
    body: (isBuffer ? file.body : Readable.toWeb(Readable.from(file.body as AsyncIterable<Uint8Array>))) as BodyInit,
    ...(isBuffer ? {} : { duplex: 'half' }),
    signal: AbortSignal.timeout(180_000),
  } as RequestInit);
  if (!put.ok) throw new Error(`attachment upload failed: HTTP ${put.status} ${(await put.text().catch(() => '')).slice(0, 200)}`);
  return attachmentId;
}

export type Part = { type: 'text'; value: string } | { type: 'media'; attachment_id: string };

export interface SendResult { status: number; providerMessageId: string | null; chatId: string | null; service: string | null; body: any }

function sendResult(r: LinqResponse): SendResult {
  const b = (r.body ?? {}) as Record<string, any>;
  return {
    status: r.status,
    providerMessageId: b?.message?.id ?? b?.data?.message?.id ?? b?.id ?? null,
    chatId: b?.chat_id ?? b?.chat?.id ?? b?.message?.chat_id ?? null,
    service: b?.message?.service ?? b?.service ?? b?.chat?.service ?? null,
    body: r.body,
  };
}

/** Post into an existing chat (the thread the footage came from). Throws on a non-2xx. */
export async function sendToChat(chatId: string, parts: Part[]): Promise<SendResult> {
  const r = await linqCall('POST', `/chats/${encodeURIComponent(chatId)}/messages`, { message: { parts } }, 20_000);
  if (!ok(r)) throw new Error(`send failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  void maybeShareContactCard(chatId);
  return sendResult(r);
}

// ---------------------------------------------------------------------------------------------
// Contact card: "Sticky" with the yellow logo, via iMessage Name and Photo Sharing.
// Configure once per number (scripts/linq-contact-card.ts), then share into each chat after an outbound
// message, at most once a day (Linq shows the prompt at most once per 24 h anyway).
// ---------------------------------------------------------------------------------------------

const sharedAt = new Map<string, number>();
const DAY = 24 * 60 * 60 * 1000;

export async function maybeShareContactCard(chatId: string): Promise<void> {
  if (!config.contactCard) return;
  if (Date.now() - (sharedAt.get(chatId) ?? 0) < DAY) return;
  sharedAt.set(chatId, Date.now());
  try {
    const { one } = await import('./db.js');
    const claimed = await one(
      `UPDATE sticky.threads SET card_shared_at = now()
       WHERE chat_id = $1 AND (card_shared_at IS NULL OR card_shared_at < now() - interval '1 day') RETURNING chat_id`,
      [chatId],
    );
    if (!claimed) return;
    const r = await linqCall('POST', `/chats/${encodeURIComponent(chatId)}/share_contact_card`);
    log('card', { chat: chatId, shared: ok(r) ? 'yes' : `HTTP ${r.status}`, code: ok(r) ? undefined : r.body?.error?.code });
  } catch (err) {
    log('card', { chat: chatId, failed: errMsg(err) }, 'warn');
  }
}

/** Create or update the contact card on our line; returns the active card as Linq reports it. */
export async function ensureContactCard(phone: string, firstName: string, imageUrl: string, lastName = ''): Promise<LinqResponse> {
  const existing = await linqCall('GET', `/contact_card?phone_number=${encodeURIComponent(phone)}`);
  const cards: any[] = existing.body?.contact_cards ?? existing.body?.data ?? [];
  const body = { phone_number: phone, first_name: firstName, ...(lastName ? { last_name: lastName } : {}), image_url: imageUrl };
  return cards.some((c) => c?.phone_number === phone)
    ? linqCall('PATCH', '/contact_card', body, 20_000)
    : linqCall('POST', '/contact_card', body, 20_000);
}

/** Open a chat from our line to a phone (scripts/linq-check only). */
export async function openChat(from: string, to: string, parts: Part[]): Promise<SendResult> {
  const r = await linqCall('POST', '/chats', { from, to: [to], message: { parts } }, 20_000);
  if (!ok(r)) throw new Error(`open chat failed: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return sendResult(r);
}

export async function sendText(chatId: string, text: string): Promise<SendResult> {
  return sendToChat(chatId, [{ type: 'text', value: text }]);
}

/**
 * Standard Webhooks signature on a direct Linq subscription (copied from core-api linqWebhook.ts
 * `verifyLinqSignature`): HMAC-SHA256 over `${id}.${timestamp}.${rawBody}` with the base64-decoded
 * `whsec_` secret; one or more space-separated `v1,<base64>` entries; 5-minute skew.
 */
export function verifyLinqSignature(rawBody: string, headers: Record<string, string | string[] | undefined>, signingSecret: string, nowSec = Date.now() / 1000): boolean {
  const h = (name: string) => { const v = headers[name]; return Array.isArray(v) ? v[0] : v; };
  const id = h('webhook-id');
  const ts = h('webhook-timestamp');
  const sig = h('webhook-signature');
  if (!id || !ts || !sig || !signingSecret) return false;
  const age = Math.abs(nowSec - Number(ts));
  if (!Number.isFinite(age) || age > 300) return false;
  const key = Buffer.from(signingSecret.replace(/^whsec_/, ''), 'base64');
  const expected = Buffer.from(crypto.createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64'));
  return String(sig).split(/\s+/).some((entry) => {
    const candidate = Buffer.from(entry.split(',')[1] ?? '');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  });
}

/** Linq's own CDN only, HTTPS, no credentials/port (core-api chatPhotos.ts `isLinqMediaUrl`). */
export function isLinqMediaUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port
      && config.linq.mediaHosts.includes(u.hostname.toLowerCase().replace(/\.$/, ''));
  } catch {
    return false;
  }
}
