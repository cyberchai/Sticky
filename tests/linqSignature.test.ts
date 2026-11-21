import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { verifyLinqSignature } from '../src/linq.js';

const secret = `whsec_${Buffer.from('sticky-test-key-bytes').toString('base64')}`;
const sign = (id: string, ts: string, body: string) =>
  `v1,${crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64')}`;

test('accepts a valid Standard Webhooks signature, including during rotation (two entries)', () => {
  const body = '{"event_type":"message.received"}';
  const ts = String(Math.floor(Date.now() / 1000));
  const headers = { 'webhook-id': 'wh_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,AAAA ${sign('wh_1', ts, body)}` };
  assert.equal(verifyLinqSignature(body, headers, secret), true);
});

test('rejects a changed body, a stale timestamp, a missing header, or no secret', () => {
  const body = '{"a":1}';
  const ts = String(Math.floor(Date.now() / 1000));
  const good = { 'webhook-id': 'wh_1', 'webhook-timestamp': ts, 'webhook-signature': sign('wh_1', ts, body) };
  assert.equal(verifyLinqSignature('{"a":2}', good, secret), false);
  const old = String(Math.floor(Date.now() / 1000) - 600);
  assert.equal(verifyLinqSignature(body, { ...good, 'webhook-timestamp': old, 'webhook-signature': sign('wh_1', old, body) }, secret), false);
  assert.equal(verifyLinqSignature(body, { 'webhook-id': 'wh_1', 'webhook-timestamp': ts }, secret), false);
  assert.equal(verifyLinqSignature(body, good, ''), false);
});
