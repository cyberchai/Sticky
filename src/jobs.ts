/**
 * The durable worker: Postgres rows + an in-process 1s ticker (core-api's diningMenuSync /
 * proactive_checks pattern). Nothing depends on memory surviving: a crash leaves rows that the
 * ticker reclaims.
 *
 *   sources  pending → (intake) → normalized
 *   projects collecting → (window closed, bytes in) → queued → rendering → delivered
 *   jobs     queued → running (one per project, by unique index) → done | failed | superseded
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { say } from './channel.js';
import { COPY, LIMITS, config, plural, today } from './config.js';
import { one, q, tx } from './db.js';
import { deliverVersion } from './deliver.js';
import { applyOps, totalMs, validateSegments, type Segment } from './edl.js';
import { EditValidationError, planV1, revise, type ClipForModel, type GenerateRequest, type MusicRequest, type VisualEditRequest } from './gemini.js';
import { UPLOAD_SCHEME, intakeSource } from './intake.js';
import { errMsg, last4, log } from './log.js';
import { choicesStillNeeded, joinNotes, standingChoices } from './polls.js';
import { LYRIA_MODEL, generateMusic } from './lyria.js';
import { extractSpan, mixMusic, render, verify, withOriginalAudio } from './media.js';
import { OMNI_MAX_MS, OMNI_MIN_MS, editVideo } from './omni.js';
import { generateClip } from './veo.js';
import { burnOverlays, keepOverlays, type Overlay } from './overlays.js';
import { keepTransitions, renderWithTransitions, timeline, type Transition } from './transitions.js';
import { captionChunks, captionOverlays, wordsFor, type Captions, type Word } from './captions.js';
import { cachePath, ensureDir, ensureLocal, putFile } from './store.js';
import { topOutliers } from './trends/outliers.js';
import { selectCandidates } from './trends/select.js';
import { isExpired, loadSnapshot, refreshInBackground, snapshotForCut } from './trends/snapshot.js';
import type { Candidate } from './trends/types.js';

const MAX_JOBS = Number(process.env.STICKY_MAX_JOBS ?? 2);
const MAX_INTAKE = Number(process.env.STICKY_MAX_INTAKE ?? 3);
const runningJobs = new Set<string>();
const runningSources = new Set<string>();
let ticking = false;

let workerOn = false;

export function startWorker(): void {
  workerOn = true;
  setInterval(() => void tick(), 1000).unref();
  setInterval(() => void trendTick(), 10 * 60 * 1000).unref();
  setTimeout(() => void trendTick(), 15_000).unref();
  log('worker', { started: true, maxJobs: MAX_JOBS, collectMs: config.collectWindowMs, echo: config.echo || undefined });
}

/** Called right after a video event is persisted, so intake starts without waiting for the tick. */
export function kickIntake(): void {
  if (!workerOn) return; // a standby leaves intake to the primary's ticker
  void pendingSources().catch((err) => log('worker', { kick: 'failed', error: errMsg(err) }, 'warn'));
}

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    await pendingSources();
    await freezeProjects();
    await claimJobs();
    await recoverStale();
    await pendingTexts();
  } catch (err) {
    log('worker', { tick: 'failed', error: errMsg(err) }, 'error');
  } finally {
    ticking = false;
  }
}

async function trendTick(): Promise<void> {
  const snap = await loadSnapshot();
  if (isExpired(snap)) refreshInBackground('ticker');
}

async function pendingSources(): Promise<void> {
  if (runningSources.size >= MAX_INTAKE) return;
  const rows = await q<{ id: string }>(`SELECT id FROM sticky.sources WHERE status = 'pending' ORDER BY created_at LIMIT $1`, [MAX_INTAKE]);
  for (const { id } of rows) {
    if (runningSources.has(id) || runningSources.size >= MAX_INTAKE) continue;
    runningSources.add(id);
    void intakeSource(id).finally(() => runningSources.delete(id));
  }
}

