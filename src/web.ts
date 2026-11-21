/**
 * The browser channel. A browser thread is the chat "web:<32 hex>" (the id lives in the visitor's
 * localStorage and is the only credential, like an unguessable link). Uploads arrive in ≤8MB chunks
 * (Cloud Run caps one request at 32MB; phone clips are bigger), then the clips and any caption are
 * posted as the same Linq-shaped event the phone path produces, so routing, jobs, revisions,
 * "Why this cut?", KEEP and NEW REEL are the exact same code for both channels.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { WEB_PREFIX } from './channel.js';
import { LIMITS, config } from './config.js';
import { CONTACT_LIMIT, addContacts, joinUrl, listContacts, phonesIn, removeContact, textStickyLink, toE164 } from './contacts.js';
import { q } from './db.js';
import { acceptEvent } from './inbound.js';
import { UPLOAD_SCHEME } from './intake.js';
import { CODE, cleanName, createInvite, inviteExists, invitePeople, inviteStatus, inviteUrl, joinText, signUp } from './invites.js';
import { errMsg, log } from './log.js';
import { pollView } from './polls.js';
import { cachePath, ensureDir, putFile } from './store.js';
import { fmtCount } from './trends/outliers.js';
import { evidenceLabel } from './trends/select.js';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
const STATIC: Record<string, { file: string; type: string; cache: string }> = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
  '/assets/sticky-logo.gif': { file: 'sticky-logo.gif', type: 'image/gif', cache: 'public, max-age=86400' },
  '/assets/sticky-mark.svg': { file: 'sticky-mark.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
  // iMessage contact card photo (Linq fetches it by URL): yellow square, ink wordmark.
  '/assets/sticky-avatar.png': { file: 'sticky-avatar.png', type: 'image/png', cache: 'public, max-age=86400' },
  '/assets/sticky.svg': { file: 'sticky.svg', type: 'image/svg+xml', cache: 'public, max-age=86400' },
  '/join': { file: 'join.html', type: 'text/html; charset=utf-8', cache: 'no-cache' },
};

const ID = /^[a-f0-9]{32}$/;

// ---------------------------------------------------------------------------------------------
// Joining the free line: add a number to the 20-contact list, hand back the one-tap first text.
// ---------------------------------------------------------------------------------------------

/** At most `max` tries per IP in 10 minutes. */
function rateLimiter(max: number): (ip: string) => boolean {
  const hits = new Map<string, number[]>();
  return (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
    if (recent.length >= max) return false;
    recent.push(now);
    hits.set(ip, recent);
    return true;
  };
}
const joinAllowed = rateLimiter(6);
const groupAllowed = rateLimiter(10);
const BAD_GROUP_LINK = 'That group link doesn’t work. Ask for a new one.';

/**
 * The RIGHT-most X-Forwarded-For entry is the one Cloud Run's front end appends; the first is whatever
 * the client sent, so keying on it would let anyone fill the 20 slots by faking it.
 */
function clientIp(req: http.IncomingMessage): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return forwarded[forwarded.length - 1] ?? req.socket.remoteAddress ?? '';
}

async function qrPng(res: http.ServerResponse, link: string): Promise<void> {
  const png = await QRCode.toBuffer(link, { width: 640, margin: 1, color: { dark: '#361118', light: '#FDFB04' } });
  res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' });
  res.end(png);
}

