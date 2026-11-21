/**
 * Generated inserts (Veo on Vertex, temp project). Used only when a revision asks for something the
 * footage does not contain ("add a dog at the end"). The clip is short, vertical, and always labeled
 * AI-generated wherever it is shown or explained.
 */
import { GoogleGenAI } from '@google/genai';
import { config } from './config.js';
import { log } from './log.js';

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  // Veo runs on a regional endpoint, not "global".
  return client ??= new GoogleGenAI({ vertexai: true, project: config.gemini.project, location: process.env.STICKY_VEO_LOCATION || 'us-central1' });
}

export const VEO_MODEL = process.env.STICKY_VEO_MODEL_ID || 'veo-3.1-fast-generate-001';

/** A 4/6/8-second 9:16 clip for `prompt`; resolves to the MP4 bytes. */
export async function generateClip(prompt: string, seconds: 4 | 6 | 8 = 4, timeoutMs = 150_000): Promise<{ bytes: Buffer; ms: number; model: string }> {
  const t0 = Date.now();
  let op = await ai().models.generateVideos({
    model: VEO_MODEL,
    source: { prompt },
    config: {
      numberOfVideos: 1,
      aspectRatio: '9:16',
      durationSeconds: seconds,
      resolution: '720p',
      generateAudio: true,
      personGeneration: 'dont_allow',
      negativePrompt: 'text, captions, watermark, logos, people',
    },
  });
  while (!op.done) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`Veo timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 4000));
    op = await ai().operations.getVideosOperation({ operation: op });
  }
  if (op.error) throw new Error(`Veo failed: ${JSON.stringify(op.error).slice(0, 300)}`);
  const video = op.response?.generatedVideos?.[0]?.video;
  const filtered = (op.response as any)?.raiMediaFilteredReasons;
  if (!video) throw new Error(`Veo returned no video${filtered ? ` (filtered: ${JSON.stringify(filtered)})` : ''}`);
  let bytes: Buffer;
  if (video.videoBytes) bytes = Buffer.from(video.videoBytes, 'base64');
  else if (video.uri) {
    const res = await fetch(video.uri);
    if (!res.ok) throw new Error(`Veo video fetch HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  } else throw new Error('Veo video had neither bytes nor uri');
  const ms = Date.now() - t0;
  log('veo', { model: VEO_MODEL, seconds, ms, bytes: bytes.length, prompt: prompt.slice(0, 120) });
  return { bytes, ms, model: VEO_MODEL };
}