/** Close the quiet window once it has passed AND every known clip's bytes are in. */
async function freezeProjects(): Promise<void> {
  const due = await q(
    `SELECT p.id FROM sticky.projects p
     WHERE p.state = 'collecting' AND p.collect_deadline < now()
       AND NOT EXISTS (SELECT 1 FROM sticky.sources s WHERE s.project_id = p.id AND s.status IN ('pending','downloading'))`,
  );
  for (const { id } of due) {
    const outcome = await tx(async (c) => {
      const p = (await c.query(`SELECT * FROM sticky.projects WHERE id = $1 AND state = 'collecting' FOR UPDATE`, [id])).rows[0];
      if (!p) return null;
      const sources = (await c.query(`SELECT * FROM sticky.sources WHERE project_id = $1 AND status = 'normalized'`, [id])).rows;
      const group = Boolean((await c.query(`SELECT is_group FROM sticky.threads WHERE chat_id = $1`, [p.chat_id])).rows[0]?.is_group);
      const maxSourceMs = group ? LIMITS.groupMaxSourceMs : LIMITS.maxSourceMs;
      const originalMs = sources.reduce((s: number, r: any) => s + Number(r.timings?.originalMs ?? r.duration_ms ?? 0), 0);
      if (!sources.length) {
        await c.query(`UPDATE sticky.projects SET state = 'failed' WHERE id = $1`, [id]);
        return { chatId: p.chat_id, reply: COPY.failedFirst('download') };
      }
      if (originalMs > maxSourceMs + 500) {
        await c.query(`UPDATE sticky.projects SET state = 'failed' WHERE id = $1`, [id]);
        return { chatId: p.chat_id, reply: COPY.tooLong(Math.round(originalMs / 1000), maxSourceMs / 1000) };
      }
      if (config.echo) {
        await c.query(`UPDATE sticky.projects SET state = 'delivered' WHERE id = $1`, [id]);
        return null;
      }
      const lastInbound = sources.reduce((m: Date, r: any) => (r.created_at > m ? r.created_at : m), new Date(0));
      const direction: string[] = p.direction ?? [];
      await c.query(`UPDATE sticky.projects SET state = 'queued' WHERE id = $1`, [id]);
      await c.query(
        `INSERT INTO sticky.jobs (project_id, kind, direction, inbound_at) VALUES ($1, 'v1', $2, $3)`,
        [id, direction.join('\n') || null, lastInbound],
      );
      log('project', { project: id, frozen: true, clips: sources.length, sourceMs: originalMs, direction: direction.length || undefined });
      return null;
    });
    if (outcome) await say(outcome.chatId, outcome.reply).catch(() => {});
  }
}

async function claimJobs(): Promise<void> {
  while (runningJobs.size < MAX_JOBS) {
    let job: any = null;
    try {
      job = await one(
        `UPDATE sticky.jobs SET status = 'running', claimed_at = now(), attempts = attempts + 1
         WHERE id = (
           SELECT j.id FROM sticky.jobs j
           WHERE j.status = 'queued'
             AND NOT EXISTS (SELECT 1 FROM sticky.jobs r WHERE r.project_id = j.project_id AND r.status = 'running')
           ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1)
         RETURNING *`,
      );
    } catch (err) {
      if (!/jobs_one_running/.test(errMsg(err))) throw err; // lost a race for that project; try next tick
      return;
    }
    if (!job) return;
    runningJobs.add(job.id);
    void runJob(job).finally(() => runningJobs.delete(job.id));
  }
}

async function recoverStale(): Promise<void> {
  const stale = await q(`SELECT * FROM sticky.jobs WHERE status = 'running' AND claimed_at < now() - interval '3 minutes'`);
  for (const j of stale) {
    if (runningJobs.has(j.id)) continue;
    if (j.attempts < 2) await q(`UPDATE sticky.jobs SET status = 'queued' WHERE id = $1 AND status = 'running'`, [j.id]);
    else await failJob(j, j.stage ?? 'worker', new Error('timed out'));
  }
  await q(`UPDATE sticky.sources SET status = 'pending' WHERE status = 'downloading' AND updated_at < now() - interval '3 minutes' AND attempts < 2`);
  await q(`UPDATE sticky.sources SET status = 'failed', error = 'intake timed out' WHERE status = 'downloading' AND updated_at < now() - interval '3 minutes'`);
}

/** Texts whose post-ack processing never ran (crash/restart). */
async function pendingTexts(): Promise<void> {
  const rows = await q(`SELECT provider_event_id FROM sticky.events WHERE kind = 'text' AND handled_at IS NULL AND received_at < now() - interval '10 seconds' ORDER BY received_at LIMIT 5`);
  if (!rows.length) return;
  const { processText } = await import('./inbound.js');
  for (const r of rows) await processText(r.provider_event_id);
}

// ---------------------------------------------------------------------------------------------

async function loadClips(projectId: string, group = false): Promise<{ clips: ClipForModel[]; normPaths: Record<string, string>; sourceIds: string[]; filmed: string[] }> {
  const sources = await q(`SELECT * FROM sticky.sources WHERE project_id = $1 AND status = 'normalized' ORDER BY clip_id`, [projectId]);
  const clips: ClipForModel[] = [];
  const normPaths: Record<string, string> = {};
  for (const s of sources) {
    const proxyPath = await ensureLocal(s.proxy_key);
    normPaths[s.clip_id] = await ensureLocal(s.norm_key);
    clips.push({ clipId: s.clip_id, durationMs: s.duration_ms, hasAudio: s.has_audio, proxy: fs.readFileSync(proxyPath), from: group && s.author_handle ? last4(s.author_handle) : undefined });
  }
  const filmed = sources.filter((s: any) => !s.generated).map((s: any) => s.clip_id);
  return { clips, normPaths, sourceIds: sources.map((s: any) => s.id), filmed };
}

