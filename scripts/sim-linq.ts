/**
 * Send a Linq-signed webhook to Sticky, exactly as Linq would (Standard Webhooks signature with
 * STICKY_LINQ_WEBHOOK_SECRET). For routing tests without phones, including group chats.
 *   npx tsx scripts/sim-linq.ts --chat <id> [--group] [--from +1…] --text "…"
 * Replies go to Linq for that chat id; a made-up chat id just fails the send (logged), routing still runs.
 */
import crypto from 'node:crypto';
import { config } from '../src/config.js';

const arg = (name: string, d = '') => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const base = arg('base', 'https://sticky-editor-1097661752215.us-central1.run.app');
const chat = arg('chat', `sim-group-${crypto.randomBytes(4).toString('hex')}`);
const id = `wh_sim_${crypto.randomBytes(6).toString('hex')}`;
const payload = {
  event_type: 'message.received',
  data: {
    id: `msg_${id}`,
    direction: 'inbound',
    chat: { id: chat, is_group: process.argv.includes('--group'), owner_handle: { handle: config.line } },
    sender_handle: { handle: arg('from', '+15555550123'), is_me: false },
    parts: [{ type: 'text', value: arg('text', 'hi') }],
    service: 'iMessage',
  },
};
const body = JSON.stringify(payload);
const ts = String(Math.floor(Date.now() / 1000));
const key = Buffer.from(config.linqWebhookSecret.replace(/^whsec_/, ''), 'base64');
const sig = crypto.createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
const res = await fetch(`${base}/webhooks/linq`, { method: 'POST', body, headers: { 'Content-Type': 'application/json', 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` } });
console.log(`${chat} "${arg('text')}" → HTTP ${res.status}`);
