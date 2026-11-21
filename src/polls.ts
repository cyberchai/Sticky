/**
 * The "want any of these?" poll after a first cut: a few one-tap next steps picked for this cut (auto
 * captions when someone talks, a transition matched to the pace, music, a title, shorter). iMessage
 * threads, one-on-one and groups alike, get a real Linq poll after the question; if Linq can't send one
 * (a group with a member the sandbox line can't reach, SMS) the same options go out as one text. Browser
 * threads get them as chips. A vote is the voter asking for that change: inbound.ts queues the same revise
 * job a text would, once per option per poll however many people vote for it.
 */
import crypto from 'node:crypto';
import { say } from './channel.js';
import { one, tx } from './db.js';
import type { Segment } from './edl.js';
import type { Analysis } from './gemini.js';
import { linqCall } from './linq.js';
import { errMsg, log } from './log.js';

export interface PollOption { optionId: string; label: string; instruction: string; applied: boolean }
interface Suggestion { label: string; instruction: string }
/** What a browser sees of a poll: no instructions, just what to show. */
export interface PollView { messageId: string; options: Array<{ optionId: string; label: string; applied: boolean }> }
/** A vote that should become a revise job. */
interface VoteChange { projectId: string; instruction: string; label: string }
type VoteOutcome = 'queued' | 'already_applied' | 'cancelled' | 'ignored';

const QUESTION = 'Want any of these? Vote and I’ll add them, or text me anything.';
const MAX_OPTIONS = 4;

/** Next steps worth offering for this cut, most useful first. Labels are short (they're poll options). */
export function suggestions(v: {
  segments: Segment[];
  durationMs: number;
  overlays?: Array<{ kind: string }> | null;
  transitions?: unknown[] | null;
  captions?: unknown | null;
  music?: unknown | null;
}, analysis: Analysis | null): Suggestion[] {
  const out: Suggestion[] = [];
  const speech = (analysis?.transcript ?? []).some((t) => t.text?.trim());
  if (speech && !v.captions) out.push({ label: 'Auto captions', instruction: 'Add auto captions of what’s said.' });
  if (v.segments.length >= 2 && !v.transitions?.length) {
    // Fast cutting wants a punchy move; slower shots read better softly joined.
    const fast = v.durationMs / v.segments.length < 1800;
    out.push(fast
      ? { label: 'Whip transitions', instruction: 'Add whip transitions between every shot.' }
      : { label: 'Crossfade between shots', instruction: 'Crossfade between every shot.' });
  }
  if (!v.music) out.push({ label: 'Add a music bed', instruction: 'Add a music bed that fits the mood, under my audio.' });
  if (speech && !v.overlays?.some((o) => o.kind === 'text')) out.push({ label: 'Title from the hook', instruction: 'Add a short title at the top, taken from the strongest line.' });
  if (v.durationMs > 10_000) out.push({ label: 'Make it shorter', instruction: 'Make it about 8 seconds.' });
  return out.slice(0, MAX_OPTIONS);
}