async function runJob(job: any): Promise<void> {
  const stageMs: Record<string, number> = {};
  let stage = 'load';
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    stage = name;
    await q(`UPDATE sticky.jobs SET stage = $2 WHERE id = $1`, [job.id, name]);
    const t = Date.now();
    try { return await fn(); } finally { stageMs[name] = Date.now() - t; }
  };
  const t0 = Date.now();
  try {
    const project = await one(
      `SELECT p.*, t.current_project_id, t.is_group AS group_chat FROM sticky.projects p JOIN sticky.threads t ON t.chat_id = p.chat_id WHERE p.id = $1`,
      [job.project_id],
    );
    if (!project || project.current_project_id !== project.id || project.state === 'closed') {
      await q(`UPDATE sticky.jobs SET status = 'superseded', finished_at = now() WHERE id = $1`, [job.id]);
      log('job', { job: job.id, superseded: 'project no longer current' });
      return;
    }
    // A group's held clips stay held (inbound.ts): an edit queued before them still runs on the current cut.
    await q(`UPDATE sticky.projects SET state = 'rendering' WHERE id = $1 AND state <> 'collecting'`, [project.id]);
    const group = Boolean(project.group_chat);
    const { clips, normPaths, sourceIds, filmed } = await timed('load', () => loadClips(project.id, group));
    if (!clips.length) throw new Error('no usable clips');

    const previous = await one(
      `SELECT * FROM sticky.versions WHERE project_id = $1 AND delivery NOT IN ('superseded','failed','pending') ORDER BY version_no DESC LIMIT 1`,
      [project.id],
    );

    let segments: Segment[];
    let technique: Candidate;
    let explanation: string;
    let model: string;
    let candidatesOffered: string[] = [];
    // undefined = music unchanged by this job; null = removed; MusicState = new bed.
    let musicTask: Promise<MusicState | null | undefined> | null = null;
    // Text, stickers and transitions carry from the last version unless this job changes them.
    let overlays: Overlay[] = previous?.overlays ?? [];
    let transitions: Transition[] = previous?.transitions ?? [];
    let captions: Captions | null = previous?.captions ?? null;
    if (job.kind === 'v1' || !previous) {
      const snapshot = await snapshotForCut();
      const { candidates, freshCount } = selectCandidates(snapshot, today());
      candidatesOffered = candidates.map((c) => c.id);
      const direction = (job.direction ?? '').split('\n').map((s: string) => s.trim()).filter(Boolean);
      const outliers = topOutliers(snapshot.outliers ?? []);
      // A group reel combines everyone's footage: every filmed clip appears, with a bit more room.
      const everyClip = group && filmed.length > 1;
      const targetMs = everyClip ? Math.min(LIMITS.maxTotalMs, Math.max(LIMITS.defaultTargetMs, 5_000 * filmed.length)) : LIMITS.defaultTargetMs;
      const plan = await timed('gemini', () => planV1({ clips, direction, candidates, targetMs, outliers, everyClip }));
      segments = plan.segments;
      // A fresh plan reuses shot ids for different moments: only whole-reel overlays carry over.
      overlays = overlays.filter((o) => o.segmentId === null);
      transitions = [];
      // The measured outlier the opening borrows from rides with the technique, so every later version
      // and "Why this cut?" cite the same real numbers.
      technique = { ...plan.technique, hookEvidence: plan.hookEvidence };
      explanation = plan.explanation;
      model = plan.model;
      await q(`UPDATE sticky.projects SET analysis = $2 WHERE id = $1`, [project.id, plan.analysis]);
      // Group: one more pass applies every standing poll pick this cut lacks (from any poll in the chat) and
      // every change texted while held. One job, one delivery. If the pass fails, the texted changes go back
      // on hold and the combined cut still goes out.
      if (group) {
        const taken = await one(
          `WITH old AS (SELECT held_notes FROM sticky.projects WHERE id = $1 FOR UPDATE)
           UPDATE sticky.projects p SET held_notes = '{}' FROM old WHERE p.id = $1 RETURNING old.held_notes AS notes`,
          [project.id],
        );
        const standing = await standingChoices(project.chat_id);
        const pickTexts = new Set(standing.map((c) => c.instruction));
        const choices = choicesStillNeeded(standing, { captions, music: project.music, overlays, transitions });
        const texted = ((taken?.notes ?? []) as string[]).filter((n) => !pickTexts.has(n));
        const asks = [...choices.map((c) => c.instruction), ...texted];
        if (asks.length) {
          try {
            const r = await timed('choices', () => revise({
              clips, analysis: plan.analysis, segments, techniqueTitle: technique.title,
              direction: joinNotes(asks), overlays, transitions,
            }));
            if (r.segments) segments = r.segments;
            if (r.overlays) overlays = r.overlays;
            if (r.transitions) transitions = r.transitions;
            if (r.captions === false) captions = null;
            else if (r.captions) captions = r.captions;
            if (r.music?.action === 'add') {
              const t = Date.now();
              musicTask = startMusic(project, r.music).finally(() => { stageMs.music = Date.now() - t; });
            }
            const named = choices.map((c) => c.label);
            if (texted.length) named.push(plural(texted.length, 'texted change'));
            explanation = `${explanation} With the group's picks: ${named.join(', ')}.`.trim();
            log('choices', { job: job.id, applied: named.join(' | '), captions: Boolean(captions), overlays: overlays.length, transitions: transitions.length, music: r.music?.action });
          } catch (err) {
            log('choices', { job: job.id, failed: errMsg(err).slice(0, 300) }, 'warn');
            if (texted.length) await q(`UPDATE sticky.projects SET held_notes = $2::text[] || held_notes WHERE id = $1`, [project.id, texted]);
          }
        }
      }
      log('plan', {
        job: job.id, model, attempts: plan.attempts, ms: plan.ms, snapshot: snapshot.origin, snapshotAt: snapshot.refreshedAt, fresh: freshCount,
        technique: technique.id, hook: `${plan.analysis.hook?.clipId}@${plan.analysis.hook?.atMs}`,
        fits: plan.candidateFit.filter((f) => f.fits).map((f) => f.techniqueId).join(','),
        outliers: outliers.length || undefined, borrowed: plan.hookEvidence ? `@${plan.hookEvidence.handle}:${plan.hookEvidence.sharedPattern}` : undefined,
        segments: segments.map((s) => `${s.id}:${s.clipId}[${s.inMs}-${s.outMs}]${s.audio === 'mute' ? 'M' : ''}`).join(' '),
      });
    } else {
      const r = await timed('gemini', () => revise({
        clips,
        analysis: project.analysis,
        segments: previous.segments,
        techniqueTitle: previous.technique.title,
        direction: job.direction ?? '',
        overlays,
        transitions,
      }));
      model = r.model;
      if (r.overlays) overlays = r.overlays;
      if (r.transitions) transitions = r.transitions;
      if (r.captions === false) captions = null;
      else if (r.captions) captions = r.captions;
      log('revise', { job: job.id, model, attempts: r.attempts, ms: r.ms, ops: JSON.stringify(r.ops).slice(0, 400), unsupported: r.unsupportedReason, generate: r.generate?.label, music: r.music ? `${r.music.action}:${r.music.label}` : undefined });
      // Music runs alongside any picture change.
      if (r.music) {
        const t = Date.now();
        musicTask = startMusic(project, r.music).finally(() => { stageMs.music = Date.now() - t; });
      }
      if (r.visualEdit) {
        const edited = await timed('omni', () => applyVisualEdit(project, job, r.visualEdit!, previous.segments, normPaths, clips));
        if (!edited) {
          await q(`UPDATE sticky.jobs SET status = 'done', stage_ms = $2, model = $3, error = $4, finished_at = now() WHERE id = $1`, [job.id, stageMs, model, `unsupported: could not edit ${r.visualEdit.label}`]);
          await q(`UPDATE sticky.projects SET state = 'delivered' WHERE id = $1 AND state = 'rendering'`, [project.id]);
          return;
        }
        Object.assign(normPaths, edited.newPaths);
        segments = edited.segments;
        technique = previous.technique;
        explanation = edited.explanation;
      } else if (r.generate) {
        const inserted = await timed('generate', () => insertGenerated(project, job, r.generate!, previous.segments, clips));
        if (!inserted) {
          await q(`UPDATE sticky.jobs SET status = 'done', stage_ms = $2, model = $3, error = $4, finished_at = now() WHERE id = $1`, [job.id, stageMs, model, `unsupported: could not generate ${r.generate.label}`]);
          await q(`UPDATE sticky.projects SET state = 'delivered' WHERE id = $1 AND state = 'rendering'`, [project.id]);
          return;
        }
        normPaths[inserted.clipId] = inserted.normPath;
        segments = inserted.segments;
        technique = previous.technique;
        explanation = inserted.explanation;
      } else if (!r.segments) {
        // The edit is settled either way; a failed reply must not turn it into a "couldn't finish" text too.
        await say(project.chat_id, COPY.unsupported(r.unsupportedReason ?? "I can't make that change with this footage."))
          .catch((err) => log('reply', { job: job.id, unsupported: 'reply failed', error: errMsg(err) }, 'warn'));
        await q(`UPDATE sticky.jobs SET status = 'done', stage_ms = $2, model = $3, error = $4, finished_at = now() WHERE id = $1`, [job.id, stageMs, model, `unsupported: ${r.unsupportedReason}`]);
        await q(`UPDATE sticky.projects SET state = 'delivered' WHERE id = $1 AND state = 'rendering'`, [project.id]);
        return;
      } else {
        segments = r.segments;
        technique = previous.technique;
        explanation = r.explanation || previous.explanation;
      }
    }

    const versionNo = Number((await one(`SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM sticky.versions WHERE project_id = $1`, [project.id]))?.n ?? 1);
    const outKey = `sticky/${project.id}/v${versionNo}-${crypto.randomUUID().slice(0, 8)}.mp4`;
    const outPath = cachePath(outKey);
    await ensureDir(outPath);
    // Anything tied to a shot that's no longer in the cut goes with it.
    overlays = keepOverlays(overlays, segments);
    transitions = keepTransitions(transitions, segments);
    const expected = timeline(segments, transitions).totalMs; // shorter than the shots' sum when transitions overlap them
    await timed('render', () => (transitions.length ? renderWithTransitions(segments, transitions, normPaths, outPath) : render(segments, normPaths, outPath)));
    // Captions: each clip's timed words (aligned once, cached), mapped through this cut.
    const captionItems = captions
      ? await timed('captions', async () => {
        const used = new Set(segments.map((s) => s.clipId));
        const sources = await q(`SELECT * FROM sticky.sources WHERE project_id = $1 AND status = 'normalized'`, [project.id]);
        const wordsByClip: Record<string, Word[]> = {};
        await Promise.all(sources.filter((s: any) => used.has(s.clip_id)).map(async (s: any) => { wordsByClip[s.clip_id] = await wordsFor(s, project.analysis); }));
        return captionOverlays(captionChunks(segments, transitions, wordsByClip), captions!);
      })
      : [];
    if (overlays.length || captionItems.length) {
      const burned = `${outPath}.overlays.mp4`;
      await timed('overlays', () => burnOverlays(outPath, burned, segments, transitions, overlays, captionItems));
      fs.renameSync(burned, outPath);
    }
    let exported = await timed('probe', () => verify(outPath, expected));

    // The music bed: newly requested (or removed) in this job, otherwise whatever the project already has.
    const requested = musicTask ? await musicTask : undefined;
    const music: MusicState | null = requested === undefined ? (project.music ?? null) : requested;
    if (music) {
      const mixed = `${outPath}.mix.mp4`;
      await timed('mix', async () => mixMusic(outPath, await ensureLocal(music.key), music.mode, exported.durationMs, mixed));
      fs.renameSync(mixed, outPath);
      exported = await verify(outPath, expected);
      if (requested) explanation = `${explanation ? `${explanation} ` : ''}Added AI-generated music (Lyria): ${music.label}, ${music.mode === 'replace' ? 'replacing the original sound' : 'under your original audio'}.`.trim();
    }
    if (requested === null && project.music) explanation = `${explanation ? `${explanation} ` : ''}Removed the music.`.trim();
    await timed('store', () => putFile(outKey, outPath, 'video/mp4'));

    const version = await one(
      `INSERT INTO sticky.versions (project_id, version_no, job_id, segments, technique, explanation, direction, out_key, link_token, duration_ms, music, overlays, transitions, captions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [project.id, versionNo, job.id, JSON.stringify(segments), JSON.stringify(technique), explanation,
        job.kind === 'revise' ? job.direction : (job.direction || null), outKey, crypto.randomBytes(16).toString('hex'), exported.durationMs,
        music ? JSON.stringify(music) : null, JSON.stringify(overlays), JSON.stringify(transitions), captions ? JSON.stringify(captions) : null],
    );
    await q(`UPDATE sticky.projects SET music = $2 WHERE id = $1`, [project.id, music ? JSON.stringify(music) : null]);
    const outcome = await timed('deliver', () => deliverVersion(version!.id));

    await q(
      `UPDATE sticky.jobs SET status = $2, version_no = $3, stage = 'done', stage_ms = $4, model = $5, finished_at = now() WHERE id = $1`,
      [job.id, outcome === 'superseded' ? 'superseded' : 'done', versionNo, stageMs, model],
    );
    await q(`UPDATE sticky.projects SET state = 'delivered' WHERE id = $1 AND state = 'rendering'`, [project.id]);
    log('job', {
      job: job.id, kind: job.kind, project: project.id, v: versionNo, outcome, durMs: exported.durationMs,
      technique: technique.id, offered: candidatesOffered.length || undefined,
      sinceInboundMs: Date.now() - new Date(job.inbound_at).getTime(), jobMs: Date.now() - t0, ...stageMs,
    });

    // A clip that arrived during this render is kept for a follow-up cut.
    const late = await q(`SELECT id FROM sticky.sources WHERE project_id = $1 AND followup AND NOT (id = ANY($2::uuid[]))`, [project.id, sourceIds]);
    if (late.length) {
      await q(`UPDATE sticky.sources SET followup = false WHERE id = ANY($1::uuid[])`, [late.map((r: any) => r.id)]);
      // A group holds new footage for its "go ahead" (inbound.ts); one-on-one recuts right away.
      if (group) await q(`UPDATE sticky.projects SET state = 'collecting', collect_deadline = NULL WHERE id = $1 AND state = 'delivered'`, [project.id]);
      else await q(`INSERT INTO sticky.jobs (project_id, kind, direction) VALUES ($1, 'v1', $2)`, [project.id, 'Work the newly added clip into the cut.']);
    } else if (sourceIds.length) {
      await q(`UPDATE sticky.sources SET followup = false WHERE id = ANY($1::uuid[])`, [sourceIds]);
    }
  } catch (err) {
    await failJob({ ...job, stage_ms: stageMs }, stage, err);
  }
}

/**
 * "Add a dog at the end" when there is no dog: generate a short vertical shot with Veo, take it in like
 * any clip (normalize, proxy), and insert it. The shot is stored as generated and described as
 * AI-generated in the analysis, so "Why this cut?" and later revisions say what it is.
 * Returns null (after telling the user) when generation is refused or fails; the last cut stays.
 */
async function insertGenerated(project: any, job: any, g: GenerateRequest, current: Segment[], clips: ClipForModel[]): Promise<{ clipId: string; normPath: string; segments: Segment[]; explanation: string } | null> {
  await say(project.chat_id, COPY.generating(g.label)).catch(() => {});
  let bytes: Buffer;
  try {
    ({ bytes } = await generateClip(g.prompt, g.seconds));
  } catch (err) {
    log('veo', { job: job.id, failed: errMsg(err).slice(0, 300) }, 'warn');
    const reason = /filter|safety|rai/i.test(errMsg(err)) ? 'the video model declined that request' : 'the video model did not respond in time';
    await say(project.chat_id, COPY.generateFailed(reason)).catch(() => {});
    return null;
  }
  const { n } = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM sticky.sources WHERE project_id = $1`, [project.id]))!;
  const clipId = `c${n + 1}`;
  const key = `sticky/${project.id}/${clipId}/generated.mp4`;
  await ensureDir(cachePath(key));
  fs.writeFileSync(cachePath(key), bytes);
  await putFile(key, cachePath(key), 'video/mp4');
  const src = await one<{ id: string }>(
    `INSERT INTO sticky.sources (project_id, clip_id, provider_message_id, part_id, url, mime, name, generated, gen_prompt)
     VALUES ($1, $2, $3, 'veo', $4, 'video/mp4', $5, true, $6) RETURNING id`,
    [project.id, clipId, `veo-${job.id}`, `${UPLOAD_SCHEME}${key}`, `AI-generated: ${g.label}`, g.prompt],
  );
  await intakeSource(src!.id);
  const s = await one(`SELECT * FROM sticky.sources WHERE id = $1`, [src!.id]);
  if (s?.status !== 'normalized') throw new Error(`generated clip intake failed: ${s?.error ?? 'unknown'}`);

  // Fit inside the 20s ceiling; the generated shot gives way, never the user's footage.
  const room = LIMITS.maxTotalMs - totalMs(current);
  const outMs = Math.min(s.duration_ms, room);
  if (outMs < LIMITS.minSegmentMs) throw new Error('no room for another shot under 20 seconds; ask to shorten first');
  const applied = applyOps(current, [{ op: 'insert', clipId, inMs: 0, outMs, audio: g.audio, atIndex: g.atIndex }]);
  const errors = [...applied.errors, ...validateSegments(applied.segments, [...clips.map(({ clipId: id, durationMs, hasAudio }) => ({ clipId: id, durationMs, hasAudio })), { clipId, durationMs: s.duration_ms, hasAudio: s.has_audio }])];
  if (errors.length) throw new Error(errors.join('; '));

  const moment = { clipId, startMs: 0, endMs: s.duration_ms, role: 'context', what: `AI-generated shot (Veo) of ${g.label}` };
  await q(
    `UPDATE sticky.projects SET analysis = jsonb_set(COALESCE(analysis, '{}'::jsonb), '{moments}', COALESCE(analysis->'moments', '[]'::jsonb) || $2::jsonb) WHERE id = $1`,
    [project.id, JSON.stringify([moment])],
  );
  const where = g.atIndex <= 0 ? 'at the start' : g.atIndex >= current.length ? 'at the end' : `as shot ${g.atIndex + 1}`;
  return {
    clipId,
    normPath: await ensureLocal(s.norm_key),
    segments: applied.segments,
    explanation: `Added an AI-generated shot of ${g.label} (Veo) ${where}, since it wasn't in your footage.`,
  };
}

