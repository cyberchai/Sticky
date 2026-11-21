/**
 * Where a reply goes. iMessage threads are Linq chats; browser threads are "web:<id>" and read their
 * replies from sticky.web_messages. Everything above this layer (routing, jobs, delivery) is shared.
 */
import { one } from './db.js';
import { sendText } from './linq.js';
import { liveRelay } from './live.js';

export const WEB_PREFIX = 'web:';
export const isWebChat = (chatId: string | null | undefined): boolean => Boolean(chatId?.startsWith(WEB_PREFIX));

/** Send a text reply into the thread; returns the provider message id (or a web id). */
export async function say(chatId: string, text: string, versionId: string | null = null): Promise<string | null> {
  // A job asked for in a live session reports in the room. A browser thread still logs it; an
  // iMessage thread only gets the final cut.
  const relayed = await liveRelay(chatId, text).catch(() => false);
  if (isWebChat(chatId)) {
    const row = await one<{ id: string }>(
      'INSERT INTO sticky.web_messages (chat_id, body, version_id) VALUES ($1, $2, $3) RETURNING id',
      [chatId, text, versionId],
    );
    return row ? `web-${row.id}` : null;
  }
  if (relayed) return null;
  return (await sendText(chatId, text)).providerMessageId;
}
