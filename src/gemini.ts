/**
 * Every model call. Gemini makes the edit decisions; code validates them and renders.
 * Video goes in as inline proxies (same timeline as the normalized files) with videoMetadata.fps.
 * Schema-constrained JSON; one retry with the validation errors (core-api social/draft.ts pattern).
 */
import { GoogleGenAI } from '@google/genai';
import { config, LIMITS } from './config.js';
import { applyOps, normalizeSegments, totalMs, usableMs, validateSegments, type ClipInfo, type Op, type Segment } from './edl.js';
import { errMsg, log } from './log.js';
import { evidenceLabel } from './trends/select.js';
import type { Outlier } from './trends/outliers.js';
import type { Candidate } from './trends/types.js';
import { OVERLAY_ANIMATIONS, OVERLAY_SIZES, OVERLAY_STYLES, normalizeOverlays, type Overlay } from './overlays.js';
import { TRANSITION_TYPES, normalizeTransitions, type Transition } from './transitions.js';

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  if (client) return client;
  client = config.gemini.apiKey
    ? new GoogleGenAI({ apiKey: config.gemini.apiKey })
    : new GoogleGenAI({ vertexai: true, project: config.gemini.project, location: config.gemini.location });
  return client;
}

let primaryUnavailable = false;
/** The event model first (if configured and reachable), then the known-good fallback. */
export function videoModels(): string[] {
  const list: string[] = [];
  if (config.gemini.videoModel && !primaryUnavailable) list.push(config.gemini.videoModel);
  list.push(config.gemini.fallbackModel);
  return [...new Set(list)];
}

function thinkingFor(model: string): Record<string, unknown> {
  const level = (process.env.STICKY_THINKING_LEVEL ?? '').trim().toUpperCase();
  if (level) return { thinkingConfig: { thinkingLevel: level } };
  return /gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: 'LOW' } } : {};
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]);
}

const unavailable = (err: unknown) => /not.?found|404|403|permission|unsupported|does not have access|invalid model/i.test(errMsg(err));

