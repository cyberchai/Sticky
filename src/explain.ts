/**
 * "Why this cut?": built only from what was stored with the version (the actual segments, the
 * moments Gemini found in this footage, the technique and its dated source). Nothing new is claimed.
 */
import { fmtMs, type Segment } from './edl.js';
import type { Analysis, Moment } from './gemini.js';
import { describeOverlays, type Overlay } from './overlays.js';
import type { Transition } from './transitions.js';
import { outlierLine } from './trends/outliers.js';
import { evidenceLabel } from './trends/select.js';
import type { Candidate } from './trends/types.js';

function overlap(seg: Segment, m: Moment): number {
  if (m.clipId !== seg.clipId) return 0;
  return Math.max(0, Math.min(seg.outMs, m.endMs) - Math.max(seg.inMs, m.startMs));
}

function describe(seg: Segment, analysis: Analysis | null): string {
  const best = (analysis?.moments ?? [])
    .filter((m) => m.role !== 'dead')
    .map((m) => ({ m, o: overlap(seg, m) }))
    .sort((a, b) => b.o - a.o)[0];
  const where = `${seg.clipId} at ${fmtMs(seg.inMs)}`;
  return best && best.o > 0 ? `${best.m.what.replace(/\.$/, '')} (${where})` : `the shot from ${where}`;
}

export function whyThisCut(input: {
  segments: Segment[];
  technique: Candidate;
  analysis: Analysis | null;
  explanation: string;
  direction: string | null;
  versionNo: number;
  music?: { label: string; mode: 'under' | 'replace' } | null;
  overlays?: Overlay[] | null;
  transitions?: Transition[] | null;
}): string {
  const { segments, technique, analysis } = input;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const middle = segments.slice(1, -1);
  const lines: string[] = [];
  lines.push(`Opening: ${describe(first, analysis)}.`);
  if (middle.length) lines.push(`Then: ${middle.map((s) => describe(s, analysis)).join('; ')}.`);
  if (segments.length > 1) lines.push(`Ending: ${describe(last, analysis)}.`);
  const muted = segments.filter((s) => s.audio === 'mute').map((s) => s.id);
  if (muted.length) lines.push(`Sound is muted on ${muted.length} shot${muted.length > 1 ? 's' : ''}.`);
  if (input.direction) lines.push(`v${input.versionNo} follows your note: “${input.direction}”.`);
  if (input.overlays?.length) lines.push(`On screen: ${describeOverlays(input.overlays)}.`);
  if (input.transitions?.length) lines.push(`Transitions: ${input.transitions.map((t) => `${t.type.replace(/_/g, ' ')} into ${t.segmentId}`).join(', ')}.`);
  if (input.music) lines.push(`Music: AI-generated with Lyria (${input.music.label}), ${input.music.mode === 'replace' ? 'replacing the original sound' : 'under your original audio'}.`);
  if (technique.hookEvidence) {
    const he = technique.hookEvidence;
    lines.push(`Opening pattern (${he.sharedPattern}) borrowed from a measured outlier: ${outlierLine(he)} ${he.postLink}. Their numbers aren't a prediction for your reel.`);
  }
  if (technique.kind === 'dated') {
    lines.push(`Format: “${technique.title}” (${evidenceLabel(technique)}) ${technique.url}. That's an editorial observation, not a ranking.`);
  } else {
    lines.push(`No fresh trend fit this footage, so I used an evergreen technique: ${technique.title.toLowerCase()} (${technique.sourceName}).`);
  }
  return lines.join('\n');
}
