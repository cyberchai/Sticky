/**
 * Live sessions: a reel opened in the browser by its host and anyone they invite, like a video call
 * about the cut. Everyone sees each other (WebRTC, peer to peer), points at the frame with a hand the
 * browser tracks, and talks to Sticky ("Sticky, add a dog here"). A pointed command is grounded first:
 * the frame they pointed at, marked, goes to Gemini, which names the spot in scene terms, and that
 * phrase rides into the normal revise job (so Omni puts the dog THERE). Versions made here are not
 * texted; the host's Finish texts the chosen cut to the host's phone.
 *
 * Realtime: sticky.live_events rows + NOTIFY, so each instance fans out to its own SSE subscribers and
 * a reconnecting browser replays what it missed; job/version progress arrives through triggers
 * (migrations/005_live.sql), so the worker never needs to know a room exists.
 *
 *   GET  /live/:token                    the page (guest link; the host's link adds #host=<key>, a fragment,
 *                                        so the key never reaches the server, its logs or a Referer)
 *   POST /live-api/open                  {thread, projectId} → host link for a browser thread's reel
 *   GET  /live-api/:token/state          reel, versions with lineage, jobs, notes, network, who's here
 *   GET  /live-api/:token/stream         SSE: presence, signaling, room events
 *   POST /live-api/:token/{join,leave,signal,say,note,contact,invite,phone,finish}
 */
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { db, one, q } from './db.js';
import { fmtMs, type Segment } from './edl.js';
import { whyThisCut } from './explain.js';
import { routeText } from './gemini.js';
import { openChat, sendToChat, uploadAttachment, type Part } from './linq.js';
import { errMsg, last4, log } from './log.js';
import { ensureDir, ensureLocal } from './store.js';

const execFileP = promisify(execFile);
const PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'live.html');
const ID = /^[a-f0-9]{32}$/;
const HANDLE = /^[a-f0-9]{12}$/;
const COLORS = ['#E4572E', '#2E86AB', '#7B2CBF', '#1F7A4D', '#D1495B', '#F18F01', '#3D5A80', '#C2185B'];
/** Words that make a spoken command depend on where the speaker is pointing. */
const DEICTIC = /\b(here|there|this|that|these|those|right where)\b/i;
/** "note for Sam: …", "add a note …", "tag …": a note, not an edit. web/live.html uses the same pattern. */
const NOTE = /^(?:(?:add|leave|make|take|drop)\s+(?:a\s+)?)?note\b[\s,.:;-]*|^tag\b[\s,.:;-]*/i;

const hex = (bytes: number) => crypto.randomBytes(bytes).toString('hex');
// channel.ts's isWebChat, kept local because channel.ts imports this module.
const isWeb = (chatId: string) => chatId.startsWith('web:');
const pct = (n: number) => `${Math.round(n * 100)}%`;
const colorOf = (peer: string) => COLORS[parseInt(peer.slice(0, 6), 16) % COLORS.length];
const cleanName = (raw: unknown) => String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

function iceServers(): unknown[] {
  try {
    const custom = JSON.parse(process.env.STICKY_ICE_SERVERS || 'null');
    if (Array.isArray(custom) && custom.length) return custom;
  } catch { /* fall through */ }
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
}

/** E.164 or null. Ten bare digits are read as a US number. */
export function normalizePhone(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  let e164 = '';
  if (s.startsWith('+')) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  return /^\+\d{10,15}$/.test(e164) ? e164 : null;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage, limit = 64 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { resolve({}); } });
    req.on('error', reject);
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------------------------

/** The reel's guest token and host key: minted on first use, stable after. */
export async function ensureLive(projectId: string): Promise<{ live_token: string; host_key: string } | null> {
  return one(
    `UPDATE sticky.projects SET live_token = COALESCE(live_token, $2), host_key = COALESCE(host_key, $3) WHERE id = $1 RETURNING live_token, host_key`,
    [projectId, hex(16), hex(16)],
  );
}

/** The line appended to a texted first cut, so the person who texted can open the reel in a browser. */
export async function liveLinkLine(projectId: string): Promise<string> {
  if (!config.publicBaseUrl) return '';
  const r = await ensureLive(projectId);
  return r ? `\nEdit it live with anyone you invite: ${config.publicBaseUrl}/live/${r.live_token}#host=${r.host_key}` : '';
}

const guestLink = (token: string) => (config.publicBaseUrl ? `${config.publicBaseUrl}/live/${token}` : '');

// ---------------------------------------------------------------------------------------------
// Room events: rows + NOTIFY → every instance's SSE subscribers
// ---------------------------------------------------------------------------------------------

