/**
 * Visual edits INSIDE the user's own footage ("make her dress purple") with Gemini Omni on Vertex
 * (Interactions API, task "edit"). The input and output have the same duration (3–15 s). The result is
 * always stored and labeled as AI-edited; the user's original stays untouched.
 */
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';
import { log } from './log.js';

export const OMNI_MODEL = process.env.STICKY_OMNI_MODEL_ID || 'gemini-omni-1.2-flash';
export const OMNI_MIN_MS = 3_000;
export const OMNI_MAX_MS = 15_000;

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

/** Edit the video at `gcsUri` per `instruction`; resolves to the edited MP4 bytes. */
export async function editVideo(gcsUri: string, instruction: string, timeoutMs = 240_000): Promise<{ bytes: Buffer; ms: number }> {
  const t0 = Date.now();
  const token = await auth.getAccessToken();
  const res = await fetch(`https://aiplatform.googleapis.com/v1beta1/projects/${config.gemini.project}/locations/global/interactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OMNI_MODEL,
      store: false,
      input: [
        { type: 'text', text: instruction },
        { type: 'video', uri: gcsUri, mime_type: 'video/mp4' },
      ],
      response_format: [{ type: 'video', delivery: 'inline', resolution: '720p' }],
      generation_config: { video_config: { task: 'edit' } },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok || body.error) throw new Error(`Omni edit failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  for (const step of body.steps ?? []) {
    for (const c of step.content ?? []) {
      if (c?.type === 'video' && c.data) {
        const bytes = Buffer.from(c.data, 'base64');
        const ms = Date.now() - t0;
        log('omni', { model: OMNI_MODEL, ms, bytes: bytes.length, instruction: instruction.slice(0, 120) });
        return { bytes, ms };
      }
    }
  }
  throw new Error(`Omni returned no video (status ${body.status ?? '?'})`);
}