/**
 * "Make her dress purple": edit the targeted stretch of the user's own clip with Gemini Omni, put the
 * original audio back, take the result in as an AI-edited clip, and repoint only the targeted shots to
 * it (same offsets). Untouched shots keep their exact source and boundaries. Returns null (after telling
 * the user) if the edit is refused or fails; the last cut stays.
 */
async function applyVisualEdit(project: any, job: any, ve: VisualEditRequest, current: Segment[], normPaths: Record<string, string>, clips: ClipForModel[]): Promise<{ newPaths: Record<string, string>; segments: Segment[]; explanation: string } | null> {
  if (!config.bucket) throw new Error('visual edits need STICKY_BUCKET (Omni reads the clip from GCS)');
  const targets = current.filter((s) => ve.segmentIds.includes(s.id));
  if (!targets.length) throw new Error('no shots selected for the visual edit');
  const durationOf = new Map(clips.map((c) => [c.clipId, c.durationMs]));

  // One Omni call per source clip when the targeted shots fit in 15 s, else one per shot; each ≥ 3 s.
  type Span = { clipId: string; inMs: number; outMs: number; segIds: string[] };
  const pad = (sp: Span): Span => {
    const dur = durationOf.get(sp.clipId) ?? 0;
    if (dur < OMNI_MIN_MS) throw new Error('that clip is under 3 seconds, too short to edit');
    let { inMs, outMs } = sp;
    if (outMs - inMs < OMNI_MIN_MS) outMs = Math.min(dur, inMs + OMNI_MIN_MS);
    if (outMs - inMs < OMNI_MIN_MS) inMs = Math.max(0, outMs - OMNI_MIN_MS);
    return { ...sp, inMs, outMs };
  };
  const spans: Span[] = [];
  for (const clipId of [...new Set(targets.map((s) => s.clipId))]) {
    const segs = targets.filter((s) => s.clipId === clipId);
    const lo = Math.min(...segs.map((s) => s.inMs));
    const hi = Math.max(...segs.map((s) => s.outMs));
    if (hi - lo <= OMNI_MAX_MS) spans.push(pad({ clipId, inMs: lo, outMs: hi, segIds: segs.map((s) => s.id) }));
    else for (const s of segs) {
      if (s.outMs - s.inMs > OMNI_MAX_MS) throw new Error(`shot ${s.id} is longer than 15 seconds, too long to edit in one pass`);
      spans.push(pad({ clipId, inMs: s.inMs, outMs: s.outMs, segIds: [s.id] }));
    }
  }

  await say(project.chat_id, COPY.editing(ve.label)).catch(() => {});
  const { n } = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM sticky.sources WHERE project_id = $1`, [project.id]))!;
  const instruction = `${ve.instruction} Keep everything else exactly the same: the people, their faces and movements, the framing, the lighting and the camera motion.`;
  let results: Array<{ sp: Span; clipId: string; normPath: string; durationMs: number }>;
  try {
    results = await Promise.all(spans.map(async (sp, i) => {
      const clipId = `c${n + 1 + i}`;
      const base = `sticky/${project.id}/${clipId}`;
      const spanKey = `${base}/span.mp4`;
      const finalKey = `${base}/edited.mp4`;
      await ensureDir(cachePath(spanKey));
      await extractSpan(normPaths[sp.clipId], sp.inMs, sp.outMs, cachePath(spanKey));
      await putFile(spanKey, cachePath(spanKey), 'video/mp4');
      const { bytes } = await editVideo(`gs://${config.bucket}/${spanKey}`, instruction);
      fs.writeFileSync(cachePath(`${base}/omni.mp4`), bytes);
      await withOriginalAudio(cachePath(`${base}/omni.mp4`), cachePath(spanKey), cachePath(finalKey));
      await putFile(finalKey, cachePath(finalKey), 'video/mp4');
      const src = await one<{ id: string }>(
        `INSERT INTO sticky.sources (project_id, clip_id, provider_message_id, part_id, url, mime, name, generated, gen_prompt)
         VALUES ($1, $2, $3, $4, $5, 'video/mp4', $6, true, $7) RETURNING id`,
        [project.id, clipId, `omni-${job.id}`, `omni-${i}`, `${UPLOAD_SCHEME}${finalKey}`, `AI-edited: ${ve.label} (from ${sp.clipId})`, ve.instruction],
      );
      await intakeSource(src!.id);
      const s = await one(`SELECT * FROM sticky.sources WHERE id = $1`, [src!.id]);
      if (s?.status !== 'normalized') throw new Error(`edited clip intake failed: ${s?.error ?? 'unknown'}`);
      return { sp, clipId, normPath: await ensureLocal(s.norm_key), durationMs: s.duration_ms };
    }));
  } catch (err) {
    log('omni', { job: job.id, failed: errMsg(err).slice(0, 300) }, 'warn');
    const reason = /safety|filter|blocked|policy/i.test(errMsg(err)) ? 'the video model declined that request'
      : /too short|too long/.test(errMsg(err)) ? errMsg(err) : 'the video model did not finish';
    await say(project.chat_id, COPY.editFailed(reason)).catch(() => {});
    return null;
  }

  const segments = current.map((s) => {
    const r = results.find((x) => x.sp.segIds.includes(s.id));
    if (!r) return s;
    return { ...s, clipId: r.clipId, inMs: s.inMs - r.sp.inMs, outMs: Math.min(r.durationMs, s.outMs - r.sp.inMs) };
  });
  const errors = validateSegments(segments, [
    ...clips.map(({ clipId, durationMs, hasAudio }) => ({ clipId, durationMs, hasAudio })),
    ...results.map((r) => ({ clipId: r.clipId, durationMs: r.durationMs, hasAudio: true })),
  ]);
  if (errors.length) throw new Error(errors.join('; '));

  // The edited clips carry the same moments, labeled, so "Why this cut?" and later revisions know them.
  const analysis = (await one(`SELECT analysis FROM sticky.projects WHERE id = $1`, [project.id]))?.analysis ?? {};
  const moments: any[] = Array.isArray(analysis.moments) ? analysis.moments : [];
  const added = results.flatMap((r) => moments
    .filter((m) => m.clipId === r.sp.clipId && m.endMs > r.sp.inMs && m.startMs < r.sp.outMs)
    .map((m) => ({ ...m, clipId: r.clipId, startMs: Math.max(0, m.startMs - r.sp.inMs), endMs: Math.min(r.durationMs, m.endMs - r.sp.inMs), what: `${String(m.what).replace(/\.$/, '')} (AI-edited with Gemini Omni: ${ve.label})` })));
  await q(`UPDATE sticky.projects SET analysis = jsonb_set(COALESCE(analysis, '{}'::jsonb), '{moments}', COALESCE(analysis->'moments', '[]'::jsonb) || $2::jsonb) WHERE id = $1`, [project.id, JSON.stringify(added)]);

  return {
    newPaths: Object.fromEntries(results.map((r) => [r.clipId, r.normPath])),
    segments,
    explanation: `Edited ${targets.length} shot${targets.length === 1 ? '' : 's'} with Gemini Omni (${ve.label}); original audio kept, every other shot untouched.`,
  };
}

