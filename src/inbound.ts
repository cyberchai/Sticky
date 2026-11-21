/**
 * Inbound events: Sticky's own Linq subscription, or the browser (web threads post the same
 * Linq-shaped payload). The ack path only persists: the event row (PK = provider webhook id, so
 * replays do nothing) and, for videos, the project/source rows, all in one transaction. Work happens
 * after, driven by the tickers in jobs.ts.
 */
import type pg from 'pg';
import { say } from './channel.js';
import { COPY, LIMITS, config } from './config.js';
import { one, q, tx } from './db.js';
import { whyThisCut } from './explain.js';
import { routeText } from './gemini.js';
import { errMsg, last4, log } from './log.js';
import { applyVote, choicesStillNeeded, joinNotes, standingChoices } from './polls.js';
import { transcribeVoice } from './voice.js';
import { CONTACT_LIMIT, addContacts, joinUrl, phonesIn } from './contacts.js';
import { linqCall, openChat } from './linq.js';

export interface VideoPart { partId: string; url: string; mime: string; sizeBytes: number | null; name: string | null }

type ReceiptStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface ParsedLinq {
  eventType: string;
  chatId: string | null;
  line: string | null;
  from: string | null;
  isGroup: boolean;
  fromMe: boolean;
  messageId: string | null;
  text: string;
  videos: VideoPart[];
  /** A voice memo (or any audio): transcribed and used exactly like a typed edit. */
  audio: { partId: string; url: string; mime: string } | null;
  /** Other people in the chat (groups), when the payload lists them. */
  roster: string[];
  otherMedia: number;
  receipt: { status: ReceiptStatus; providerMessageId: string | null } | null;
  /** poll.vote.added / poll.vote.removed: which option of the poll (messageId) was toggled. */
  poll: { optionId: string; action: 'added' | 'removed' } | null;
}

const RECEIPTS: Record<string, ReceiptStatus> = {
  'message.sent': 'sent', 'message.delivered': 'delivered', 'message.read': 'read', 'message.failed': 'failed',
};

/** Both Linq payload versions (see core-api messageDeliveryEvents.ts / reels.ts `videoPartsOf`). */
export function parseLinq(payload: any): ParsedLinq {
  const eventType = String(payload?.event_type ?? '');
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
  const inner = data.message && typeof data.message === 'object' ? data.message : {};
  const parts: any[] = Array.isArray(data.parts) ? data.parts : Array.isArray(inner.parts) ? inner.parts : [];
  const videos: VideoPart[] = [];
  let audio: ParsedLinq['audio'] = null;
  let otherMedia = 0;
  parts.forEach((p, i) => {
    if (p?.type !== 'media') return;
    const mime = typeof p.mime_type === 'string' ? p.mime_type.trim().toLowerCase() : '';
    const url = typeof p.url === 'string' ? p.url.trim() : '';
    if (mime.startsWith('audio/') && url && !audio) {
      audio = { partId: typeof p.id === 'string' && p.id ? p.id : `part-${i}`, url, mime };
    } else if (mime.startsWith('video/') && url) {
      const size = Number(p.size_bytes);
      videos.push({
        partId: typeof p.id === 'string' && p.id ? p.id : `part-${i}`,
        url,
        mime,
        sizeBytes: Number.isFinite(size) ? size : null,
        name: typeof p.filename === 'string' ? p.filename.slice(0, 120) : null,
      });
    } else {
      otherMedia++;
    }
  });
  // Own keys only: an inherited name ("constructor") is never a receipt status.
  const status = Object.hasOwn(RECEIPTS, eventType) ? RECEIPTS[eventType] : undefined;
  const vote = /^poll\.vote\.(added|removed)$/.exec(eventType);
  return {
    eventType,
    chatId: data.chat?.id ?? data.chat_id ?? inner.chat_id ?? null,
    line: data.chat?.owner_handle?.handle ?? null,
    from: data.sender_handle?.handle ?? data.from_handle?.handle ?? (typeof data.from === 'string' ? data.from : null),
    isGroup: Boolean(data.chat?.is_group ?? data.is_group ?? false),
    fromMe: data.direction === 'outbound' || data.is_from_me === true || data.sender_handle?.is_me === true,
    messageId: data.id ?? inner.id ?? data.message_id ?? null,
    text: parts.filter((p) => p?.type === 'text' && typeof p.value === 'string').map((p) => p.value).join(' ').trim(),
    videos,
    audio,
    roster: rosterOf(data),
    otherMedia,
    receipt: status ? { status, providerMessageId: data.message_id ?? inner.id ?? data.id ?? null } : null,
    poll: vote && data.option_id ? { optionId: String(data.option_id), action: vote[1] as 'added' | 'removed' } : null,
  };
}

