/**
 * Minute 3–10 transport check, no deploy needed:
 *   npm run linq:check                      # status of our numbers (number + status only)
 *   npm run linq:check -- --to +1XXXXXXXXXX # also send a known-good 720×1280 MP4 from STICKY_LINE
 * Pass = the clip plays inline on the phone and the response says service iMessage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/config.js';
import { linqCall, openChat, uploadAttachment } from '../src/linq.js';
import { probe, testPattern } from '../src/media.js';

const to = process.argv[process.argv.indexOf('--to') + 1];
const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : config.line;

const numbers = await linqCall('GET', '/phone_numbers');
const list: any[] = (numbers.body?.data ?? numbers.body?.phone_numbers ?? numbers.body ?? []) as any[];
console.log(`GET /phone_numbers → HTTP ${numbers.status}`);
if (Array.isArray(list)) {
  for (const n of list) console.log(`  ${n.phone_number ?? n.number ?? n.handle}  status=${n.status ?? '?'} reputation=${JSON.stringify(n.reputation ?? n.reputation_status ?? '?')}`);
}

if (process.argv.includes('--to') && to) {
  const file = path.join(config.workDir, 'linq-check.mp4');
  fs.mkdirSync(config.workDir, { recursive: true });
  await testPattern(file, 5);
  const info = await probe(file);
  console.log(`test MP4: ${info.width}x${info.height} ${info.videoCodec}/${info.audioCodec} ${info.durationMs}ms ${info.sizeBytes}B`);
  const t0 = Date.now();
  const att = await uploadAttachment({ filename: 'sticky-check.mp4', contentType: 'video/mp4', sizeBytes: fs.statSync(file).size, body: fs.readFileSync(file) });
  console.log(`uploaded attachment ${att} in ${Date.now() - t0}ms`);
  const sent = await openChat(from, to, [{ type: 'text', value: 'Sticky transport check: this clip should play inline.' }, { type: 'media', attachment_id: att }]);
  console.log(`sent from ${from}: HTTP ${sent.status} chat=${sent.chatId} message=${sent.providerMessageId} service=${sent.service ?? '?'} in ${Date.now() - t0}ms`);
}
