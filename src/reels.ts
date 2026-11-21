/**
 * /live without a link: "my reels". A person is a phone number their browser remembers, plus the browser's
 * own web thread. Their reels are the projects of their one-on-one iMessage thread, of every group chat
 * they've been seen in (as a sender, or in a group's roster on any stored event), and of this browser's
 * thread. /live opens the newest in its live room; /live?all lists them by thread.
 *
 * OPEN BY DESIGN FOR NOW (no accounts), with one line held: a phone number is unverified, so reels found
 * by phone open as GUEST (watch, voice edits, notes; none of the host actions that text people: Finish,
 * contacts, invites). Host links go only to the browser's own web thread (its id is the credential, as on
 * the home page); an iMessage host gets theirs from the link texted with their first cut. Phone lookups
 * are rate-limited per IP. Before real users: a texted one-time code → session cookie.
 *
 *   GET /live            the page (web/reels.html)
 *   GET /live-api/mine   X-Sticky-Phone and/or X-Sticky-Thread → { sections, latest }
 */
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { ensureLive, normalizePhone } from './live.js';
import { last4, log } from './log.js';

const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'reels.html');
const THREAD = /^[a-f0-9]{32}$/;
const MAX_REELS = 40;
const LOOKUPS_PER_WINDOW = 20;
const WINDOW_MS = 10 * 60_000;

export interface Reel { projectId: string; title: string; versions: number; updatedAt: string; url: string; access: 'host' | 'guest' }
export interface Section { kind: 'you' | 'group'; label: string; reels: Reel[] }

/** A phone's one-on-one iMessage threads with Sticky. */
async function directChatsOf(phone: string): Promise<string[]> {
  const rows = await q<{ chat_id: string }>(`SELECT chat_id FROM sticky.threads WHERE phone = $1 AND NOT is_group`, [phone]);
  return rows.map((r) => r.chat_id);
}

/** Group chats a phone has been seen in: as a sender, or in a roster carried by any stored event. */
async function groupsOf(phone: string): Promise<string[]> {
  const rows = await q<{ chat_id: string }>(
    `SELECT DISTINCT e.chat_id FROM sticky.events e JOIN sticky.threads t ON t.chat_id = e.chat_id AND t.is_group
     WHERE e.payload->'data'->'sender_handle'->>'handle' = $1
        OR e.payload->'data'->'from_handle'->>'handle' = $1
        OR e.payload->'data'->>'from' = $1
        OR e.payload->'data'->'chat'->'handles' @> jsonb_build_array(jsonb_build_object('handle', $1::text))
        OR e.payload->'data'->'chat_handles' @> jsonb_build_array(jsonb_build_object('handle', $1::text))`,
    [phone],
  );
  return rows.map((r) => r.chat_id);
}

/** The phones seen sending in each group, for its label. */
async function sendersOf(chatIds: string[]): Promise<Map<string, string[]>> {
  if (!chatIds.length) return new Map();
  const rows = await q<{ chat_id: string; phones: string[] }>(
    `SELECT chat_id, array_agg(DISTINCT h ORDER BY h) AS phones FROM (
       SELECT chat_id, COALESCE(payload->'data'->'sender_handle'->>'handle', payload->'data'->'from_handle'->>'handle', payload->'data'->>'from') AS h
       FROM sticky.events WHERE chat_id = ANY($1)) x
     WHERE h LIKE '+%' GROUP BY chat_id`,
    [chatIds],
  );
  return new Map(rows.map((r) => [r.chat_id, r.phones]));
}

/** The other senders by last four, at most three shown: "Group · …0123, …4567 +2". */
function groupLabel(phones: string[], me: string | null): string {
  const others = phones.filter((p) => p !== me).map(last4);
  if (!others.length) return 'Group chat';
  const more = others.length > 3 ? ` +${others.length - 3}` : '';
  return `Group · ${others.slice(0, 3).join(', ')}${more}`;
}