function rosterOf(data: any): string[] {
  const handles: any[] = Array.isArray(data.chat_handles) ? data.chat_handles : Array.isArray(data.chat?.handles) ? data.chat.handles : [];
  return handles.filter((h) => !h?.is_me && typeof h?.handle === 'string' && h.handle.startsWith('+')).map((h) => h.handle);
}

/** Groups are welcome: anyone in the room can send footage or an edit. */
function kindOf(p: ParsedLinq): 'video' | 'text' | 'receipt' | 'vote' | 'other' {
  // Our own line's votes can echo back as poll events; only other people's votes count.
  if (p.poll) return p.fromMe || !p.chatId || !p.messageId ? 'other' : 'vote';
  if (p.receipt) return 'receipt';
  if (p.eventType !== 'message.received' || p.fromMe || !p.chatId) return 'other';
  if (p.videos.length) return 'video';
  if (p.text || p.audio || p.otherMedia) return 'text';
  return 'other';
}

type After = () => Promise<void>;

/** Persist, then return the follow-up work to run after the ack. 'duplicate' = already seen. */
export async function acceptEvent(raw: string, providerEventId: string): Promise<{ result: 'stored' | 'duplicate' | 'ignored'; after: After[] }> {
  let payload: any;
  try { payload = JSON.parse(raw); } catch { return { result: 'ignored', after: [] }; }
  const p = parseLinq(payload);
  const kind = kindOf(p);
  const eventId = providerEventId || p.messageId || '';
  if (!eventId) return { result: 'ignored', after: [] };

  const after: After[] = [];
  const result = await tx(async (c) => {
    const ins = await c.query(
      `INSERT INTO sticky.events (provider_event_id, chat_id, kind, payload) VALUES ($1,$2,$3,$4)
       ON CONFLICT (provider_event_id) DO NOTHING RETURNING provider_event_id`,
      [eventId, p.chatId, kind, payload],
    );
    if (!ins.rowCount) return 'duplicate' as const;
    if (kind === 'video') {
      const hooks = await attachVideos(c, p);
      if (p.isGroup) {
        // The hello goes out before "Got …'s clip".
        after.push(async () => {
          await greetGroup(p.chatId!);
          for (const fn of hooks) await fn();
        });
      } else {
        after.push(...hooks);
      }
    }
    if (kind === 'text') after.push(() => processText(eventId));
    if ((kind === 'video' || kind === 'text') && p.isGroup) after.push(() => syncGroupRoster(p));
    if (kind === 'receipt' && p.receipt?.providerMessageId) {
      const { status, providerMessageId } = p.receipt;
      after.push(async () => {
        await handleReceipt(status, providerMessageId!);
        await q('UPDATE sticky.events SET handled_at = now() WHERE provider_event_id = $1', [eventId]);
      });
    }
    if (kind === 'vote') {
      after.push(async () => {
        await handleVote(p);
        await q('UPDATE sticky.events SET handled_at = now() WHERE provider_event_id = $1', [eventId]);
      });
    }
    if (kind === 'other') await c.query('UPDATE sticky.events SET handled_at = now() WHERE provider_event_id = $1', [eventId]);
    return 'stored' as const;
  });
  log('event', { id: eventId, kind, result, chat: p.chatId, from: last4(p.from), videos: p.videos.length || undefined, text: p.text ? p.text.slice(0, 60) : undefined });
  return { result, after: result === 'stored' ? after : [] };
}