async function generateJson<T>(models: string[], contents: unknown, cfg: Record<string, unknown>, timeoutMs: number, what: string): Promise<{ data: T; model: string; ms: number }> {
  let last: unknown;
  for (const model of models) {
    const t0 = Date.now();
    try {
      const res = await withTimeout(ai().models.generateContent({
        model,
        contents: contents as any,
        config: { responseMimeType: 'application/json', ...thinkingFor(model), ...cfg } as any,
      }), timeoutMs, `${what} on ${model}`);
      const text = (res.text ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
      return { data: JSON.parse(text) as T, model, ms: Date.now() - t0 };
    } catch (err) {
      last = err;
      log('gemini', { what, model, failed: errMsg(err).slice(0, 300), ms: Date.now() - t0 }, 'warn');
      if (model === config.gemini.videoModel && unavailable(err)) primaryUnavailable = true;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

// ---------------------------------------------------------------------------------------------
// Shared schema pieces
// ---------------------------------------------------------------------------------------------

const S = {
  str: { type: 'string' },
  int: { type: 'integer' },
  bool: { type: 'boolean' },
};

const segmentSchema = {
  type: 'object',
  properties: { id: S.str, clipId: S.str, inMs: S.int, outMs: S.int, audio: { type: 'string', enum: ['keep', 'mute'] } },
  required: ['id', 'clipId', 'inMs', 'outMs', 'audio'],
  propertyOrdering: ['id', 'clipId', 'inMs', 'outMs', 'audio'],
};

const pointSchema = {
  type: 'object',
  properties: { clipId: S.str, atMs: S.int, what: S.str, reason: S.str },
  required: ['clipId', 'atMs', 'what', 'reason'],
};

export interface ClipForModel extends ClipInfo {
  proxy: Buffer;
}

function clipInfosOf(clips: ClipForModel[]): ClipInfo[] {
  return clips.map(({ clipId, durationMs, hasAudio }) => ({ clipId, durationMs, hasAudio }));
}

export interface Moment { clipId: string; startMs: number; endMs: number; role: string; what: string }
export interface Analysis {
  transcript: Array<{ clipId: string; startMs: number; endMs: number; text: string }>;
  moments: Moment[];
  hook: { clipId: string; atMs: number; what: string; reason: string };
  payoff: { clipId: string; atMs: number; what: string; reason: string };
}

function videoParts(clips: ClipForModel[], fps: number): unknown[] {
  const parts: unknown[] = [];
  for (const c of clips) {
    parts.push({ text: `Clip ${c.clipId}: ${c.durationMs} ms long, ${c.hasAudio ? 'with its own recorded audio' : 'no recorded audio (silent)'}.` });
    parts.push({ inlineData: { mimeType: 'video/mp4', data: c.proxy.toString('base64') }, videoMetadata: { fps } });
  }
  return parts;
}

function candidateBrief(c: Candidate) {
  return {
    techniqueId: c.id,
    rank: c.rank,
    title: c.title,
    evidence: evidenceLabel(c),
    whatItIs: c.summary,
    footageMustContain: c.requires,
    edit: c.ops,
  };
}

const RULES = `Hard rules:
- The output is a 9:16 Reel made ONLY of hard cuts between time ranges of the given clips. No text, captions, graphics, music, speed changes, zooms, filters or transitions exist.
- All times are integer milliseconds relative to the start of each clip as given (0 = first frame of that clip).
- Segments play in array order. A segment may come from any clip; order does not have to follow the source.
- Each segment is at least ${LIMITS.minSegmentMs} ms. Total length ${LIMITS.minTotalMs}-${LIMITS.maxTotalMs} ms (shorter only if all the footage is shorter).
- audio "keep" plays the clip's sound for that segment; "mute" plays silence.
- Never claim reach, views, virality, growth or performance. Never invent a score.`;

// ---------------------------------------------------------------------------------------------
// v1: one multimodal call: find the moments, pick the technique, cut
// ---------------------------------------------------------------------------------------------

export interface PlanResult {
  analysis: Analysis;
  segments: Segment[];
  technique: Candidate;
  explanation: string;
  directionApplied: string | null;
  candidateFit: Array<{ techniqueId: string; fits: boolean; evidence: string }>;
  /** A measured outlier whose opening pattern this cut borrows (real counts, cited; null when none fit). */
  hookEvidence: (Outlier & { sharedPattern: string }) | null;
  model: string;
  attempts: number;
  ms: number;
}

const v1Schema = {
  type: 'object',
  properties: {
    transcript: { type: 'array', items: { type: 'object', properties: { clipId: S.str, startMs: S.int, endMs: S.int, text: S.str }, required: ['clipId', 'startMs', 'endMs', 'text'] } },
    moments: {
      type: 'array',
      items: {
        type: 'object',
        properties: { clipId: S.str, startMs: S.int, endMs: S.int, role: { type: 'string', enum: ['hook', 'payoff', 'context', 'setup', 'dead'] }, what: S.str },
        required: ['clipId', 'startMs', 'endMs', 'role', 'what'],
      },
    },
    hook: pointSchema,
    payoff: pointSchema,
    candidateFit: { type: 'array', items: { type: 'object', properties: { techniqueId: S.str, fits: S.bool, evidence: S.str }, required: ['techniqueId', 'fits', 'evidence'] } },
    techniqueId: S.str,
    segments: { type: 'array', items: segmentSchema },
    explanation: S.str,
    directionApplied: { type: 'string', nullable: true },
    hookEvidenceId: { type: 'string', nullable: true },
    sharedPattern: { type: 'string', nullable: true },
  },
  required: ['transcript', 'moments', 'hook', 'payoff', 'candidateFit', 'techniqueId', 'hookEvidenceId', 'segments', 'explanation'],
  propertyOrdering: ['transcript', 'moments', 'hook', 'payoff', 'candidateFit', 'techniqueId', 'hookEvidenceId', 'sharedPattern', 'segments', 'explanation', 'directionApplied'],
};

const V1_SYSTEM = `You are Sticky's video editor. You watch and listen to raw phone footage and return an edit decision list for a short Instagram Reel.
Work in this order:
1. Transcribe any speech with clip-relative timestamps (empty array if there is none).
2. List the real moments in the footage with their roles: hook (the strongest possible opening: a striking line, an action, the moment something changes), payoff, context, setup, dead (idle time, camera fiddling, silence).
3. Evaluate EVERY candidate technique in the given rank order: fits=true only if everything it needs is actually visible or audible in THIS footage; give the evidence (clip and time).
4. Choose the FIRST candidate in rank order that fits. If none of the dated ones fit, an evergreen one will.
5. Cut so the chosen technique changes what the viewer sees or hears: the opening, the shot order, the pacing, the audio, or the ending.
Priorities, highest first:
A. The user's direction, if any, overrides the technique and every default.
B. When speech carries the story, keep complete thoughts with intelligible audio; never cut inside a word or sentence.
C. Open on the hook, end on the payoff, drop dead time and setup.
explanation = ONE plain sentence on what the opening is and why, in terms of the footage. No hype.
${RULES}`;

export async function planV1(input: {
  clips: ClipForModel[];
  direction: string[];
  candidates: Candidate[];
  targetMs: number;
  outliers?: Outlier[];
}): Promise<PlanResult> {
  const clipsInfo = clipInfosOf(input.clips);
  const target = Math.min(input.targetMs, usableMs(clipsInfo));
  const direction = input.direction.map((d) => d.trim()).filter(Boolean);
  const outliers = input.outliers ?? [];
  const brief = `${direction.length ? `Direction from the user (this wins over everything else): ${direction.map((d) => `"${d}"`).join(' then ')}` : 'The user gave no direction. Decide everything from the footage.'}
Target length: about ${target} ms unless the direction says otherwise.
Candidate techniques in rank order (recency, then independent corroboration). Choose the first that fits this footage:
${JSON.stringify(input.candidates.map(candidateBrief), null, 1)}
${outliers.length ? `Measured outliers this week (real counts from a trending feed; posts whose views far outran their creator's following), with how each one OPENS:
${JSON.stringify(outliers.map((o) => ({ id: o.id, platform: o.platform, openingPattern: o.hook, opening: o.opening, viewsPerFollower: o.viewsPerFollower })), null, 1)}
If THIS footage contains a moment that can open the same way (same opening pattern, e.g. a spoken question, a bold claim, a reveal), open the cut on that moment, set hookEvidenceId to that outlier's id and sharedPattern to one short phrase naming the shared opening. Otherwise set hookEvidenceId to null. Never imply this reel will get similar numbers.` : 'No measured outliers are available; set hookEvidenceId to null.'}
Use segment ids s1, s2, s3... in playback order.`;

  let retryNote = '';
  let totalModelMs = 0;
  let lastErrors: string[] = [];
  for (let attempts = 1; attempts <= 2; attempts++) {
    const contents = [{ role: 'user', parts: [...videoParts(input.clips, config.gemini.fps), { text: brief + retryNote }] }];
    const { data, model, ms } = await generateJson<any>(videoModels(), contents, { systemInstruction: V1_SYSTEM, responseSchema: v1Schema }, 90_000, 'plan_v1');
    totalModelMs += ms;
    const segments = normalizeSegments(data?.segments);
    const errors = validateSegments(segments, clipsInfo);
    const technique = input.candidates.find((c) => c.id === data?.techniqueId);
    const fit = Array.isArray(data?.candidateFit) ? data.candidateFit : [];
    if (!technique) errors.push(`techniqueId "${data?.techniqueId}" is not one of the candidate ids`);
    else if (fit.some((f: any) => f?.techniqueId === technique.id && f?.fits === false)) errors.push(`techniqueId ${technique.id} was marked fits=false; choose a candidate that fits`);
    if (!errors.length && technique) {
      const evidence = outliers.find((o) => o.id === data?.hookEvidenceId) ?? null;
      return {
        analysis: { transcript: data.transcript ?? [], moments: data.moments ?? [], hook: data.hook, payoff: data.payoff },
        segments,
        technique,
        explanation: String(data.explanation ?? '').trim(),
        directionApplied: data.directionApplied ?? null,
        candidateFit: fit,
        hookEvidence: evidence ? { ...evidence, sharedPattern: String(data.sharedPattern ?? evidence.hook ?? '').trim().slice(0, 80) } : null,
        model,
        attempts,
        ms: totalModelMs,
      };
    }
    lastErrors = errors;
    log('gemini', { what: 'plan_v1', attempt: attempts, invalid: errors.join('; ').slice(0, 400) }, 'warn');
    retryNote = `\n\nYour previous answer was rejected by the validator. Fix exactly these problems and answer again:\n- ${errors.join('\n- ')}`;
  }
  throw new EditValidationError(lastErrors);
}

export class EditValidationError extends Error {
  constructor(readonly errors: string[]) {
    super(`edit decision invalid after retry: ${errors.join('; ')}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Revisions: targeted operations on existing segment ids
// ---------------------------------------------------------------------------------------------

const reviseSchema = {
  type: 'object',
  properties: {
    understanding: S.str,
    unsupportedReason: { type: 'string', nullable: true },
    // Every field required-but-nullable: with optional fields the decoder skipped `audio` on set_audio.
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['move', 'trim', 'set_audio', 'remove', 'insert'] },
          id: { type: 'string', nullable: true },
          audio: { type: 'string', enum: ['keep', 'mute'], nullable: true },
          toIndex: { type: 'integer', nullable: true },
          inMs: { type: 'integer', nullable: true },
          outMs: { type: 'integer', nullable: true },
          clipId: { type: 'string', nullable: true },
          atIndex: { type: 'integer', nullable: true },
        },
        required: ['op', 'id', 'audio', 'toIndex', 'inMs', 'outMs', 'clipId', 'atIndex'],
        propertyOrdering: ['op', 'id', 'audio', 'toIndex', 'inMs', 'outMs', 'clipId', 'atIndex'],
      },
    },
    // Something the footage lacks that a short generated shot can show (a dog, the beach, snow…).
    generate: {
      type: 'object',
      nullable: true,
      properties: {
        label: S.str,
        prompt: S.str,
        seconds: S.int, // 4, 6 or 8 (Gemini schemas allow enums on strings only; snapped in code)
        atIndex: S.int,
        audio: { type: 'string', enum: ['keep', 'mute'] },
      },
      required: ['label', 'prompt', 'seconds', 'atIndex', 'audio'],
      propertyOrdering: ['label', 'prompt', 'seconds', 'atIndex', 'audio'],
    },
    // A music bed for the whole cut ("add animatronic music"), or taking it off. Combines with any other change.
    music: {
      type: 'object',
      nullable: true,
      properties: {
        action: { type: 'string', enum: ['add', 'remove'] },
        label: S.str,
        prompt: S.str,
        mode: { type: 'string', enum: ['under', 'replace'] },
      },
      required: ['action', 'label', 'prompt', 'mode'],
      propertyOrdering: ['action', 'label', 'prompt', 'mode'],
    },
    // Text and stickers drawn over the cut: null = unchanged; a list = the COMPLETE new set.
    overlays: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', nullable: true },
          kind: { type: 'string', enum: ['text', 'sticker'] },
          text: { type: 'string', nullable: true },
          emoji: { type: 'string', nullable: true },
          segmentId: { type: 'string', nullable: true },
          x: { type: 'number' },
          y: { type: 'number' },
          size: { type: 'string', enum: [...OVERLAY_SIZES] },
          style: { type: 'string', enum: [...OVERLAY_STYLES], nullable: true },
          animation: { type: 'string', enum: [...OVERLAY_ANIMATIONS] },
        },
        required: ['id', 'kind', 'text', 'emoji', 'segmentId', 'x', 'y', 'size', 'style', 'animation'],
        propertyOrdering: ['id', 'kind', 'text', 'emoji', 'segmentId', 'x', 'y', 'size', 'style', 'animation'],
      },
    },
    // Transitions INTO shots: null = unchanged; a list = the COMPLETE new set (empty = all hard cuts).
    transitions: {
      type: 'array',
      nullable: true,
      items: {
        type: 'object',
        properties: { segmentId: S.str, type: { type: 'string', enum: [...TRANSITION_TYPES] }, ms: S.int },
        required: ['segmentId', 'type', 'ms'],
        propertyOrdering: ['segmentId', 'type', 'ms'],
      },
    },
    // A change to how something INSIDE the user's footage looks ("make her dress purple").
    visualEdit: {
      type: 'object',
      nullable: true,
      properties: {
        label: S.str,
        instruction: S.str,
        segmentIds: { type: 'array', items: S.str },
      },
      required: ['label', 'instruction', 'segmentIds'],
      propertyOrdering: ['label', 'instruction', 'segmentIds'],
    },
    explanation: S.str,
  },
  required: ['understanding', 'ops', 'explanation'],
  propertyOrdering: ['understanding', 'unsupportedReason', 'music', 'visualEdit', 'generate', 'ops', 'explanation'],
};