function isAdmin(req: http.IncomingMessage, url: URL): boolean {
  if (!config.adminToken) return false;
  // Header only: a token in a query string ends up in request logs.
  const given = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(config.adminToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleJoin(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (p === '/join/qr.png' && req.method === 'GET') { await qrPng(res, joinUrl()); return true; }
  // Scan-to-join group chat (invites.ts): the same page, which reads the code from its path.
  const groupPage = /^\/join\/g\/([A-HJ-NP-Z2-9]{8})(\/qr\.png)?$/.exec(p);
  if (groupPage && (req.method === 'GET' || req.method === 'HEAD')) {
    if (groupPage[2]) await qrPng(res, inviteUrl(groupPage[1]));
    else serveStatic(req, res, STATIC['/join']);
    return true;
  }
  if (p === '/web/groups' && req.method === 'POST') {
    if (!groupAllowed(clientIp(req))) { send(res, 429, { ok: false, error: 'Too many new groups. Give it a few minutes.' }); return true; }
    const body = JSON.parse((await readRaw(req, 4 * 1024)).toString('utf8') || '{}');
    send(res, 200, { ok: true, ...await createInvite(cleanName(body.name)) });
    return true;
  }
  const groupStatus = /^\/web\/groups\/([A-HJ-NP-Z2-9]{8})$/.exec(p);
  if (groupStatus && req.method === 'GET') {
    const status = await inviteStatus(groupStatus[1]);
    if (!status) send(res, 404, { ok: false, error: BAD_GROUP_LINK });
    else send(res, 200, { ok: true, ...status });
    return true;
  }
  // The joiners' numbers, for the host's laptop only. Its key travels in a header, never the URL.
  const groupPeople = /^\/web\/groups\/([A-HJ-NP-Z2-9]{8})\/people$/.exec(p);
  if (groupPeople && req.method === 'GET') {
    const r = await invitePeople(groupPeople[1], String(req.headers['x-sticky-host'] ?? ''));
    if (!r) send(res, 403, { ok: false, error: 'Only the laptop that made this group can see its numbers.' });
    else send(res, 200, { ok: true, line: config.line, ...r });
    return true;
  }
  if (p === '/web/join' && req.method === 'GET') {
    const used = (await listContacts().catch(() => [] as string[])).length;
    send(res, 200, { line: config.line, used, limit: CONTACT_LIMIT, sms: textStickyLink() });
    return true;
  }
  if (p === '/web/join' && req.method === 'POST') {
    if (!joinAllowed(clientIp(req))) { send(res, 429, { ok: false, error: 'Too many tries. Give it a few minutes.' }); return true; }
    const body = JSON.parse((await readRaw(req, 4 * 1024)).toString('utf8') || '{}');
    const phone = toE164(String(body.phone ?? ''));
    if (!phone) { send(res, 400, { ok: false, error: 'That doesn’t look like a phone number.' }); return true; }
    const group = body.group == null ? null : String(body.group);
    if (group !== null && !(CODE.test(group) && await inviteExists(group))) { send(res, 404, { ok: false, error: BAD_GROUP_LINK }); return true; }
    const r = await addContacts([phone]);
    if (r.full.length) { send(res, 409, { ok: false, error: `Sticky's free line is full (${CONTACT_LIMIT} people).`, used: r.used }); return true; }
    if (r.failed.length) { send(res, 502, { ok: false, error: 'Linq didn’t accept that number. Try again?' }); return true; }
    // In a group, the first text says which one; Sticky adds them to its chat when that text arrives.
    if (group) await signUp(group, phone);
    const sms = textStickyLink(group ? joinText(group) : undefined);
    send(res, 200, { ok: true, status: r.added.length ? 'added' : 'already', line: config.line, sms, used: r.used, limit: CONTACT_LIMIT });
    return true;
  }
  if (p.startsWith('/admin/contacts')) {
    if (!isAdmin(req, url)) { send(res, 401, { ok: false }); return true; }
    if (req.method === 'GET') { send(res, 200, { contacts: await listContacts(), limit: CONTACT_LIMIT }); return true; }
    const body = JSON.parse((await readRaw(req, 16 * 1024)).toString('utf8') || '{}');
    if (p === '/admin/contacts/add' && req.method === 'POST') { send(res, 200, await addContacts(phonesIn(String(body.phones ?? '')))); return true; }
    if (p === '/admin/contacts/remove' && req.method === 'POST') {
      const phone = toE164(String(body.phone ?? ''));
      if (!phone) { send(res, 400, { ok: false, error: 'not a phone number' }); return true; }
      try {
        await removeContact(phone);
      } catch (err) {
        send(res, 502, { ok: false, error: errMsg(err), contacts: await listContacts().catch(() => null) });
        return true;
      }
      send(res, 200, { ok: true, contacts: await listContacts() });
      return true;
    }
  }
  return false;
}
const MAX_CHUNK = 9 * 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('chunk too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const partPath = (thread: string, uploadId: string) => cachePath(`sticky/web/${thread}/${uploadId}.part`);
const extFor = (mime: string, name: string) => {
  const fromName = /\.(mov|mp4|m4v|webm)$/i.exec(name)?.[1]?.toLowerCase();
  return fromName ?? (mime === 'video/quicktime' ? 'mov' : 'mp4');
};

function linqShaped(chatId: string, parts: unknown[]) {
  return {
    event_type: 'message.received',
    data: {
      id: `web-msg-${crypto.randomUUID()}`,
      direction: 'inbound',
      chat: { id: chatId, is_group: false, owner_handle: { handle: 'web' } },
      sender_handle: { handle: 'web', is_me: false },
      parts,
      service: 'web',
    },
  };
}

async function ingestWeb(payload: unknown): Promise<void> {
  const eventId = `web-${crypto.randomUUID()}`;
  const { after } = await acceptEvent(JSON.stringify(payload), eventId);
  for (const fn of after) void fn().catch((err) => log('after', { event: eventId, error: errMsg(err) }, 'warn'));
}

async function threadState(thread: string): Promise<unknown> {
  const chatId = `${WEB_PREFIX}${thread}`;
  const projects = await q(`SELECT id, state, direction, kept_version, created_at FROM sticky.projects WHERE chat_id = $1 ORDER BY created_at DESC LIMIT 12`, [chatId]);
  const ids = projects.map((p: any) => p.id);
  const [sources, versions, jobs, replies, current, sent, polls] = await Promise.all([
    ids.length ? q(`SELECT project_id, clip_id, name, status, duration_ms, has_audio, width, height, error, generated FROM sticky.sources WHERE project_id = ANY($1::uuid[]) ORDER BY clip_id`, [ids]) : [],
    ids.length ? q(`SELECT project_id, version_no, segments, technique, explanation, direction, duration_ms, link_token, kept, delivery, created_at, music FROM sticky.versions WHERE project_id = ANY($1::uuid[]) AND delivery NOT IN ('pending','superseded','failed') ORDER BY version_no`, [ids]) : [],
    ids.length ? q(`SELECT project_id, kind, status, stage, stage_ms, direction, error, created_at, finished_at FROM sticky.jobs WHERE project_id = ANY($1::uuid[]) ORDER BY created_at`, [ids]) : [],
    q(`SELECT id, body, created_at FROM sticky.web_messages WHERE chat_id = $1 ORDER BY id DESC LIMIT 40`, [chatId]),
    q(`SELECT current_project_id FROM sticky.threads WHERE chat_id = $1`, [chatId]),
    q(`SELECT kind, payload->'data'->'parts' AS parts, received_at FROM sticky.events WHERE chat_id = $1 AND kind IN ('text','video') ORDER BY received_at DESC LIMIT 40`, [chatId]),
    // The latest "want any of these?" poll per reel (src/polls.ts), shown as chips.
    ids.length ? q(`SELECT DISTINCT ON (project_id) project_id, message_id, options FROM sticky.polls WHERE project_id = ANY($1::uuid[]) ORDER BY project_id, created_at DESC`, [ids]) : [],
  ]);
  // One conversation, oldest first: what the visitor sent and what Sticky answered.
  const conversation = [
    ...sent.map((e: any) => {
      const parts: any[] = Array.isArray(e.parts) ? e.parts : [];
      const clips = parts.filter((x) => x?.type === 'media').length;
      const text = parts.filter((x) => x?.type === 'text').map((x) => x.value).join(' ');
      return { from: 'you', body: [clips ? `${clips} clip${clips > 1 ? 's' : ''}` : '', text].filter(Boolean).join(' · '), at: e.received_at };
    }),
    ...replies.map((m: any) => ({ from: 'sticky', body: m.body, at: m.created_at })),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const pollByProject = new Map(polls.map((x: any) => [x.project_id, pollView(x)]));
  return {
    line: config.line,
    currentProjectId: (current[0] as any)?.current_project_id ?? null,
    conversation,
    projects: projects.map((p: any) => ({
      ...p,
      sources: sources.filter((s: any) => s.project_id === p.id),
      poll: pollByProject.get(p.id) ?? null,
      jobs: jobs.filter((j: any) => j.project_id === p.id).map(({ project_id, ...j }: any) => j),
      versions: versions.filter((v: any) => v.project_id === p.id).map((v: any) => ({
        versionNo: v.version_no,
        url: `/v/${v.link_token}.mp4`,
        durationMs: v.duration_ms,
        kept: v.kept,
        createdAt: v.created_at,
        explanation: v.explanation,
        direction: v.direction,
        shots: v.segments.length,
        mutedShots: v.segments.filter((s: any) => s.audio === 'mute').length,
        music: v.music ? { label: v.music.label, mode: v.music.mode } : null,
        generatedShots: v.segments.filter((s: any) => sources.some((src: any) => src.project_id === p.id && src.generated && src.clip_id === s.clipId)).length,
        technique: {
          title: v.technique.title,
          kind: v.technique.kind,
          sourceName: v.technique.sourceName,
          url: v.technique.url,
          observedOn: v.technique.observedOn,
          evidence: evidenceLabel(v.technique),
          summary: v.technique.summary,
          hookEvidence: v.technique.hookEvidence ? {
            handle: v.technique.hookEvidence.handle,
            platform: v.technique.hookEvidence.platform,
            views: fmtCount(v.technique.hookEvidence.views),
            followers: fmtCount(v.technique.hookEvidence.followers),
            viewsPerFollower: v.technique.hookEvidence.viewsPerFollower,
            postLink: v.technique.hookEvidence.postLink,
            sharedPattern: v.technique.hookEvidence.sharedPattern,
            retrievedAt: v.technique.hookEvidence.retrievedAt,
          } : null,
        },
      })),
    })),
  };
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse, asset: { file: string; type: string; cache: string }): void {
  const file = path.join(WEB_DIR, asset.file);
  if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': asset.cache, 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') res.end();
  else fs.createReadStream(file).pipe(res);
}

/** Returns true when the request was a web-channel route. */
export async function handleWeb(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;
  if (await handleJoin(req, res, url)) return true;

  const asset = STATIC[p];
  if (asset && (req.method === 'GET' || req.method === 'HEAD')) { serveStatic(req, res, asset); return true; }

  // The thread id is the visitor's only credential, so it travels in a header and never in a URL
  // (URLs land in request logs, browser history and Referer headers).
  const isThreadRoute = p === '/web/thread' || p === '/web/clips' || p === '/web/messages' || p === '/web/poll-votes' || p.startsWith('/web/uploads/');
  if (!isThreadRoute) return false;
  const thread = String(req.headers['x-sticky-thread'] ?? '');
  if (!ID.test(thread)) { send(res, 400, { ok: false, error: 'missing or malformed X-Sticky-Thread header' }); return true; }

  const upload = /^\/web\/uploads\/([a-f0-9]{32})$/.exec(p);
  if (upload && req.method === 'POST') {
    const uploadId = upload[1];
    const offset = Number(url.searchParams.get('offset'));
    const total = Number(url.searchParams.get('total'));
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || total <= 0 || total > LIMITS.maxDownloadBytes) {
      send(res, 400, { ok: false, error: 'bad offset/total' });
      return true;
    }
    const file = partPath(thread, uploadId);
    await ensureDir(file);
    const have = fs.existsSync(file) ? fs.statSync(file).size : 0;
    if (offset !== have) { send(res, 409, { ok: false, size: have }); return true; } // client resumes from `size`
    const chunk = await readRaw(req, MAX_CHUNK);
    if (offset + chunk.length > total) { send(res, 400, { ok: false, error: 'past total' }); return true; }
    await fsp.appendFile(file, chunk);
    send(res, 200, { ok: true, size: have + chunk.length });
    return true;
  }

  if (p === '/web/clips' && req.method === 'POST') {
    const body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}');
    const list: any[] = Array.isArray(body.clips) ? body.clips.slice(0, LIMITS.maxClips) : [];
    if (!list.length) { send(res, 400, { ok: false, error: 'no clips' }); return true; }
    const parts: unknown[] = [];
    for (const c of list) {
      if (!ID.test(String(c.uploadId)) || !String(c.mime ?? '').startsWith('video/')) { send(res, 400, { ok: false, error: 'bad clip' }); return true; }
      const part = partPath(thread, c.uploadId);
      if (!fs.existsSync(part) || fs.statSync(part).size !== Number(c.total)) { send(res, 409, { ok: false, error: `upload ${c.uploadId} incomplete` }); return true; }
      const name = String(c.name ?? 'clip').slice(0, 120);
      const key = `sticky/web/${thread}/${c.uploadId}.${extFor(c.mime, name)}`;
      await ensureDir(cachePath(key));
      await fsp.rename(part, cachePath(key));
      await putFile(key, cachePath(key), c.mime); // the original, kept intact
      parts.push({ type: 'media', id: c.uploadId, mime_type: c.mime, url: `${UPLOAD_SCHEME}${key}`, filename: name, size_bytes: Number(c.total) });
    }
    const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0, 500) : '';
    if (caption) parts.push({ type: 'text', value: caption });
    await ingestWeb(linqShaped(`${WEB_PREFIX}${thread}`, parts));
    send(res, 202, { ok: true });
    return true;
  }

  // A tapped suggestion chip: the same poll.vote.added event an iMessage vote is, so one code path handles both.
  if (p === '/web/poll-votes' && req.method === 'POST') {
    const body = JSON.parse((await readRaw(req, 4 * 1024)).toString('utf8') || '{}');
    const messageId = String(body.messageId ?? '');
    const optionId = String(body.optionId ?? '');
    if (!/^web-poll-[0-9a-f-]{36}$/.test(messageId) || !/^[0-9a-f-]{36}$/.test(optionId)) { send(res, 400, { ok: false }); return true; }
    const chatId = `${WEB_PREFIX}${thread}`;
    const owned = await q(`SELECT 1 FROM sticky.polls WHERE message_id = $1 AND chat_id = $2`, [messageId, chatId]);
    if (!owned.length) { send(res, 404, { ok: false }); return true; }
    const { after } = await acceptEvent(JSON.stringify({
      event_type: 'poll.vote.added',
      data: { message_id: messageId, option_id: optionId, direction: 'inbound', chat: { id: chatId, is_group: false }, sender_handle: { handle: 'web', is_me: false } },
    }), `web-vote-${crypto.randomUUID()}`);
    for (const fn of after) void fn().catch((err) => log('after', { vote: messageId, error: errMsg(err) }, 'warn'));
    send(res, 202, { ok: true });
    return true;
  }

  if (p === '/web/messages' && req.method === 'POST') {
    const body = JSON.parse((await readRaw(req, 16 * 1024)).toString('utf8') || '{}');
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : '';
    if (!text) { send(res, 400, { ok: false, error: 'empty' }); return true; }
    await ingestWeb(linqShaped(`${WEB_PREFIX}${thread}`, [{ type: 'text', value: text }]));
    send(res, 202, { ok: true });
    return true;
  }

  if (p === '/web/thread' && req.method === 'GET') {
    send(res, 200, await threadState(thread));
    return true;
  }

  send(res, 405, { ok: false });
  return true;
}