export interface MusicState { key: string; label: string; prompt: string; mode: 'under' | 'replace'; provider: 'lyria'; model: string }

/** Generate (or drop) the music bed. undefined = generation failed (the user is told; the old bed stays). */
async function startMusic(project: any, req: MusicRequest): Promise<MusicState | null | undefined> {
  if (req.action === 'remove') return null;
  await say(project.chat_id, COPY.scoring(req.label)).catch(() => {});
  try {
    const { bytes } = await generateMusic(req.prompt);
    const key = `sticky/${project.id}/music/${crypto.randomUUID().slice(0, 8)}.wav`;
    await ensureDir(cachePath(key));
    fs.writeFileSync(cachePath(key), bytes);
    await putFile(key, cachePath(key), 'audio/wav');
    return { key, label: req.label, prompt: req.prompt, mode: req.mode, provider: 'lyria', model: LYRIA_MODEL };
  } catch (err) {
    log('lyria', { project: project.id, failed: errMsg(err).slice(0, 300) }, 'warn');
    const reason = /artist|recitation|safety|blocked/i.test(errMsg(err)) ? 'the music model declined that prompt' : 'the music model did not respond';
    await say(project.chat_id, COPY.scoreFailed(reason)).catch(() => {});
    return undefined;
  }
}

async function failJob(job: any, stage: string, err: unknown): Promise<void> {
  const detail = err instanceof EditValidationError ? err.errors.join('; ') : errMsg(err);
  await q(`UPDATE sticky.jobs SET status = 'failed', stage = $2, error = $3, stage_ms = $4, finished_at = now() WHERE id = $1`, [job.id, stage, detail.slice(0, 2000), job.stage_ms ?? {}]);
  const p = await one(`SELECT p.*, EXISTS (SELECT 1 FROM sticky.versions v WHERE v.project_id = p.id AND v.delivery IN ('accepted','delivered','link_degraded')) AS has_cut FROM sticky.projects p WHERE p.id = $1`, [job.project_id]);
  if (p) {
    await q(`UPDATE sticky.projects SET state = $2 WHERE id = $1 AND state IN ('rendering','queued')`, [p.id, p.has_cut ? 'delivered' : 'failed']);
    const label = stage === 'gemini' ? 'the edit decision' : stage;
    await say(p.chat_id, p.has_cut ? COPY.failed(label) : COPY.failedFirst(label)).catch(() => {});
  }
  log('job', { job: job.id, kind: job.kind, failed: stage, error: detail.slice(0, 500) }, 'error');
}