const REVISE_SYSTEM = `You revise an existing Reel cut with the smallest set of operations that does what the user asked.
Operations act on the CURRENT segments by id, applied in order. Every op object lists all fields; set the ones the op uses and null the rest:
- move {id, toIndex}: put that segment at 0-based position toIndex in the playback order.
- trim {id, inMs and/or outMs}: new source bounds for that segment.
- set_audio {id, audio}: audio "mute" silences that segment, "keep" restores its sound.
- remove {id}
- insert {clipId, inMs, outMs, audio, atIndex}: a new range from the footage at a 0-based position.
Leave every segment the request does not concern exactly as it is. The user's request wins over the technique.
If the user asks for music, a soundtrack or a beat, set music (it can be combined with any other change in the same message):
- action "add"; label: a short phrase ("animatronic funk"); prompt: an instrumental description for a music generator (genre, mood, tempo, instruments) that fits this footage. Never name artists, songs or bands; no vocals.
- mode "under" keeps the original sound with the music low beneath it (default, always when someone speaks); "replace" only when they ask for music instead of the original sound.
If they ask to remove or turn off the music: action "remove" (label/prompt may be empty strings, mode "under").
Music is not an unsupported feature here.
If the user asks to change how something INSIDE their footage looks (recolor clothing or an object, change the sky or weather, put an object or animal into the scene itself, restyle the look), return no ops and set visualEdit:
- label: a short noun phrase for the change ("purple dress").
- instruction: one instruction for a video-editing model that describes ONLY that change and says to keep everything else identical (people, faces, motion, framing, lighting).
- segmentIds: the current segment ids where the subject is visible (all of them if the change applies throughout).
Use visualEdit, not generate, when the request is about something already in the footage or says "in"/"into" the shot.
If the user asks to add or show something that is NOT in the footage but could be a short standalone shot (an animal, an object, food, a place, weather, a view), return no ops and set generate:
- label: a short noun phrase ("a dog").
- prompt: a vivid one-shot description for a video generator that matches this footage's setting, lighting and handheld-phone look; vertical 9:16; no people, no faces, no text or logos.
- seconds: 4 unless they ask for longer; atIndex: 0-based position in the CURRENT order (current length = at the end); audio: "keep".
On-screen text and stickers are supported (overlays); the brief lists the current ones. If the user asks to add, change, move, restyle or remove on-screen text (a title, a name, a label, a line of words) or a sticker/emoji, set overlays to the COMPLETE new list: keep every overlay they didn't mention exactly as it is, with its id. Otherwise overlays = null. Overlays combine with any other change in the same message.
- kind "text": text = exactly the words they asked for, their spelling and capitalization, no emoji (an emoji goes in its own sticker). kind "sticker": emoji = ONE emoji that best matches ("a heart sticker" → ❤️, "fire" → 🔥, "dog sticker" → 🐶); text null.
- segmentId: the shot it appears on, or null for the whole reel (the default for a title or name with no time given; "at the start"/"at the end" = the first/last shot).
- x, y: its centre as fractions of the frame (0,0 top-left, 1,1 bottom-right). A title defaults to 0.5, 0.16; a caption line to 0.5, 0.78; a sticker to wherever they say (corners about 0.2/0.8). If they pointed at a spot, use those exact fractions. Keep y ≤ 0.85 (app buttons cover the bottom).
- size small|medium|large (titles large, labels medium, stickers medium). style (text only, null for stickers): "clean" white with a shadow (default), "box" dark on a white box, "dark" white on a dark box, "yellow" dark on yellow.
- animation (how it enters): "fade" (text default), "pop" (sticker default), "slide_up", "slide_left", or "none".
Transitions between shots are supported; the brief lists the current ones (each is the transition INTO that shot from the one before). If the user asks for transitions or smoother cuts, set transitions to the COMPLETE new list; "hard cuts"/"remove the transitions" = an empty list; otherwise null. Types: crossfade, dissolve, dip_to_black, dip_to_white, slide_left, slide_right, slide_up, slide_down, wipe, zoom, circle, whip. "Add transitions" with nothing specific = crossfade into every shot after the first. ms 250-600 (default 350; shorter for punchy, longer for soft). The first shot can't have one.
If the request needs something that does not exist here (auto-captions or subtitles of the speech, speed changes, color filters) or involves generating real or specific people, return no ops and set unsupportedReason to one short plain sentence saying what can't be done and why.
explanation = ONE plain sentence describing the change.
${RULES}`;