/** Every reel with at least one cut, newest first, in sections: yours, then each group chat. */
export async function myReels(phone: string | null, thread: string | null): Promise<{ sections: Section[]; latest: string | null }> {
  const own = new Set(phone ? await directChatsOf(phone) : []);
  if (thread) own.add(`web:${thread}`);
  const groups = phone ? await groupsOf(phone) : [];
  const chats = [...new Set([...own, ...groups])];
  if (!chats.length) return { sections: [], latest: null };

  const projects = await q<{ id: string; chat_id: string; last_at: Date; versions: number; name: string | null }>(
    `SELECT p.id, p.chat_id, max(v.created_at) AS last_at, max(v.version_no) AS versions,
       (SELECT s.name FROM sticky.sources s WHERE s.project_id = p.id AND NOT s.generated ORDER BY s.clip_id LIMIT 1) AS name
     FROM sticky.projects p JOIN sticky.versions v ON v.project_id = p.id AND v.delivery NOT IN ('pending','superseded','failed')
     WHERE p.chat_id = ANY($1) GROUP BY p.id ORDER BY last_at DESC LIMIT ${MAX_REELS}`,
    [chats],
  );
  const hostOf = thread ? `web:${thread}` : null;
  const reels = await Promise.all(projects.map(async (p) => {
    const link = await ensureLive(p.id);
    const host = p.chat_id === hostOf; // proven by the browser's thread id; a typed phone number proves nothing
    const reel: Reel = {
      projectId: p.id,
      title: (p.name ?? 'Your reel').replace(/\.[^.]+$/, ''),
      versions: p.versions,
      updatedAt: p.last_at.toISOString(),
      url: host ? `/live/${link!.live_token}#host=${link!.host_key}` : `/live/${link!.live_token}`,
      access: host ? 'host' : 'guest',
    };
    return { chatId: p.chat_id, reel };
  }));

  // Reels are newest first, so a Map's insertion order puts groups in order of their newest reel.
  const mine: Reel[] = [];
  const byGroup = new Map<string, Reel[]>();
  for (const { chatId, reel } of reels) {
    if (own.has(chatId)) mine.push(reel);
    else byGroup.set(chatId, [...(byGroup.get(chatId) ?? []), reel]);
  }

  const senders = await sendersOf([...byGroup.keys()]);
  const sections: Section[] = [];
  if (mine.length) sections.push({ kind: 'you', label: 'You', reels: mine });
  for (const [chatId, groupReels] of byGroup) {
    sections.push({ kind: 'group', label: groupLabel(senders.get(chatId) ?? [], phone), reels: groupReels });
  }
  return { sections, latest: reels[0]?.reel.url ?? null };
}

/**
 * The client's address. Only the RIGHT-most X-Forwarded-For entry is trustworthy: Cloud Run's front end
 * appends the real client there, while anything to its left was sent by the client and can be faked.
 * Locally there's no proxy, so the socket address is the client.
 */
function clientIp(req: http.IncomingMessage): string {
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return forwarded[forwarded.length - 1] || req.socket.remoteAddress || 'unknown';
}

/** Phone lookups per client IP (per instance): slows anyone walking through numbers. */
const MAX_TRACKED = 10_000;
const lookups = new Map<string, number[]>();
function allowLookup(req: http.IncomingMessage): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (lookups.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  const allowed = recent.length < LOOKUPS_PER_WINDOW;
  if (allowed) recent.push(now);
  lookups.delete(ip); // re-insert so the Map's order is least- to most-recently seen
  lookups.set(ip, recent);
  // Bounded memory: drop the longest-idle addresses, never everyone's counts at once.
  for (const oldest of lookups.keys()) {
    if (lookups.size <= MAX_TRACKED) break;
    lookups.delete(oldest);
  }
  return allowed;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Returns true when the request was /live or /live-api/mine. */
export async function handleReels(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (url.pathname === '/live' && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(PAGE).pipe(res);
    return true;
  }
  if (url.pathname === '/live-api/mine' && req.method === 'GET') {
    // Headers, not the query string: phone numbers stay out of request logs and history.
    const rawPhone = String(req.headers['x-sticky-phone'] ?? '').trim();
    const phone = normalizePhone(rawPhone);
    if (rawPhone && !phone) { send(res, 400, { ok: false, error: 'That phone number doesn’t look right.' }); return true; }
    const rawThread = String(req.headers['x-sticky-thread'] ?? '');
    const thread = THREAD.test(rawThread) ? rawThread : null;
    if (!phone && !thread) { send(res, 400, { ok: false, error: 'Add your phone number.' }); return true; }
    if (phone && !allowLookup(req)) { send(res, 429, { ok: false, error: 'Too many lookups. Try again in a few minutes.' }); return true; }

    const { sections, latest } = await myReels(phone, thread);
    const shownPhone = phone ? last4(phone) : null;
    const count = sections.reduce((n, s) => n + s.reels.length, 0);
    log('reels', { phone: shownPhone, web: thread ? 'yes' : undefined, sections: sections.length, reels: count });
    send(res, 200, { ok: true, phone: shownPhone, sections, latest });
    return true;
  }
  return false;
}