async function upsertThread(c: pg.PoolClient, p: ParsedLinq): Promise<any> {
  await c.query(
    `INSERT INTO sticky.threads (chat_id, line, phone, is_group) VALUES ($1,$2,$3,$4)
     ON CONFLICT (chat_id) DO UPDATE SET line = COALESCE(EXCLUDED.line, sticky.threads.line),
       phone = CASE WHEN EXCLUDED.is_group THEN sticky.threads.phone ELSE COALESCE(EXCLUDED.phone, sticky.threads.phone) END,
       is_group = sticky.threads.is_group OR EXCLUDED.is_group, updated_at = now()`,
    [p.chatId, p.line, p.from, p.isGroup],
  );
  return (await c.query('SELECT * FROM sticky.threads WHERE chat_id = $1 FOR UPDATE', [p.chatId])).rows[0];
}

/**
 * One-on-one: the first video opens a project; more videos inside the quiet window join it (the window
 * resets); a clip during a render is kept for a follow-up cut; a video after a delivered cut starts fresh.
 * Group chat: the reel is everyone's footage. Clips (including ones after a cut) join the group's reel
 * and are held (collect_deadline NULL) until someone says "go ahead"; then one cut combines them all.
 */
async function attachVideos(c: pg.PoolClient, p: ParsedLinq): Promise<After[]> {
  const thread = await upsertThread(c, p);
  if (thread.opted_out) await c.query('UPDATE sticky.threads SET opted_out = false WHERE chat_id = $1', [p.chatId]);
  let project = thread.current_project_id
    ? (await c.query('SELECT * FROM sticky.projects WHERE id = $1 FOR UPDATE', [thread.current_project_id])).rows[0]
    : null;
  const group = Boolean(thread.is_group);
  const window = `${config.collectWindowMs} milliseconds`;
  let followup = false;
  if (group && project?.state === 'delivered') {
    await c.query(
      `UPDATE sticky.projects SET state = 'collecting', collect_deadline = NULL, last_inbound_at = now(),
         direction = CASE WHEN $2::text IS NULL THEN direction ELSE array_append(direction, $2::text) END WHERE id = $1`,
      [project.id, p.text || null],
    );
  } else if (!project || ['delivered', 'failed', 'closed'].includes(project.state)) {
    const direction = [...(thread.pending_direction ?? []), ...(p.text ? [p.text] : [])];
    project = (await c.query(
      `INSERT INTO sticky.projects (chat_id, state, collect_deadline, direction)
       VALUES ($1, 'collecting', CASE WHEN $4 THEN NULL ELSE now() + $2::interval END, $3) RETURNING *`,
      [p.chatId, window, direction, group],
    )).rows[0];
    await c.query(`UPDATE sticky.threads SET current_project_id = $2, pending_direction = '{}' WHERE chat_id = $1`, [p.chatId, project.id]);
  } else if (project.state === 'collecting') {
    // A group's hold (or its "go ahead" already given) is left alone; one-on-one, the window resets.
    await c.query(
      `UPDATE sticky.projects SET collect_deadline = CASE WHEN $4 THEN collect_deadline ELSE now() + $2::interval END, last_inbound_at = now(),
         direction = CASE WHEN $3::text IS NULL THEN direction ELSE array_append(direction, $3::text) END WHERE id = $1`,
      [project.id, window, p.text || null, group],
    );
  } else {
    followup = true;
    await c.query(
      `UPDATE sticky.projects SET last_inbound_at = now(),
         direction = CASE WHEN $2::text IS NULL THEN direction ELSE array_append(direction, $2::text) END WHERE id = $1`,
      [project.id, p.text || null],
    );
  }
  const { rows: [{ n }] } = await c.query<{ n: number }>('SELECT count(*)::int AS n FROM sticky.sources WHERE project_id = $1', [project.id]);
  const maxClips = group ? LIMITS.groupMaxClips : LIMITS.maxClips;
  let count = n;
  let added = 0;
  let skipped = 0;
  for (const v of p.videos) {
    if (count >= maxClips) { skipped++; continue; }
    const res = await c.query(
      `INSERT INTO sticky.sources (project_id, clip_id, provider_message_id, part_id, url, mime, followup, name, author_handle)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
      [project.id, `c${count + 1}`, p.messageId ?? 'unknown', v.partId, v.url, v.mime, followup, v.name, p.from],
    );
    if (res.rowCount) { count++; added++; }
  }
  const after: After[] = [async () => { const { kickIntake } = await import('./jobs.js'); kickIntake(); }];
  if (skipped) after.push(() => say(p.chatId!, group ? COPY.groupTooMany : COPY.tooMany).then(() => {}));
  if (group && added) {
    const tally = (await c.query(
      `SELECT count(*)::int AS clips, count(DISTINCT author_handle)::int AS people FROM sticky.sources WHERE project_id = $1 AND NOT generated`,
      [project.id],
    )).rows[0];
    after.push(() => reply(p.chatId!, COPY.groupClipIn(p.from ? last4(p.from) : 'that', tally.clips, Math.max(1, tally.people))).then(() => {}));
  }
  return after;
}

// ---------------------------------------------------------------------------------------------
// Text: direction, revisions, Why this cut?, KEEP, NEW REEL, STOP. Serialized per thread.
// ---------------------------------------------------------------------------------------------

const chains = new Map<string, Promise<void>>();
function serial(chatId: string, fn: () => Promise<void>): Promise<void> {
  const next = (chains.get(chatId) ?? Promise.resolve()).then(fn, fn).catch((err) => log('text', { chat: chatId, error: errMsg(err) }, 'error'));
  chains.set(chatId, next);
  void next.finally(() => { if (chains.get(chatId) === next) chains.delete(chatId); });
  return next;
}

export async function processText(eventId: string): Promise<void> {
  const ev = await one('SELECT * FROM sticky.events WHERE provider_event_id = $1', [eventId]);
  if (!ev?.chat_id) return;
  await serial(ev.chat_id, async () => {
    const claimed = await one('UPDATE sticky.events SET handled_at = now() WHERE provider_event_id = $1 AND handled_at IS NULL RETURNING received_at', [eventId]);
    if (!claimed) return;
    const p = parseLinq(ev.payload);
    await handleText(p, claimed.received_at);
  });
}

const reply = (chatId: string, text: string) => say(chatId, text).catch((err) => log('reply', { chat: chatId, failed: errMsg(err) }, 'warn'));

async function latestVersion(projectId: string): Promise<any | null> {
  return one(
    `SELECT * FROM sticky.versions WHERE project_id = $1 AND delivery IN ('sending','accepted','delivered','link_degraded')
     ORDER BY version_no DESC LIMIT 1`,
    [projectId],
  );
}

/** The first time Sticky hears from a group, it says hello once (the contact card follows that first send). */
async function greetGroup(chatId: string): Promise<void> {
  const first = await one(`UPDATE sticky.threads SET greeted_at = now() WHERE chat_id = $1 AND greeted_at IS NULL RETURNING chat_id`, [chatId]);
  if (first) await reply(chatId, COPY.groupHello);
}

async function handleText(input: ParsedLinq, receivedAt: Date): Promise<void> {
  let p = input;
  const chatId = p.chatId!;
  const group = p.isGroup;
  const thread = await tx((c) => upsertThread(c, p));
  if (group) await greetGroup(chatId);
  const project = thread.current_project_id ? await one('SELECT * FROM sticky.projects WHERE id = $1', [thread.current_project_id]) : null;

  // A voice memo's words are the message, exactly as if they had been typed.
  let voice = false;
  if (!p.text && p.audio) {
    const heard = await transcribeVoice(p.audio.url).catch((err) => { log('voice', { chat: chatId, failed: errMsg(err) }, 'warn'); return ''; });
    if (!heard) { if (!group) await reply(chatId, COPY.voiceFailed); return; }
    p = { ...p, text: heard };
    voice = true;
    log('voice', { chat: chatId, from: last4(p.from), heard: heard.slice(0, 120) });
  }

  const text = p.text;
  const command = text.trim().toUpperCase().replace(/[.!\s]+$/g, '');

  if (!text) { if (p.otherMedia && !group) await reply(chatId, COPY.notVideo); return; }
  // "add 347-555-0100, 917…" (typed or spoken) puts people on the free line's list.
  if (/^\s*(sticky[,:]?\s*)?(please\s+)?add\b/i.test(text) && phonesIn(text).length) return addPeople(chatId, phonesIn(text));
  if (group) return handleGroupText(p, project, receivedAt, voice);

  if (thread.opted_out) {
    const intent = command === 'START' ? 'start' : await routeText({ text, state: 'opted out', hasCut: false });
    if (intent === 'start') {
      await q('UPDATE sticky.threads SET opted_out = false WHERE chat_id = $1', [chatId]);
      await reply(chatId, COPY.optedIn);
    }
    return;
  }

  if (command === 'KEEP') return keep(chatId, project);
  if (command === 'NEW REEL') return newReel(chatId, project);
  if (command === 'STOP' || command === 'UNSUBSCRIBE') return optOut(chatId);

  // A caption or nearby text while the clips are still arriving is direction for v1.
  if (project?.state === 'collecting') {
    await q('UPDATE sticky.projects SET direction = array_append(direction, $2) WHERE id = $1', [project.id, text]);
    return;
  }

  const hasCut = project ? Boolean(await latestVersion(project.id)) : false;
  const intent = await routeText({ text, state: project ? project.state : 'no project yet', hasCut });
  log('text', { chat: chatId, intent, project: project?.id, text: text.slice(0, 80) });

  switch (intent) {
    case 'stop': return optOut(chatId);
    case 'start': return void (await reply(chatId, COPY.optedIn));
    case 'keep': return keep(chatId, project);
    case 'new_reel': return newReel(chatId, project);
    case 'why': return why(chatId, project);
    case 'other':
      if (!project || project.state === 'closed') await holdBrief(chatId, text);
      else await reply(chatId, COPY.help);
      return;
    case 'revise':
    default:
      if (!project || project.state === 'closed') return holdBrief(chatId, text);
      if (voice) await reply(chatId, COPY.heard(text));
      return queueEdit(project, text, receivedAt, hasCut, p.from);
  }
}

/**
 * A poll vote is its voter asking for that option's change, exactly as if they'd texted it (no routing:
 * a vote is always aimed at Sticky, in a group too). Serialized per chat, so a group's votes queue in order.
 */
async function handleVote(p: ParsedLinq): Promise<void> {
  await serial(p.chatId!, async () => {
    const r = await applyVote({ messageId: p.messageId!, optionId: p.poll!.optionId, voter: p.from, action: p.poll!.action });
    if (!r) return;
    let project = await one('SELECT * FROM sticky.projects WHERE id = $1', [r.projectId]);
    const thread = await one('SELECT is_group, current_project_id FROM sticky.threads WHERE chat_id = $1', [p.chatId]);
    if (thread?.is_group) {
      // Group: a pick on any poll in the chat is held on the current reel with everyone's other picks and
      // changes until "go ahead". Only the first held item gets a reply.
      if (thread.current_project_id && thread.current_project_id !== r.projectId) {
        project = await one('SELECT * FROM sticky.projects WHERE id = $1', [thread.current_project_id]);
      }
      if (!project || project.state === 'closed') return;
      const held = await one(
        `UPDATE sticky.projects SET held_notes = CASE WHEN $2 = ANY(held_notes) THEN held_notes ELSE array_append(held_notes, $2) END
         WHERE id = $1 RETURNING cardinality(held_notes) AS n`,
        [project.id, r.instruction],
      );
      if (held?.n === 1) await reply(p.chatId!, COPY.groupPicksHeld);
      return;
    }
    if (!project || project.state === 'closed') return;
    await queueEdit(project, r.instruction, new Date(), Boolean(await latestVersion(project.id)), p.from === 'web' ? null : p.from);
  });
}

/**
 * Queue an edit on the project (folded into v1 if that hasn't started yet). Serialized per project by
 * jobs.ts. The author is recorded (migration 005's columns; a trigger copies it onto the version) so a
 * group can see whose request each version answers. Only the last 4 digits are ever shown.
 */
async function queueEdit(project: any, text: string, receivedAt: Date, hasCut: boolean, author: string | null = null): Promise<void> {
  // v1 not started yet: fold the note into it rather than cutting twice.
  const folded = await one(
    `UPDATE sticky.jobs SET direction = concat_ws(E'\\n', direction, $2::text), inbound_at = $3
     WHERE project_id = $1 AND kind = 'v1' AND status = 'queued' RETURNING id`,
    [project.id, text, receivedAt],
  );
  if (folded) return;
  const kind = hasCut || project.state === 'rendering' || project.state === 'queued' ? 'revise' : 'v1';
  const web = String(project.chat_id ?? '').startsWith('web:');
  await q(
    `INSERT INTO sticky.jobs (project_id, kind, direction, inbound_at, channel, author_handle, author_name) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [project.id, kind, kind === 'v1' ? [...(project.direction ?? []), text].join('\n') : text, receivedAt,
      web ? 'web' : 'sms', web ? null : author, web || !author ? null : last4(author)],
  );
  if (project.state === 'failed') await q(`UPDATE sticky.projects SET state = 'queued' WHERE id = $1`, [project.id]);
}

/**
 * A group is a conversation between people; Sticky only acts on what is meant for it (an edit to the
 * reel, "why this cut?", keep, new reel, or anything that names Sticky) and stays silent otherwise.
 * Anyone in the room can edit; edits queue per project and each builds on the latest cut.
 */
async function addPeople(chatId: string, phones: string[]): Promise<void> {
  const r = await addContacts(phones);
  await reply(chatId, COPY.addedPeople({ added: r.added.map(last4), already: r.already.map(last4), full: r.full.map(last4), used: r.used, limit: CONTACT_LIMIT, link: joinUrl() }));
}

/**
 * Someone on the list texted in a group: put everyone else in that group on the list too, then tell the
 * sender one-on-one (the group itself can't hear from Sticky until each member has texted it once).
 */
const rosterSynced = new Map<string, number>();
async function syncGroupRoster(p: ParsedLinq): Promise<void> {
  const chatId = p.chatId!;
  if (Date.now() - (rosterSynced.get(chatId) ?? 0) < 60_000) return;
  rosterSynced.set(chatId, Date.now());
  let roster = p.roster;
  if (!roster.length) {
    const chat = await linqCall('GET', `/chats/${encodeURIComponent(chatId)}`);
    const handles: any[] = chat.body?.handles ?? chat.body?.chat?.handles ?? [];
    roster = handles.filter((h) => !h?.is_me && typeof h?.handle === 'string' && h.handle.startsWith('+')).map((h) => h.handle);
  }
  const others = roster.filter((h) => h !== config.line);
  if (!others.length) return;
  const r = await addContacts(others);
  if (!r.added.length && !r.full.length) return;
  log('roster', { chat: chatId, from: last4(p.from), added: r.added.length, full: r.full.length, used: r.used });
  if (!p.from) return;
  await openChat(config.line, p.from, [{ type: 'text', value: COPY.groupRosterAdded({ added: r.added.length, full: r.full.length, link: joinUrl(), limit: CONTACT_LIMIT }) }])
    .catch((err) => log('roster', { chat: chatId, dm: 'failed', error: errMsg(err) }, 'warn'));
}

async function handleGroupText(p: ParsedLinq, project: any, receivedAt: Date, voice: boolean): Promise<void> {
  const chatId = p.chatId!;
  const text = p.text;
  const command = text.trim().toUpperCase().replace(/[.!\s]+$/g, '');
  if (command === 'KEEP') return keep(chatId, project);
  if (command === 'NEW REEL') return newReel(chatId, project);
  if (command === 'STOP' || command === 'UNSUBSCRIBE') return void (await reply(chatId, COPY.groupStop));

  const holding = project?.state === 'collecting' && project.collect_deadline === null;
  const waiting = holding || (project?.held_notes?.length ?? 0) > 0;
  if (waiting && isGoAhead(text)) return goAhead(chatId, project);
  const hasCut = project ? Boolean(await latestVersion(project.id)) : false;
  let state: string = project ? project.state : 'no project yet';
  if (holding) state = 'holding clips from the group, waiting for someone to say go ahead';
  else if (waiting) state = 'holding changes the group asked for, waiting for someone to say go ahead';
  const intent = await routeText({ text, state, hasCut, isGroup: true });
  log('text', { chat: chatId, group: true, from: last4(p.from), intent, voice: voice || undefined, project: project?.id, text: text.slice(0, 80) });

  switch (intent) {
    case 'keep': return keep(chatId, project);
    case 'new_reel': return newReel(chatId, project);
    case 'why': return why(chatId, project);
    case 'stop': return void (await reply(chatId, COPY.groupStop));
    case 'go':
      if (waiting) return goAhead(chatId, project);
      return;
    case 'revise':
      if (project?.state === 'collecting') {
        // Clips still arriving: this is direction for the combined cut.
        await q('UPDATE sticky.projects SET direction = array_append(direction, $2) WHERE id = $1', [project.id, text]);
        if (holding) await reply(chatId, COPY.groupHeld(text));
        return;
      }
      if (!project || project.state === 'closed') return holdBrief(chatId, text);
      // A group's changes wait for "go ahead" and go out together: one version for the room, not one each.
      await q('UPDATE sticky.projects SET held_notes = array_append(held_notes, $2) WHERE id = $1', [project.id, text]);
      return void (await reply(chatId, COPY.groupHeld(text)));
    default:
      return; // people talking to each other
  }
}

const GO_OBJ = "(?:it|them|those|these|both|em|'em|all|all of (?:them|those|these|it)|everything|our (?:clips|videos)|the (?:clips|videos))";
const GO_PHRASE = [
  'go', 'go ahead', 'go for it', 'do it', "let'?s go", "let'?s do it", "let'?s see it", 'ready', 'done', 'all in', 'send it',
  `cut ${GO_OBJ}`, `edit ${GO_OBJ}`, 'make (?:the|a|one|our) (?:reel|video|edit)', `make ${GO_OBJ} (?:one|into one)(?: reel| video)?`,
  `combine(?: ${GO_OBJ})?`, `merge(?: ${GO_OBJ})?`, `put ${GO_OBJ} together`, `use ${GO_OBJ}`,
  "we'?re (?:good|done|ready|all in)", "that'?s (?:all|it|everything)",
].join('|');
const GO_AHEAD = new RegExp(
  `^(?:(?:ok(?:ay)?|alright|yes|yep|yeah|cool|great|perfect|hey)\\b[\\s,.!]*)*(?:sticky\\b[\\s,:.!]*)?(?:please\\s+)?(?:${GO_PHRASE})(?:\\s+(?:now|please|pls|sticky|thanks|thx|guys|lol|then))*\\W*$`,
  'i',
);

/**
 * A message that is only a go-ahead ("go ahead", "Combine those.", "use both", "ok sticky do it", "we're
 * ready!"). Anything longer ("make it 8 seconds", "go ahead but open on the dog") goes to routeText, which
 * keeps it as direction or classifies it as a go-ahead.
 */
export function isGoAhead(text: string): boolean {
  return GO_AHEAD.test(text.trim());
}

/**
 * "go ahead" in a group. New clips held: release them; the combined cut (jobs.ts) applies every pick and
 * held change. No new clips: everything held since the last version goes out as ONE edit.
 */
async function goAhead(chatId: string, project: any): Promise<void> {
  const released = await one(
    `UPDATE sticky.projects SET collect_deadline = now() WHERE id = $1 AND state = 'collecting' AND collect_deadline IS NULL RETURNING id`,
    [project.id],
  );
  if (!released) return applyHeld(chatId, project);
  const tally = await one(
    `SELECT count(*)::int AS clips, count(DISTINCT author_handle)::int AS people FROM sticky.sources WHERE project_id = $1 AND NOT generated AND status <> 'failed'`,
    [project.id],
  );
  log('group', { chat: chatId, goAhead: project.id, clips: tally?.clips, people: tally?.people });
  await reply(chatId, COPY.groupGoAhead(tally?.clips ?? 1, Math.max(1, tally?.people ?? 1)));
}

async function applyHeld(chatId: string, project: any): Promise<void> {
  // A combined cut that hasn't started yet takes the held changes itself.
  if (project.state === 'collecting') return;
  const v1Queued = await one(`SELECT 1 FROM sticky.jobs WHERE project_id = $1 AND kind = 'v1' AND status = 'queued'`, [project.id]);
  if (v1Queued) return;
  const taken = await one(
    `WITH old AS (SELECT held_notes FROM sticky.projects WHERE id = $1 FOR UPDATE)
     UPDATE sticky.projects p SET held_notes = '{}' FROM old WHERE p.id = $1 AND cardinality(old.held_notes) > 0 RETURNING old.held_notes AS notes`,
    [project.id],
  );
  if (!taken) return;
  const latest = await latestVersion(project.id);
  if (!latest) return;
  // Picks the cut already has (captions on, music in...) aren't asked for twice.
  const picks = new Map((await standingChoices(chatId)).map((c) => [c.instruction, c]));
  const cut = { captions: latest.captions, music: project.music, overlays: latest.overlays ?? [], transitions: latest.transitions ?? [] };
  const notes = (taken.notes as string[]).filter((n) => {
    const pick = picks.get(n);
    return !pick || choicesStillNeeded([pick], cut).length > 0;
  });
  if (!notes.length) return void (await reply(chatId, COPY.groupNothingNew));
  log('group', { chat: chatId, goAhead: project.id, changes: notes.length });
  await reply(chatId, COPY.groupApplying(notes.length));
  await queueEdit(project, joinNotes(notes), new Date(), true, null);
}

/** A brief sent before any video waits on the thread for the next video. */
async function holdBrief(chatId: string, text: string): Promise<void> {
  await q('UPDATE sticky.threads SET pending_direction = array_append(pending_direction, $2) WHERE chat_id = $1', [chatId, text]);
  await reply(chatId, COPY.briefWaiting);
}

async function keep(chatId: string, project: any): Promise<void> {
  const v = project ? await latestVersion(project.id) : null;
  if (!v) return void (await reply(chatId, COPY.nothingYet));
  await q('UPDATE sticky.versions SET kept = true WHERE id = $1', [v.id]);
  await q('UPDATE sticky.projects SET kept_version = $2 WHERE id = $1', [project.id, v.version_no]);
  log('keep', { project: project.id, version: v.version_no });
  await reply(chatId, COPY.kept(v.version_no));
}

async function newReel(chatId: string, project: any): Promise<void> {
  if (project) await q(`UPDATE sticky.projects SET state = 'closed' WHERE id = $1 AND state <> 'closed'`, [project.id]);
  await q(`UPDATE sticky.threads SET current_project_id = NULL, pending_direction = '{}' WHERE chat_id = $1`, [chatId]);
  await reply(chatId, COPY.newReel);
}

async function optOut(chatId: string): Promise<void> {
  await q('UPDATE sticky.threads SET opted_out = true WHERE chat_id = $1', [chatId]);
  await reply(chatId, COPY.optedOut);
}

async function why(chatId: string, project: any): Promise<void> {
  const v = project ? await latestVersion(project.id) : null;
  if (!v) return void (await reply(chatId, project && project.state !== 'closed' ? 'Still cutting. Ask again once the reel arrives.' : COPY.nothingYet));
  await reply(chatId, whyThisCut({
    segments: v.segments,
    technique: v.technique,
    analysis: project.analysis,
    explanation: v.explanation,
    direction: v.direction,
    versionNo: v.version_no,
    music: v.music,
    overlays: v.overlays,
    transitions: v.transitions,
    captions: v.captions,
  }));
}

// ---------------------------------------------------------------------------------------------
// Receipts: accepted → delivered, or failed → tap-to-play link
// ---------------------------------------------------------------------------------------------

async function handleReceipt(status: ReceiptStatus, providerMessageId: string): Promise<void> {
  if (status === 'delivered' || status === 'read') {
    await q(
      `UPDATE sticky.versions SET delivery = 'delivered', delivered_at = COALESCE(delivered_at, now())
       WHERE provider_message_id = $1 AND delivery IN ('sending','accepted')`,
      [providerMessageId],
    );
  } else if (status === 'failed') {
    const v = await one(`SELECT id FROM sticky.versions WHERE provider_message_id = $1 AND delivery IN ('sending','accepted')`, [providerMessageId]);
    if (v) {
      const { sendLinkFallback } = await import('./deliver.js');
      await sendLinkFallback(v.id, 'provider reported failed');
    }
  }
}