export interface GenerateRequest { label: string; prompt: string; seconds: 4 | 6 | 8; atIndex: number; audio: 'keep' | 'mute' }
export interface VisualEditRequest { label: string; instruction: string; segmentIds: string[] }
export interface MusicRequest { action: 'add' | 'remove'; label: string; prompt: string; mode: 'under' | 'replace' }

export interface ReviseResult {
  segments: Segment[] | null;
  unsupportedReason: string | null;
  generate: GenerateRequest | null;
  visualEdit?: VisualEditRequest | null;
  music?: MusicRequest | null;
  // Overlays and transitions: null/undefined = unchanged.
  overlays?: Overlay[] | null;
  transitions?: Transition[] | null;
  explanation: string;
  ops: Op[];
  model: string;
  attempts: number;
  ms: number;
}

export async function revise(input: {
  clips: ClipForModel[];
  analysis: Analysis | null;
  segments: Segment[];
  techniqueTitle: string;
  direction: string;
  overlays?: Overlay[];
  transitions?: Transition[];
}): Promise<ReviseResult> {
  const clipsInfo = clipInfosOf(input.clips);
  const brief = `What the footage contains (from the first watch): ${JSON.stringify({ transcript: input.analysis?.transcript ?? [], moments: input.analysis?.moments ?? [] })}
Current cut (${totalMs(input.segments)} ms, technique "${input.techniqueTitle}"), in playback order:
${JSON.stringify(input.segments)}
Current overlays (text and stickers): ${JSON.stringify(input.overlays ?? [])}
Current transitions: ${JSON.stringify(input.transitions ?? [])}
The user now says: "${input.direction}"`;

  let retryNote = '';
  let totalModelMs = 0;
  let lastErrors: string[] = [];
  for (let attempts = 1; attempts <= 2; attempts++) {
    const contents = [{ role: 'user', parts: [...videoParts(input.clips, Math.min(2, config.gemini.fps)), { text: brief + retryNote }] }];
    const { data, model, ms } = await generateJson<any>(videoModels(), contents, { systemInstruction: REVISE_SYSTEM, responseSchema: reviseSchema }, 60_000, 'revise');
    totalModelMs += ms;
    const unsupported = typeof data?.unsupportedReason === 'string' && data.unsupportedReason.trim() ? data.unsupportedReason.trim() : null;
    // Nulls mean "not used by this op".
    const ops: Op[] = (Array.isArray(data?.ops) ? data.ops : []).map((o: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== null && v !== undefined)) as unknown as Op);
    const m = data?.music;
    const music: MusicRequest | null = m && (m.action === 'remove' || (m.action === 'add' && typeof m.prompt === 'string' && m.prompt.trim()))
      ? { action: m.action, label: String(m.label || 'music').trim().slice(0, 60), prompt: String(m.prompt ?? '').trim().slice(0, 600), mode: m.mode === 'replace' ? 'replace' : 'under' }
      : null;
    const ve = data?.visualEdit;
    const hasVisual = Boolean(ve && typeof ve.instruction === 'string' && ve.instruction.trim());
    const hasGenerate = Boolean(data?.generate && typeof data.generate.prompt === 'string' && data.generate.prompt.trim());
    // Overlays and transitions sit on the shots they'll end up with (after ops, if any).
    const target = ops.length ? applyOps(input.segments, ops).segments : input.segments;
    const ov = Array.isArray(data?.overlays) ? normalizeOverlays(data.overlays, target) : null;
    const tr = Array.isArray(data?.transitions) ? normalizeTransitions(data.transitions, target) : null;
    const look = { overlays: ov?.overlays ?? null, transitions: tr?.transitions ?? null };
    const lookErrors = [...(ov?.errors ?? []), ...(tr?.errors ?? [])];
    // Music, text, stickers or transitions alone: the shots stay exactly as they are.
    if ((music || ov || tr) && !ops.length && !hasVisual && !hasGenerate && !lookErrors.length) {
      return { segments: input.segments, unsupportedReason: null, generate: null, music, ...look, explanation: String(data.explanation ?? '').trim(), ops, model, attempts, ms: totalModelMs };
    }
    if (!ops.length && hasVisual) {
      const known = new Set(input.segments.map((s) => s.id));
      const ids = (Array.isArray(ve.segmentIds) ? ve.segmentIds : []).map(String).filter((id: string) => known.has(id));
      const visualEdit: VisualEditRequest = {
        label: String(ve.label || 'the change').trim().slice(0, 60),
        instruction: ve.instruction.trim().slice(0, 900),
        segmentIds: ids.length ? [...new Set<string>(ids)] : input.segments.map((s) => s.id),
      };
      return { segments: null, unsupportedReason: null, generate: null, visualEdit, music, ...look, explanation: String(data.explanation ?? '').trim(), ops, model, attempts, ms: totalModelMs };
    }
    const gen = data?.generate;
    if (!ops.length && gen && typeof gen.prompt === 'string' && gen.prompt.trim()) {
      const generate: GenerateRequest = {
        label: String(gen.label || 'that shot').trim().slice(0, 60),
        prompt: gen.prompt.trim().slice(0, 900),
        seconds: [4, 6, 8].includes(Number(gen.seconds)) ? Number(gen.seconds) as 4 | 6 | 8 : 4,
        atIndex: Number.isFinite(Number(gen.atIndex)) ? Math.round(Number(gen.atIndex)) : input.segments.length,
        audio: gen.audio === 'mute' ? 'mute' : 'keep',
      };
      return { segments: null, unsupportedReason: null, generate, music, ...look, explanation: String(data.explanation ?? '').trim(), ops, model, attempts, ms: totalModelMs };
    }
    if (unsupported && !ops.length && !lookErrors.length) {
      return { segments: null, unsupportedReason: unsupported, generate: null, explanation: String(data.explanation ?? ''), ops, model, attempts, ms: totalModelMs };
    }
    const applied = applyOps(input.segments, ops);
    const errors = [...applied.errors, ...validateSegments(applied.segments, clipsInfo), ...lookErrors];
    if (!ops.length && !lookErrors.length) errors.push('no operations returned; either return ops, set generate, overlays or transitions, or set unsupportedReason');
    if (!errors.length) {
      return { segments: applied.segments, unsupportedReason: null, generate: null, music, ...look, explanation: String(data.explanation ?? '').trim(), ops, model, attempts, ms: totalModelMs };
    }
    lastErrors = errors;
    log('gemini', { what: 'revise', attempt: attempts, invalid: errors.join('; ').slice(0, 400) }, 'warn');
    retryNote = `\n\nYour previous operations were rejected by the validator. Fix exactly these problems:\n- ${errors.join('\n- ')}`;
  }
  throw new EditValidationError(lastErrors);
}