interface Sub { peerId: string; res: http.ServerResponse }
const subs = new Map<string, Set<Sub>>();
const stateTimers = new Map<string, NodeJS.Timeout>();
let listener: Promise<void> | null = null;

export async function emit(projectId: string, type: string, payload: unknown = {}, opts: { to?: string | null; from?: string | null } = {}): Promise<void> {
  await q(
    `WITH e AS (INSERT INTO sticky.live_events (project_id, to_peer, from_peer, type, payload) VALUES ($1,$2,$3,$4,$5) RETURNING id, project_id)
     SELECT pg_notify('sticky_live', e.project_id::text || ':' || e.id::text) FROM e`,
    [projectId, opts.to ?? null, opts.from ?? null, type, JSON.stringify(payload)],
  );
}

/** Sticky talking in the room. */
const reply = (projectId: string, text: string, extra: Record<string, unknown> = {}) =>
  emit(projectId, 'sticky', { text, ...extra }).catch((err) => log('live', { project: projectId, reply: 'failed', error: errMsg(err) }, 'warn'));

function write(sub: Sub, row: { id: number | string; type: string; from_peer: string | null; payload: unknown }): void {
  sub.res.write(`id: ${row.id}\ndata: ${JSON.stringify({ type: row.type, from: row.from_peer, payload: row.payload })}\n\n`);
}

function dispatch(row: any): void {
  for (const sub of subs.get(row.project_id) ?? []) {
    if (row.to_peer && row.to_peer !== sub.peerId) continue;
    if (row.from_peer && row.from_peer === sub.peerId) continue;
    write(sub, row);
  }
}

function bumpState(projectId: string): void {
  if (!subs.has(projectId) || stateTimers.has(projectId)) return;
  stateTimers.set(projectId, setTimeout(() => {
    stateTimers.delete(projectId);
    for (const sub of subs.get(projectId) ?? []) sub.res.write(`data: ${JSON.stringify({ type: 'state' })}\n\n`);
  }, 250));
}

function ensureListener(): void {
  if (listener) return;
  listener = (async () => {
    const client = await db().connect();
    let dead = false;
    const restart = (why: string) => {
      if (dead) return;
      dead = true;
      log('live', { listener: 'lost', why }, 'warn');
      try { client.release(true); } catch { /* already gone */ }
      listener = null;
      setTimeout(ensureListener, 2000).unref();
    };
    client.on('error', (err) => restart(errMsg(err)));
    client.on('end', () => restart('connection ended'));
    client.on('notification', (n) => {
      const payload = n.payload ?? '';
      if (n.channel === 'sticky_live_state') return bumpState(payload);
      const [projectId, id] = payload.split(':');
      if (!subs.has(projectId)) return;
      void one('SELECT * FROM sticky.live_events WHERE id = $1', [Number(id)])
        .then((row) => { if (row) dispatch(row); })
        .catch((err) => log('live', { dispatch: 'failed', error: errMsg(err) }, 'warn'));
    });
    await client.query('LISTEN sticky_live');
    await client.query('LISTEN sticky_live_state');
    log('live', { listening: true });
  })().catch((err) => {
    log('live', { listener: 'failed', error: errMsg(err) }, 'error');
    listener = null;
    setTimeout(ensureListener, 5000).unref();
  });
  startSweeper();
}

let sweeping = false;
function startSweeper(): void {
  if (sweeping) return;
  sweeping = true;
  setInterval(() => {
    void q(`DELETE FROM sticky.live_presence WHERE last_seen < now() - interval '30 seconds' RETURNING project_id, peer_id`)
      .then((gone) => Promise.all(gone.map((g: any) => emit(g.project_id, 'leave', { peer: g.peer_id }, { from: g.peer_id }))))
      .catch((err) => log('live', { sweep: 'failed', error: errMsg(err) }, 'warn'));
  }, 10_000).unref();
  setInterval(() => {
    void q(`DELETE FROM sticky.live_events WHERE created_at < now() - interval '6 hours'`).catch(() => {});
  }, 10 * 60_000).unref();
}

/**
 * While a job asked for in a live session is running (or has just failed), Sticky's progress texts
 * ("Editing your footage with Gemini Omni…") belong in the room, not in the host's iMessage thread.
 */
export async function liveRelay(chatId: string, text: string): Promise<boolean> {
  const job = await one(
    `SELECT j.project_id FROM sticky.jobs j JOIN sticky.projects p ON p.id = j.project_id
     WHERE p.chat_id = $1 AND j.channel = 'live'
       AND (j.status = 'running' OR (j.status = 'failed' AND j.finished_at > now() - interval '10 seconds'))
     ORDER BY j.created_at DESC LIMIT 1`,
    [chatId],
  );
  if (!job) return false;
  await emit(job.project_id, 'sticky', { text });
  return true;
}

