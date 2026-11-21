/**
 * Voice memos as edits: download the memo from Linq's CDN (pinned host), convert whatever iMessage sent
 * (CAF/AMR/M4A…) to small mono MP3, and have Gemini transcribe it. The words are then handled exactly
 * like a typed message.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { transcribeAudio } from './gemini.js';
import { isLinqMediaUrl } from './linq.js';

const MAX_BYTES = 25 * 1024 * 1024;

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, 60_000);
    child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().split('\n').pop()}`)); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function transcribeVoice(url: string): Promise<string> {
  if (!isLinqMediaUrl(url)) throw new Error('not a Linq media URL');
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`voice download HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) throw new Error('voice memo too large');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticky-voice-'));
  const input = path.join(dir, `in-${crypto.randomUUID().slice(0, 8)}`);
  const output = path.join(dir, 'voice.mp3');
  try {
    fs.writeFileSync(input, bytes);
    await ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', output]);
    return (await transcribeAudio(fs.readFileSync(output))).trim();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
