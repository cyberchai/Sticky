/**
 * Minute 10–20 model check on a real iPhone clip (AirDrop it to the Mac first):
 *   npm run probe:gemini -- ~/Downloads/IMG_1234.MOV
 * Normalizes like the live path, sends the proxy with videoMetadata.fps, asks for timestamped events,
 * and prints which model answered, latency, and whether the clip was HDR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { config } from '../src/config.js';
import { errMsg } from '../src/log.js';
import { normalize, probe, proxy } from '../src/media.js';

const input = process.argv[2];
if (!input) { console.error('usage: npm run probe:gemini -- <video file>'); process.exit(1); }
const dir = path.join(config.workDir, 'probe');
fs.mkdirSync(dir, { recursive: true });
const info = await probe(input);
console.log(`source: ${info.width}x${info.height} rot=${info.rotation} ${info.videoCodec}/${info.audioCodec} ${info.durationMs}ms transfer=${info.colorTransfer} (${info.colorTransfer === 'arib-std-b67' || info.colorTransfer === 'smpte2084' ? 'HDR' : 'SDR'})`);
let t = Date.now();
await normalize(input, path.join(dir, 'norm.mp4'), info, 60_000);
console.log(`normalize ${Date.now() - t}ms`);
t = Date.now();
await proxy(path.join(dir, 'norm.mp4'), path.join(dir, 'proxy.mp4'));
const bytes = fs.readFileSync(path.join(dir, 'proxy.mp4'));
console.log(`proxy ${Date.now() - t}ms ${bytes.length}B`);

const ai = config.gemini.apiKey
  ? new GoogleGenAI({ apiKey: config.gemini.apiKey })
  : new GoogleGenAI({ vertexai: true, project: config.gemini.project, location: config.gemini.location });
for (const model of [config.gemini.videoModel, config.gemini.fallbackModel].filter(Boolean)) {
  t = Date.now();
  try {
    const res = await ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: 'video/mp4', data: bytes.toString('base64') }, videoMetadata: { fps: config.gemini.fps } } as any,
        { text: 'List the 3-6 most important visual or audio events in this clip with the exact millisecond they start, and transcribe any speech with start/end ms.' },
      ] }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            events: { type: 'array', items: { type: 'object', properties: { atMs: { type: 'integer' }, what: { type: 'string' } }, required: ['atMs', 'what'] } },
            speech: { type: 'array', items: { type: 'object', properties: { startMs: { type: 'integer' }, endMs: { type: 'integer' }, text: { type: 'string' } }, required: ['startMs', 'endMs', 'text'] } },
          },
          required: ['events', 'speech'],
        },
      } as any,
    });
    console.log(`\n${model}: ${Date.now() - t}ms`);
    console.log(res.text);
  } catch (err) {
    console.log(`\n${model}: FAILED after ${Date.now() - t}ms: ${errMsg(err)}`);
  }
}