// ---------------------------------------------------------------------------------------------
// Text routing (no media): what does this message want?
// ---------------------------------------------------------------------------------------------

export type Intent = 'revise' | 'why' | 'keep' | 'new_reel' | 'stop' | 'start' | 'other' | 'chatter';

export async function routeText(input: { text: string; state: string; hasCut: boolean; isGroup?: boolean }): Promise<Intent> {
  const schema = {
    type: 'object',
    properties: { intent: { type: 'string', enum: ['revise', 'why', 'keep', 'new_reel', 'stop', 'start', 'other', 'chatter'] } },
    required: ['intent'],
  };
  const system = `Classify one text message sent to Sticky, a video-editing assistant that turns footage into a Reel.
revise = any request to change the cut (order, length, what to open or end with, muting, emphasis, removing or adding a moment, music, a visual change, or something the editor may not support like captions).
why = asking why the cut was made this way / what technique or source it used.
keep = approving/saving the current version ("keep", "love it, save this", "perfect").
new_reel = wanting to start over with a new, separate reel.
stop = wanting no more messages (stop, unsubscribe, quit).
start = opting back in after stopping.
other = greetings, thanks, unrelated chat addressed to Sticky.
chatter = (group chats only) people talking to each other, not to Sticky.${input.isGroup ? `
THIS IS A GROUP CHAT with several people and Sticky. Most messages are people talking to each other: classify those as chatter.
Only use revise/why/keep/new_reel when the message is clearly meant for the editor: it names Sticky, or it is an instruction about the reel that was just sent ("make it shorter", "open on the dog", "add music"), or asks why the reel was cut that way. Reactions and opinions about the reel ("lol love it", "this is so good") are chatter unless they ask for a change or say to keep it.` : ''}`;
  try {
    const { data } = await generateJson<{ intent: Intent }>(
      [config.gemini.textModel, config.gemini.fallbackModel],
      [{ role: 'user', parts: [{ text: `Project state: ${input.state}. A cut has been delivered: ${input.hasCut ? 'yes' : 'no'}.\nMessage: "${input.text}"` }] }],
      { systemInstruction: system, responseSchema: schema },
      10_000,
      'route_text',
    );
    return data.intent;
  } catch {
    if (input.isGroup) return /\bsticky\b/i.test(input.text) ? 'revise' : 'chatter';
    return input.hasCut ? 'revise' : 'other';
  }
}

