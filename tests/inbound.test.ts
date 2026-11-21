import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseLinq } from '../src/inbound.js';

const msg = (chat: Record<string, unknown>, parts: unknown[], sender = '+13475550100') => ({
  event_type: 'message.received',
  data: { id: 'm1', direction: 'inbound', chat: { id: 'chat-1', owner_handle: { handle: '+12055030508' }, ...chat }, sender_handle: { handle: sender, is_me: false }, parts },
});

test('group messages keep the group flag and the sender', () => {
  const p = parseLinq(msg({ is_group: true }, [{ type: 'text', value: 'sticky make it shorter' }]));
  assert.equal(p.isGroup, true);
  assert.equal(p.from, '+13475550100');
  assert.equal(p.chatId, 'chat-1');
  assert.equal(p.text, 'sticky make it shorter');
});

test('a voice memo is an audio part, not "other media", and not a video', () => {
  const p = parseLinq(msg({ is_group: false }, [{ type: 'media', id: 'a1', mime_type: 'audio/x-caf', url: 'https://cdn.linqapp.com/v.caf', filename: 'Audio Message.caf' }]));
  assert.deepEqual(p.audio, { partId: 'a1', url: 'https://cdn.linqapp.com/v.caf', mime: 'audio/x-caf' });
  assert.equal(p.otherMedia, 0);
  assert.equal(p.videos.length, 0);
  assert.equal(p.text, '');
});

test('video plus caption in a group is still footage with direction', () => {
  const p = parseLinq(msg({ is_group: true }, [
    { type: 'media', id: 'v1', mime_type: 'video/quicktime', url: 'https://cdn.linqapp.com/a.mov', filename: 'IMG_1.MOV' },
    { type: 'text', value: 'open on the jump' },
  ]));
  assert.equal(p.videos.length, 1);
  assert.equal(p.videos[0].name, 'IMG_1.MOV');
  assert.equal(p.text, 'open on the jump');
  assert.equal(p.audio, null);
});

test('our own outbound messages are marked fromMe (never answered)', () => {
  const p = parseLinq({ event_type: 'message.received', data: { id: 'x', direction: 'outbound', chat: { id: 'c' }, parts: [{ type: 'text', value: 'hi' }] } });
  assert.equal(p.fromMe, true);
});