/** deliver.ts: a version made in the room is ready (the triggers already refresh everyone's state). */
export async function liveVersionReady(projectId: string, versionNo: number, explanation: string): Promise<void> {
  await reply(projectId, `v${versionNo} is ready. ${explanation}`.trim(), { versionNo });
}

// ---------------------------------------------------------------------------------------------
// Grounding: "here" → a phrase Omni can act on
// ---------------------------------------------------------------------------------------------

let genai: GoogleGenAI | null = null;
const ai = () => (genai ??= config.gemini.apiKey
  ? new GoogleGenAI({ apiKey: config.gemini.apiKey })
  : new GoogleGenAI({ vertexai: true, project: config.gemini.project, location: config.gemini.location }));

function segmentAt(segments: Segment[], atMs: number): Segment | null {
  let start = 0;
  for (const s of segments) {
    const d = s.outMs - s.inMs;
    if (atMs < start + d) return s;
    start += d;
  }
  return segments[segments.length - 1] ?? null;
}

/** The frame they pointed at, with the spot marked, described in scene terms by Gemini. */
async function ground(outKey: string, durationMs: number, atMs: number, x: number, y: number, said: string): Promise<string | null> {
  const file = await ensureLocal(outKey);
  const frame = path.join(config.workDir, 'live', `${hex(8)}.jpg`);
  await ensureDir(frame);
  const at = Math.max(0, Math.min(atMs, durationMs - 120)) / 1000;
  const box = (size: number, t: string) => `drawbox=x=iw*${x.toFixed(4)}-${size / 2}:y=ih*${y.toFixed(4)}-${size / 2}:w=${size}:h=${size}:color=red@0.95:t=${t}`;
  try {
    await execFileP('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', at.toFixed(3), '-i', file, '-frames:v', '1', '-vf', `${box(110, '6')},${box(14, 'fill')}`, '-q:v', '4', frame], { timeout: 20_000 });
    const image = await fsp.readFile(frame);
    const t0 = Date.now();
    const res = await Promise.race([
      ai().models.generateContent({
        model: config.gemini.fallbackModel,
        contents: [{
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: image.toString('base64') } },
            { text: `Someone editing this vertical video on a call said “${said}” while pointing at the spot marked by the red square. Describe that spot so a video-editing model can put something exactly there: the surface, object or area it is on or next to, and where it sits in the frame (left/center/right, top/middle/bottom, foreground/background). One phrase, at most 18 words. Never mention the red square or the marker.` },
          ],
        }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: { type: 'object', properties: { where: { type: 'string' } }, required: ['where'] },
          // A short look, not a deliberation: this runs while the room waits.
          ...(/gemini-3/.test(config.gemini.fallbackModel) ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {}),
        } as any,
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('grounding timed out')), 20_000)),
    ]);
    const raw = String(JSON.parse((res.text ?? '{}').replace(/^```(?:json)?\s*|\s*```$/g, '')).where ?? '').trim().replace(/\.$/, '');
    const where = raw.charAt(0).toLowerCase() + raw.slice(1); // it continues a sentence ("the spot is …")
    log('live', { grounded: where.slice(0, 120), ms: Date.now() - t0, x: x.toFixed(2), y: y.toFixed(2), atMs });
    return where || null;
  } finally {
    await fsp.rm(frame, { force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

interface Person { id: string; handle: string; name: string; phone: string | null }
interface Anchor { versionNo: number | null; atMs: number; x: number; y: number }

function anchorOf(raw: any): Anchor | null {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const atMs = Math.round(Number(raw.atMs));
  if (![x, y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) || !Number.isFinite(atMs) || atMs < 0) return null;
  const v = Number(raw.versionNo);
  return { versionNo: Number.isInteger(v) && v > 0 ? v : null, atMs, x, y };
}

const latestShown = (projectId: string) => one(
  `SELECT * FROM sticky.versions WHERE project_id = $1 AND delivery NOT IN ('pending','superseded','failed') ORDER BY version_no DESC LIMIT 1`,
  [projectId],
);

async function handleSay(project: any, person: Person, peer: string, text: string, anchor: Anchor | null): Promise<void> {
  if (NOTE.test(text)) {
    await createNote(project, person, text.replace(NOTE, '').trim() || text, anchor, []);
    return;
  }
  const latest = await latestShown(project.id);
  if (!latest) return void reply(project.id, 'Still cutting the first version. Say it again once it shows up.');
  const intent = await routeText({ text, state: project.state, hasCut: true }).catch(() => 'revise' as const);
  log('live', { project: project.id, intent, from: person.handle, text: text.slice(0, 80), pointed: Boolean(anchor) });
  switch (intent) {
    case 'why':
      return void reply(project.id, whyThisCut({
        segments: latest.segments, technique: latest.technique, analysis: project.analysis,
        explanation: latest.explanation, direction: latest.direction, versionNo: latest.version_no, music: latest.music,
      }));
    case 'keep':
      await q('UPDATE sticky.versions SET kept = true WHERE id = $1', [latest.id]);
      await q('UPDATE sticky.projects SET kept_version = $2 WHERE id = $1', [project.id, latest.version_no]);
      return void reply(project.id, `Saved v${latest.version_no}. The host can text it with Finish.`);
    case 'revise':
      return queueEdit(project, person, peer, text, anchor, latest);
    default:
      return void reply(project.id, 'Point at the frame and say “Sticky, add a dog here”, ask for a change to the cut, or say “Sticky, note for Sam: …”.');
  }
}

async function queueEdit(project: any, person: Person, peer: string, text: string, anchor: Anchor | null, latest: any): Promise<void> {
  let direction = text;
  let where: string | null = null;
  let stored: Record<string, unknown> = { said: text, ...anchor };
  if (anchor && DEICTIC.test(text)) {
    const viewed = anchor.versionNo && anchor.versionNo !== latest.version_no
      ? (await one(`SELECT * FROM sticky.versions WHERE project_id = $1 AND version_no = $2`, [project.id, anchor.versionNo])) ?? latest
      : latest;
    const sameCut = viewed.version_no === latest.version_no;
    const seg = sameCut ? segmentAt(latest.segments, anchor.atMs) : null;
    await emit(project.id, 'grounding', { said: text, handle: person.handle }, { from: peer });
    try {
      where = await ground(viewed.out_key, viewed.duration_ms, anchor.atMs, anchor.x, anchor.y, text);
    } catch (err) {
      log('live', { project: project.id, grounding: 'failed', error: errMsg(err).slice(0, 200) }, 'warn');
    }
    const spot = where ? `the spot is ${where}, ` : '';
    const cut = sameCut ? 'the current cut' : `v${viewed.version_no}`;
    direction = `${text}\n[They pointed while saying this: ${spot}${pct(anchor.x)} from the left and ${pct(anchor.y)} from the top of the frame, at ${fmtMs(anchor.atMs)} into ${cut}${seg ? ` (shot ${seg.id})` : ''}. Put the change at that spot${seg ? ' and apply it to that shot' : ''} unless they said otherwise.]`;
    stored = { ...stored, where, segmentId: seg?.id ?? null };
  }
  // The reel being edited live is the host's current reel (otherwise the worker would supersede it).
  await q(`UPDATE sticky.threads SET current_project_id = $2 WHERE chat_id = $1 AND current_project_id IS DISTINCT FROM $2`, [project.chat_id, project.id]);
  await q(`UPDATE sticky.projects SET state = 'delivered' WHERE id = $1 AND state IN ('closed','failed')`, [project.id]);
  const job = await one(
    `INSERT INTO sticky.jobs (project_id, kind, direction, inbound_at, channel, author_handle, author_name, anchor)
     VALUES ($1, 'revise', $2, now(), 'live', $3, $4, $5) RETURNING id`,
    [project.id, direction, person.handle, person.name, JSON.stringify(stored)],
  );
  const here = where ? ` “Here” = ${where}.` : '';
  await reply(project.id, `On it: “${text}” from ${person.name}.${here}`, { jobId: job?.id });
}

// ---------------------------------------------------------------------------------------------
// Notes, network, texting
// ---------------------------------------------------------------------------------------------

async function networkOf(chatId: string): Promise<Array<Person & { added_via: string }>> {
  return q(
    `SELECT p.id, p.handle, p.name, p.phone, n.added_via FROM sticky.network n JOIN sticky.people p ON p.id = n.person_id
     WHERE n.owner_chat_id = $1 ORDER BY lower(p.name)`,
    [chatId],
  );
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Explicit @handles from the composer, plus anyone in the network named in the text. */
function mentionsIn(body: string, explicit: string[], network: Person[]): string[] {
  const found = new Set(explicit.filter((h) => network.some((p) => p.handle === h)));
  for (const p of network) {
    const names = [p.name, p.name.split(/\s+/)[0]].filter((n) => n.length >= 2);
    if (names.some((n) => new RegExp(`(^|[^\\p{L}])@?${escapeRe(n)}(?![\\p{L}])`, 'iu').test(body))) found.add(p.handle);
  }
  return [...found];
}

/** Text from the Sticky line to a number (opens or reuses that chat). */
async function textPhone(phone: string, parts: Part[]): Promise<void> {
  await openChat(config.line, phone, parts);
}

async function createNote(project: any, author: Person, body: string, anchor: Anchor | null, explicit: string[]): Promise<void> {
  const network = await networkOf(project.chat_id);
  const mentions = mentionsIn(body, explicit, network);
  const note = (await one<{ id: string }>(
    `INSERT INTO sticky.notes (project_id, version_no, author_handle, author_name, body, mentions, at_ms, x, y)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [project.id, anchor?.versionNo ?? null, author.handle, author.name, body.slice(0, 1000), mentions, anchor?.atMs ?? null, anchor?.x ?? null, anchor?.y ?? null],
  ))!;
  await emit(project.id, 'note', { id: note.id, author: author.name, handle: author.handle, body: body.slice(0, 280) });
  if (!mentions.length) return;
  const link = guestLink(project.live_token);
  const at = anchor ? ` (at ${fmtMs(anchor.atMs)}${anchor.versionNo ? ` of v${anchor.versionNo}` : ''})` : '';
  const notified: Record<string, string> = {};
  for (const handle of mentions) {
    const p = network.find((n) => n.handle === handle);
    if (!p || p.id === author.id) continue;
    if (!p.phone) { notified[handle] = 'no_phone'; continue; }
    try {
      await textPhone(p.phone, [{ type: 'text', value: `${author.name} tagged you on a Sticky reel${at}: “${body.slice(0, 280)}”${link ? `\nJoin the edit: ${link}` : ''}` }]);
      notified[handle] = 'texted';
    } catch (err) {
      notified[handle] = 'failed';
      log('live', { note: note.id, tag: last4(p.phone), failed: errMsg(err).slice(0, 200) }, 'warn');
    }
  }
  await q(`UPDATE sticky.notes SET notified = $2 WHERE id = $1`, [note.id, notified]);
  await emit(project.id, 'note', { id: note.id });
}

/** Text the chosen cut to the host: into the iMessage thread it came from, or to the browser host's phone. */
async function finish(project: any, versionNo: number | null): Promise<{ ok: boolean; error?: string; how?: string; versionNo?: number }> {
  const v = versionNo
    ? await one(`SELECT * FROM sticky.versions WHERE project_id = $1 AND version_no = $2 AND delivery NOT IN ('pending','superseded','failed')`, [project.id, versionNo])
    : await latestShown(project.id);
  if (!v) return { ok: false, error: 'no such version' };
  const phone: string | null = project.host_phone;
  if (isWeb(project.chat_id) && !phone) return { ok: false, error: 'need_phone' };
  const text = `Final cut from your live edit (v${v.version_no}).`;
  const post = (parts: Part[]) => (isWeb(project.chat_id) ? textPhone(phone!, parts) : sendToChat(project.chat_id, parts).then(() => {}));
  let how = 'attachment';
  try {
    const file = await ensureLocal(v.out_key);
    const size = fs.statSync(file).size;
    const attachmentId = await uploadAttachment({ filename: `sticky-v${v.version_no}.mp4`, contentType: 'video/mp4', sizeBytes: size, body: fs.createReadStream(file) });
    await post([{ type: 'text', value: text }, { type: 'media', attachment_id: attachmentId }]);
  } catch (err) {
    log('live', { finish: 'attachment failed', error: errMsg(err).slice(0, 200) }, 'warn');
    if (!config.publicBaseUrl) return { ok: false, error: errMsg(err) };
    try {
      await post([{ type: 'text', value: `${text}\n${config.publicBaseUrl}/v/${v.link_token}.mp4` }]);
      how = 'link';
    } catch (err2) {
      return { ok: false, error: errMsg(err2) };
    }
  }
  await q(`UPDATE sticky.versions SET kept = true, final_sent_at = now() WHERE id = $1`, [v.id]);
  await q(`UPDATE sticky.projects SET kept_version = $2 WHERE id = $1`, [project.id, v.version_no]);
  log('live', { project: project.id, finished: v.version_no, to: isWeb(project.chat_id) ? last4(phone) : 'imessage thread', how });
  await reply(project.id, `Texted v${v.version_no} to the host${phone ? ` (…${phone.slice(-4)})` : ''}.`);
  return { ok: true, how, versionNo: v.version_no };
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** A sticky.live_presence row as the page knows a peer. */
const peerOf = (p: any) => ({ peer: p.peer_id, handle: p.handle, name: p.name, role: p.role, color: p.color });

async function liveState(project: any, role: 'host' | 'guest'): Promise<unknown> {
  const [versions, jobs, notes, network, present, sources] = await Promise.all([
    q(`SELECT * FROM sticky.versions WHERE project_id = $1 AND delivery NOT IN ('pending','superseded','failed') ORDER BY version_no`, [project.id]),
    q(`SELECT id, kind, status, stage, direction, channel, author_handle, author_name, anchor, error, version_no, created_at, finished_at
       FROM sticky.jobs WHERE project_id = $1 ORDER BY created_at DESC LIMIT 40`, [project.id]),
    q(`SELECT * FROM sticky.notes WHERE project_id = $1 ORDER BY id`, [project.id]),
    networkOf(project.chat_id),
    q(`SELECT peer_id, handle, name, role, color FROM sticky.live_presence WHERE project_id = $1 AND last_seen > now() - interval '30 seconds' ORDER BY joined_at`, [project.id]),
    q(`SELECT name, generated FROM sticky.sources WHERE project_id = $1 ORDER BY clip_id`, [project.id]),
  ]);
  const title = (sources.find((s: any) => !s.generated)?.name ?? 'Your reel').replace(/\.[^.]+$/, '');
  return {
    project: { id: project.id, title, state: project.state, origin: isWeb(project.chat_id) ? 'web' : 'imessage', createdAt: project.created_at, keptVersion: project.kept_version },
    role,
    host: { phoneOnFile: Boolean(project.host_phone), phoneLast4: role === 'host' && project.host_phone ? String(project.host_phone).slice(-4) : null },
    guestLink: `/live/${project.live_token}`,
    iceServers: iceServers(),
    versions: versions.map((v: any) => ({
      versionNo: v.version_no,
      url: `/v/${v.link_token}.mp4`,
      durationMs: v.duration_ms,
      createdAt: v.created_at,
      explanation: v.explanation,
      direction: v.anchor?.said ?? v.direction,
      channel: v.channel,
      author: v.author_name ? { handle: v.author_handle, name: v.author_name } : null,
      anchor: v.anchor ? { atMs: v.anchor.atMs, x: v.anchor.x, y: v.anchor.y, where: v.anchor.where, versionNo: v.anchor.versionNo } : null,
      parent: v.parent_version_no,
      kept: v.kept,
      finalSentAt: v.final_sent_at,
      shots: (v.segments as Segment[]).map((s) => ({ id: s.id, ms: s.outMs - s.inMs })),
    })),
    jobs: jobs.map((j: any) => ({
      id: j.id, kind: j.kind, status: j.status, stage: j.stage, channel: j.channel,
      said: j.anchor?.said ?? j.direction, author: j.author_name, anchor: j.anchor ?? null,
      error: j.error, versionNo: j.version_no, createdAt: j.created_at, finishedAt: j.finished_at,
    })),
    notes: notes.map((n: any) => ({
      id: n.id, versionNo: n.version_no, author: { handle: n.author_handle, name: n.author_name }, body: n.body,
      mentions: n.mentions, atMs: n.at_ms, x: n.x, y: n.y, notified: n.notified, createdAt: n.created_at,
    })),
    network: network.map((p) => ({ handle: p.handle, name: p.name, hasPhone: Boolean(p.phone), via: p.added_via })),
    present: present.map(peerOf),
  };
}

// ---------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------

// host_phone: where a browser host's final cut goes. An iMessage reel goes back into its own thread instead.
const projectByToken = (token: string) => one(
  `SELECT p.*, t.notify_phone AS host_phone FROM sticky.projects p JOIN sticky.threads t ON t.chat_id = p.chat_id WHERE p.live_token = $1`,
  [token],
);

async function personById(id: unknown): Promise<Person | null> {
  return ID.test(String(id)) ? one<Person>('SELECT id, handle, name, phone FROM sticky.people WHERE id = $1', [String(id)]) : null;
}

async function stream(req: http.IncomingMessage, res: http.ServerResponse, url: URL, project: any, role: 'host' | 'guest'): Promise<void> {
  const peer = String(url.searchParams.get('peer') ?? '');
  const person = await personById(req.headers['x-sticky-person']);
  if (!ID.test(peer) || !person) return send(res, 400, { ok: false, error: 'join first' });
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 2000\n\n');
  const sub: Sub = { peerId: peer, res };
  if (!subs.has(project.id)) subs.set(project.id, new Set());
  subs.get(project.id)!.add(sub);
  ensureListener();

  const color = colorOf(peer);
  const row = await one(
    `INSERT INTO sticky.live_presence (peer_id, project_id, handle, name, role, color) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (peer_id) DO UPDATE SET last_seen = now(), name = EXCLUDED.name RETURNING (xmax = 0) AS inserted`,
    [peer, project.id, person.handle, person.name, role, color],
  );
  const others = await q(
    `SELECT peer_id, handle, name, role, color FROM sticky.live_presence WHERE project_id = $1 AND peer_id <> $2 AND last_seen > now() - interval '30 seconds'`,
    [project.id, peer],
  );
  const you = { peer, handle: person.handle, name: person.name, role, color };
  res.write(`data: ${JSON.stringify({ type: 'hello', payload: { you, others: others.map(peerOf) } })}\n\n`);
  if (row?.inserted) await emit(project.id, 'join', you, { from: peer });

  // A reconnect (Cloud Run ends long requests) replays what this tab missed.
  const lastId = Number(req.headers['last-event-id'] ?? 0);
  if (lastId > 0) {
    const missed = await q(
      `SELECT * FROM sticky.live_events WHERE project_id = $1 AND id > $2 AND (to_peer IS NULL OR to_peer = $3)
         AND (from_peer IS NULL OR from_peer <> $3) AND created_at > now() - interval '10 minutes' ORDER BY id LIMIT 500`,
      [project.id, lastId, peer],
    );
    for (const m of missed) write(sub, m);
  }

  const beat = setInterval(() => {
    res.write(': ping\n\n');
    void q(`UPDATE sticky.live_presence SET last_seen = now() WHERE peer_id = $1`, [peer]).catch(() => {});
  }, 10_000);
  req.on('close', () => {
    clearInterval(beat);
    const set = subs.get(project.id);
    set?.delete(sub);
    if (set && !set.size) subs.delete(project.id);
    // Age the row so the sweeper drops a closed tab within ~15s; a reconnect refreshes it first.
    void q(`UPDATE sticky.live_presence SET last_seen = now() - interval '25 seconds' WHERE peer_id = $1`, [peer]).catch(() => {});
  });
}

/** Returns true when the request was a live-session route. */
export async function handleLive(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  const p = url.pathname;

  if (/^\/live\/[a-f0-9]{32}$/.test(p) && (req.method === 'GET' || req.method === 'HEAD')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(PAGE).pipe(res);
    return true;
  }

  // A browser thread opens one of its own reels live; the thread id is the credential, as in web.ts.
  if (p === '/live-api/open' && req.method === 'POST') {
    const body = await readJson(req, 4 * 1024);
    const thread = String(body.thread ?? '');
    if (!ID.test(thread) || !/^[0-9a-f-]{36}$/.test(String(body.projectId ?? ''))) { send(res, 400, { ok: false }); return true; }
    const owned = await one(`SELECT id FROM sticky.projects WHERE id = $1 AND chat_id = $2`, [body.projectId, `web:${thread}`]);
    if (!owned) { send(res, 404, { ok: false }); return true; }
    const r = await ensureLive(owned.id);
    send(res, 200, { ok: true, url: `/live/${r!.live_token}#host=${r!.host_key}` });
    return true;
  }

  const m = /^\/live-api\/([a-f0-9]{32})\/(state|stream|join|leave|signal|say|note|contact|invite|phone|finish)$/.exec(p);
  if (!m) return false;
  const [, token, action] = m;
  const project = await projectByToken(token);
  if (!project) { send(res, 404, { ok: false, error: 'This live link is not valid.' }); return true; }
  // Secrets travel in headers only (never the query string, which lands in request logs and history).
  const key = String(req.headers['x-sticky-host'] ?? '');
  const host = Boolean(key && project.host_key && safeEqual(key, project.host_key));
  const role = host ? 'host' : 'guest';

  if (action === 'state' && req.method === 'GET') { send(res, 200, await liveState(project, role)); return true; }
  if (action === 'stream' && req.method === 'GET') { await stream(req, res, url, project, role); return true; }
  if (req.method !== 'POST') { send(res, 405, { ok: false }); return true; }
  const body = await readJson(req);

  switch (action) {
    case 'join': {
      const id = String(body.person ?? '');
      const name = cleanName(body.name);
      const phone = normalizePhone(body.phone);
      if (!ID.test(id) || !name) { send(res, 400, { ok: false, error: 'name required' }); return true; }
      if (body.phone && !phone) { send(res, 400, { ok: false, error: 'That phone number doesn’t look right.' }); return true; }
      const person = await one<{ handle: string }>(
        `INSERT INTO sticky.people (id, handle, name, phone) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, phone = COALESCE(EXCLUDED.phone, sticky.people.phone), updated_at = now()
         RETURNING handle`,
        [id, hex(6), name, phone],
      );
      await q(`INSERT INTO sticky.network (owner_chat_id, person_id, added_via) VALUES ($1,$2,'session') ON CONFLICT DO NOTHING`, [project.chat_id, id]);
      if (host && phone && isWeb(project.chat_id)) await q(`UPDATE sticky.threads SET notify_phone = $2 WHERE chat_id = $1`, [project.chat_id, phone]);
      send(res, 200, { ok: true, handle: person!.handle, role });
      return true;
    }
    case 'leave': {
      const peer = String(body.peer ?? '');
      const gone = await q(`DELETE FROM sticky.live_presence WHERE peer_id = $1 AND project_id = $2 RETURNING peer_id`, [peer, project.id]);
      if (gone.length) await emit(project.id, 'leave', { peer }, { from: peer });
      send(res, 200, { ok: true });
      return true;
    }
    case 'signal': {
      if (!ID.test(String(body.from)) || !ID.test(String(body.to))) { send(res, 400, { ok: false }); return true; }
      await emit(project.id, 'signal', body.data ?? {}, { from: body.from, to: body.to });
      send(res, 200, { ok: true });
      return true;
    }
    case 'say': {
      const person = await personById(body.person);
      const text = String(body.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
      if (!person || !text) { send(res, 400, { ok: false }); return true; }
      const anchor = anchorOf(body.anchor);
      const peer = ID.test(String(body.peer)) ? String(body.peer) : null;
      await emit(project.id, 'heard', { reqId: String(body.reqId ?? '').slice(0, 40), handle: person.handle, name: person.name, text, anchor }, { from: peer });
      send(res, 202, { ok: true });
      void handleSay(project, person, peer ?? '', text, anchor).catch((err) => {
        log('live', { project: project.id, say: 'failed', error: errMsg(err) }, 'error');
        void reply(project.id, `I couldn't take that one (${errMsg(err).slice(0, 120)}).`);
      });
      return true;
    }
    case 'note': {
      const person = await personById(body.person);
      const text = String(body.body ?? '').trim().slice(0, 1000);
      if (!person || !text) { send(res, 400, { ok: false }); return true; }
      const explicit = (Array.isArray(body.mentions) ? body.mentions : []).map(String).filter((h: string) => HANDLE.test(h));
      send(res, 202, { ok: true });
      void createNote(project, person, text, anchorOf(body.anchor), explicit).catch((err) => log('live', { note: 'failed', error: errMsg(err) }, 'error'));
      return true;
    }
    case 'contact': {
      if (!host) { send(res, 403, { ok: false, error: 'Only the host can add people.' }); return true; }
      const name = cleanName(body.name);
      const phone = normalizePhone(body.phone);
      if (!name || !phone) { send(res, 400, { ok: false, error: 'A name and a valid phone number, please.' }); return true; }
      const existing = (await networkOf(project.chat_id)).find((n) => n.phone === phone);
      if (existing) await q(`UPDATE sticky.people SET name = $2, updated_at = now() WHERE id = $1`, [existing.id, name]);
      else {
        const id = hex(16);
        await q(`INSERT INTO sticky.people (id, handle, name, phone) VALUES ($1,$2,$3,$4)`, [id, hex(6), name, phone]);
        await q(`INSERT INTO sticky.network (owner_chat_id, person_id, added_via) VALUES ($1,$2,'contact') ON CONFLICT DO NOTHING`, [project.chat_id, id]);
      }
      await emit(project.id, 'network', {});
      send(res, 200, { ok: true });
      return true;
    }
    case 'invite': {
      if (!host) { send(res, 403, { ok: false, error: 'Only the host can text invites.' }); return true; }
      const target = (await networkOf(project.chat_id)).find((n) => n.handle === String(body.handle));
      if (!target?.phone) { send(res, 400, { ok: false, error: 'No phone number for them.' }); return true; }
      const link = guestLink(project.live_token);
      if (!link) { send(res, 400, { ok: false, error: 'STICKY_PUBLIC_BASE_URL is not set, so there is no link to text.' }); return true; }
      try {
        await textPhone(target.phone, [{ type: 'text', value: `You're invited to edit a Sticky reel live: ${link}` }]);
        send(res, 200, { ok: true });
      } catch (err) {
        send(res, 502, { ok: false, error: `Couldn't text them: ${errMsg(err).slice(0, 160)}` });
      }
      return true;
    }
    case 'phone': {
      if (!host) { send(res, 403, { ok: false }); return true; }
      const phone = normalizePhone(body.phone);
      if (!phone) { send(res, 400, { ok: false, error: 'That phone number doesn’t look right.' }); return true; }
      if (isWeb(project.chat_id)) await q(`UPDATE sticky.threads SET notify_phone = $2 WHERE chat_id = $1`, [project.chat_id, phone]);
      send(res, 200, { ok: true });
      return true;
    }
    case 'finish': {
      if (!host) { send(res, 403, { ok: false, error: 'Only the host can finish.' }); return true; }
      const n = Number(body.versionNo);
      const r = await finish(project, Number.isInteger(n) && n > 0 ? n : null);
      let status = 502;
      if (r.ok) status = 200;
      else if (r.error === 'need_phone') status = 409;
      send(res, status, r);
      return true;
    }
  }
  send(res, 404, { ok: false });
  return true;
}