/** Words of a voice memo (mono MP3), verbatim, for use as a typed edit. */
export async function transcribeAudio(mp3: Buffer): Promise<string> {
  const schema = { type: 'object', properties: { transcript: S.str }, required: ['transcript'] };
  const { data } = await generateJson<{ transcript: string }>(
    [config.gemini.textModel, config.gemini.fallbackModel],
    [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/mp3', data: mp3.toString('base64') } }, { text: 'Transcribe this voice memo verbatim. Return an empty string if nothing is said.' }] }],
    { systemInstruction: 'You transcribe short voice memos exactly, with normal punctuation. No commentary.', responseSchema: schema },
    30_000,
    'transcribe',
  );
  return String(data.transcript ?? '');
}

// ---------------------------------------------------------------------------------------------
// Trend extraction (text only): turn dated entries into compact, renderable techniques
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Opening pattern of measured outliers (caption + thumbnail; the thumbnail often shows the hook text)
// ---------------------------------------------------------------------------------------------

export const HOOKS = ['question', 'bold_claim', 'reveal', 'transformation', 'list_or_number', 'pov', 'how_to', 'confession', 'reaction', 'other'] as const;

export async function classifyHooks(items: Array<{ id: string; platform: string; caption: string; thumbnail: Buffer | null }>): Promise<Array<{ id: string; hook: string; opening: string }>> {
  if (!items.length) return [];
  const parts: unknown[] = [];
  for (const it of items) {
    parts.push({ text: `Post ${it.id} (${it.platform}). Caption: "${it.caption || '(none)'}"` });
    if (it.thumbnail) parts.push({ inlineData: { mimeType: 'image/jpeg', data: it.thumbnail.toString('base64') } });
  }
  parts.push({ text: 'For each post, label how it OPENS (its hook) and describe the opening in one short line, from the caption and the thumbnail (which often shows the on-screen hook).' });
  const schema = {
    type: 'object',
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: S.str, hook: { type: 'string', enum: [...HOOKS] }, opening: S.str },
          required: ['id', 'hook', 'opening'],
        },
      },
    },
    required: ['posts'],
  };
  const { data } = await generateJson<{ posts: Array<{ id: string; hook: string; opening: string }> }>(
    [config.gemini.fallbackModel, config.gemini.textModel],
    [{ role: 'user', parts }],
    { systemInstruction: 'You label short-form video hooks. Use "other" when the opening cannot be told. Describe, never judge.', responseSchema: schema },
    60_000,
    'classify_hooks',
  );
  return Array.isArray(data.posts) ? data.posts : [];
}