/** After a first cut is delivered: the question, then the poll (or its text fallback). Once per project. */
export async function sendPoll(versionId: string): Promise<void> {
  const v = await one(
    `SELECT v.*, p.chat_id, p.analysis, p.music AS project_music FROM sticky.versions v JOIN sticky.projects p ON p.id = v.project_id WHERE v.id = $1`,
    [versionId],
  );
  if (!v || await one(`SELECT 1 FROM sticky.polls WHERE project_id = $1`, [v.project_id])) return;
  const options = suggestions({
    segments: v.segments, durationMs: v.duration_ms, overlays: v.overlays, transitions: v.transitions,
    captions: v.captions, music: v.project_music ?? v.music,
  }, v.analysis);
  if (options.length < 2) return; // Linq polls need two; one suggestion isn't a poll
  const labels = options.map((o) => o.label);
  const store = (messageId: string, how: 'poll' | 'text' | 'web', ids: string[]) => {
    const stored = options.map((o, i): PollOption => ({ optionId: ids[i], label: o.label, instruction: o.instruction, applied: false }));
    return one(
      `INSERT INTO sticky.polls (message_id, project_id, chat_id, version_no, options, how) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT DO NOTHING RETURNING message_id`,
      [messageId, v.project_id, v.chat_id, v.version_no, JSON.stringify(stored), how],
    );
  };
  const uuids = () => options.map(() => crypto.randomUUID());

  if (String(v.chat_id).startsWith('web:')) {
    await store(`web-poll-${crypto.randomUUID()}`, 'web', uuids());
    await say(v.chat_id, QUESTION).catch(() => {});
    log('poll', { project: v.project_id, how: 'web', options: labels.join(' | ') });
    return;
  }
  await say(v.chat_id, QUESTION).catch((err) => log('poll', { project: v.project_id, question: 'failed', error: errMsg(err) }, 'warn'));
  const r = await linqCall('POST', `/chats/${encodeURIComponent(v.chat_id)}/polls`, {
    poll: { options: labels.map((text) => ({ text })), idempotency_key: `sticky-poll-${v.id}` },
  }, 15_000);
  const body = (r.body?.data ?? r.body ?? {}) as any;
  const created: Array<{ option_id: string; text: string }> = body.poll?.options ?? [];
  const ids = labels.map((label) => created.find((c) => c.text?.trim() === label)?.option_id ?? '');
  if (r.status >= 200 && r.status < 300 && body.message_id && ids.every(Boolean)) {
    await store(String(body.message_id), 'poll', ids);
    log('poll', { project: v.project_id, how: 'poll', message: body.message_id, options: labels.join(' | ') });
    return;
  }
  // No poll (unreachable group member, SMS, an error): the same choices as text, which route like any reply.
  log('poll', { project: v.project_id, poll: 'failed', status: r.status, error: JSON.stringify(r.body).slice(0, 200) }, 'warn');
  await store(`text-poll-${crypto.randomUUID()}`, 'text', uuids());
  await say(v.chat_id, `Reply with any of these: ${labels.join(' · ')}`).catch(() => {});
}

/**
 * Record a vote and say what to do. "added": queue the option's change unless someone already did.
 * "removed": cancel it only if nobody else still wants it and it hasn't started.
 */
export async function applyVote(e: { messageId: string; optionId: string; voter: string | null; action: 'added' | 'removed' }): Promise<VoteChange | null> {
  return tx(async (c) => {
    const poll = (await c.query(`SELECT * FROM sticky.polls WHERE message_id = $1 FOR UPDATE`, [e.messageId])).rows[0];
    if (!poll) return null; // a poll that isn't ours (or a vote echo for one we never stored)
    const options: PollOption[] = poll.options;
    const o = options.find((x) => x.optionId === e.optionId);
    let outcome: VoteOutcome = 'ignored';
    let result: VoteChange | null = null;
    if (o && e.action === 'added') {
      if (o.applied) outcome = 'already_applied';
      else {
        o.applied = true;
        outcome = 'queued';
        result = { projectId: poll.project_id, instruction: o.instruction, label: o.label };
      }
    } else if (o && e.action === 'removed' && o.applied) {
      const stillWanted = (await c.query(
        `SELECT 1 FROM (SELECT DISTINCT ON (voter) voter, action FROM sticky.poll_votes WHERE message_id = $1 AND option_id = $2 ORDER BY voter, id DESC) v
         WHERE action = 'added' AND voter IS DISTINCT FROM $3 LIMIT 1`,
        [e.messageId, e.optionId, e.voter],
      )).rowCount;
      if (!stillWanted) {
        const cancelled = await c.query(
          `UPDATE sticky.jobs SET status = 'superseded', error = 'vote taken back', finished_at = now()
           WHERE project_id = $1 AND status = 'queued' AND direction = $2 RETURNING id`,
          [poll.project_id, o.instruction],
        );
        if (cancelled.rowCount) { o.applied = false; outcome = 'cancelled'; }
      }
    }
    await c.query(`UPDATE sticky.polls SET options = $2 WHERE message_id = $1`, [e.messageId, JSON.stringify(options)]);
    await c.query(
      `INSERT INTO sticky.poll_votes (message_id, option_id, voter, action, outcome) VALUES ($1,$2,$3,$4,$5)`,
      [e.messageId, e.optionId, e.voter, e.action, outcome],
    );
    log('poll', { vote: e.action, message: e.messageId, option: o?.label ?? e.optionId, outcome });
    return result;
  });
}

export function pollView(row: { message_id: string; options: PollOption[] }): PollView {
  return { messageId: row.message_id, options: row.options.map(({ optionId, label, applied }) => ({ optionId, label, applied })) };
}

/** The latest poll for a project, for the browser. */
export async function pollFor(projectId: string): Promise<PollView | null> {
  const p = await one(`SELECT message_id, options FROM sticky.polls WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1`, [projectId]);
  return p ? pollView(p) : null;
}
