/**
 * AI-generated music beds (Lyria on Vertex, temp project). Instrumental only, made on request
 * ("add animatronic music"), always labeled AI-generated, mixed under the user's original audio.
 */
import { GoogleAuth } from 'google-auth-library';
import { config } from './config.js';
import { log } from './log.js';

export const LYRIA_MODEL = process.env.STICKY_LYRIA_MODEL_ID || 'lyria-002';
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });

/** ~30 s of 48 kHz stereo WAV for `prompt`. */
export async function generateMusic(prompt: string, timeoutMs = 120_000): Promise<{ bytes: Buffer; ms: number }> {
  const t0 = Date.now();
  const token = await auth.getAccessToken();
  const res = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/projects/${config.gemini.project}/locations/us-central1/publishers/google/models/${LYRIA_MODEL}:predict`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instances: [{ prompt, negative_prompt: 'vocals, singing, lyrics, speech' }], parameters: { sample_count: 1 } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok || body.error) throw new Error(`Lyria failed: HTTP ${res.status} ${JSON.stringify(body.error ?? body).slice(0, 300)}`);
  const p = body.predictions?.[0] ?? {};
  const b64 = p.bytesBase64Encoded ?? p.audioContent;
  if (!b64) throw new Error('Lyria returned no audio');
  const bytes = Buffer.from(b64, 'base64');
  const ms = Date.now() - t0;
  log('lyria', { model: LYRIA_MODEL, ms, bytes: bytes.length, prompt: prompt.slice(0, 120) });
  return { bytes, ms };
}