export interface RawEntry { entryId: string; title: string; body: string }
export interface ExtractedEntry {
  entryId: string;
  summary: string;
  requires: string[];
  ops: { opening: string; order: string; pacing: string; audio: string; ending: string };
  renderable: boolean;
  whyNotRenderable: string | null;
  generic: boolean;
}

export async function extractTechniques(sourceName: string, entries: RawEntry[]): Promise<ExtractedEntry[]> {
  if (!entries.length) return [];
  const schema = {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            entryId: S.str,
            summary: S.str,
            requires: { type: 'array', items: S.str },
            ops: {
              type: 'object',
              properties: { opening: S.str, order: S.str, pacing: S.str, audio: S.str, ending: S.str },
              required: ['opening', 'order', 'pacing', 'audio', 'ending'],
            },
            renderable: S.bool,
            whyNotRenderable: { type: 'string', nullable: true },
            generic: S.bool,
          },
          required: ['entryId', 'summary', 'requires', 'ops', 'renderable', 'generic'],
        },
      },
    },
    required: ['entries'],
  };
  const system = `You turn published Instagram Reels trend write-ups into compact edit recipes for an editor that can ONLY reorder, trim and mute ranges of the user's own footage with hard cuts.
For each entry:
- summary: one sentence in your own words (never copy the source's sentences).
- requires: what the user's raw footage must visibly or audibly contain for this to work.
- ops: the edit it implies for opening, shot order, pacing, audio, ending.
- renderable=false when the format depends on on-screen text, captions, labels, stickers, graphics, AI-generated scenes, a specific licensed song, green screen, keyframed effects, or footage the user would have to film specially in a way an editor can't recreate; say why in whyNotRenderable.
- generic=true for broad advice that is not a specific format.
Never invent dates, counts, or performance claims.`;
  const { data } = await generateJson<{ entries: ExtractedEntry[] }>(
    [config.gemini.fallbackModel, config.gemini.textModel],
    [{ role: 'user', parts: [{ text: `Source: ${sourceName}\nEntries:\n${JSON.stringify(entries)}` }] }],
    { systemInstruction: system, responseSchema: schema },
    90_000,
    'extract_trends',
  );
  return Array.isArray(data.entries) ? data.entries : [];
}
