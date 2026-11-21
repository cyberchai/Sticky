/**
 * Local simulation of what the core-api bridge forwards (HMAC mode), for testing without a phone.
 *   npx tsx scripts/sim-event.ts video <chatId> <eventId> <mediaUrl> [caption]
 *   npx tsx scripts/sim-event.ts text  <chatId> <eventId> "<text>"
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';

const [kind, chatId, eventId, a, b] = process.argv.slice(2);
const base = process.env.STICKY_BASE ?? `http://localhost:${config.port}`;
const parts: any[] = [];
if (kind === 'video') {
  parts.push({ type: 'media', id: `${eventId}-p1`, mime_type: 'video/quicktime', url: a, size_bytes: 1 });
  if (b) parts.push({ type: 'text', value: b });
} else {
  parts.push({ type: 'text', value: a });
}
const payload = {
  event_type: 'message.received',
  data: {
    id: `msg-${eventId}`,
    direction: 'inbound',
    chat: { id: chatId, is_group: false, owner_handle: { handle: config.line } },
    sender_handle: { handle: '+15555550100', is_me: false },
    parts,
    service: 'iMessage',
  },
};
const body = JSON.stringify(payload);
const sig = crypto.createHmac('sha256', config.forwardSecret).update(body).digest('hex');
const res = await fetch(`${base}/forward/linq`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'x-sticky-signature': sig, 'x-linq-webhook-id': eventId } });
console.log(`${kind} ${eventId} → HTTP ${res.status}`);
