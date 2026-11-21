/**
 * Scan-to-join group chats (migration 010). The free line only reaches people on its list who have texted
 * it once, so joining is: number on the page (onto the list) → one prefilled text, "Join group <code>"
 * (unlocks replies and names the group) → Sticky starts the iMessage group once two people are in (Linq
 * needs two others besides Sticky), then adds each later person to it.
 */
import crypto from 'node:crypto';
import { COPY, config } from './config.js';
import { joinUrl } from './contacts.js';
import { one, q, tx } from './db.js';
import { addParticipant, nameChat, openChat } from './linq.js';
import { errMsg, last4, log } from './log.js';

// No I, O, 0 or 1, since people read codes off a screen. 32 symbols, so every random byte maps evenly.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const DEFAULT_NAME = 'sticky';

export function newCode(): string {
  return [...crypto.randomBytes(8)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
}

/** The group's name in Messages: one line, at most 40 characters, "sticky" when left blank. */
export function cleanName(raw: unknown): string {
  const name = String(raw ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim();
  return [...name].slice(0, 40).join('').trim() || DEFAULT_NAME;
}

/** The first text a joiner sends; the join page prefills it. */
export const joinText = (code: string) => `Join group ${code}`;

/** Candidate codes in a text, as written (codes are upper case, so ordinary words rarely match). */
export function codesIn(text: string): string[] {
  return [...new Set(String(text).match(/\b[A-HJ-NP-Z2-9]{8}\b/g) ?? [])];
}

export const inviteUrl = (code: string) => `${joinUrl()}/g/${code}`;

export async function createInvite(name: string): Promise<{ code: string; name: string }> {
  const row = await one<{ code: string; name: string }>(
    'INSERT INTO sticky.group_invites (code, name) VALUES ($1, $2) RETURNING code, name',
    [newCode(), name],
  );
  log('invite', { created: row!.code });
  return row!;
}

export interface InviteStatus { name: string; started: boolean; signedUp: number; texted: number; inChat: number }

export async function inviteStatus(code: string): Promise<InviteStatus | null> {
  const r = await one(
    `SELECT i.name, i.chat_id IS NOT NULL AS started, count(m.phone)::int AS signed_up,
            count(m.texted_at)::int AS texted, count(m.added_at)::int AS in_chat
     FROM sticky.group_invites i LEFT JOIN sticky.group_invite_members m ON m.code = i.code
     WHERE i.code = $1 GROUP BY i.code`,
    [code],
  );
  return r ? { name: r.name, started: r.started, signedUp: r.signed_up, texted: r.texted, inChat: r.in_chat } : null;
}

export async function inviteExists(code: string): Promise<boolean> {
  return Boolean(await one('SELECT 1 FROM sticky.group_invites WHERE code = $1', [code]));
}

/** Someone added their number on the group's page (they're on the list; their text comes next). */
export async function signUp(code: string, phone: string): Promise<void> {
  await q(
    `INSERT INTO sticky.group_invite_members (code, phone) VALUES ($1, $2)
     ON CONFLICT (code, phone) DO UPDATE SET signed_up_at = now()`,
    [code, phone],
  );
}

/**
 * Which group a one-on-one text asks to join: only a code written in the text itself. The page can't
 * prove whose number was typed into it, so a sign-up alone never pulls anyone into a chat of strangers;
 * the text from the phone is the consent.
 */
async function inviteFor(text: string): Promise<string | null> {
  const codes = codesIn(text);
  if (!codes.length) return null;
  const hit = await one<{ code: string }>('SELECT code FROM sticky.group_invites WHERE code = ANY($1) LIMIT 1', [codes]);
  return hit?.code ?? null;
}

/**
 * A one-on-one text from `phone`: if it is a join, put them in the group chat and return the reply for
 * their one-on-one thread; null when the text isn't a join. The invite row is locked for the whole
 * join, so two people texting at once can't start two groups.
 */
export async function joinFromText(phone: string, text: string): Promise<string | null> {
  const code = await inviteFor(text);
  if (!code) return null;
  const out = await tx<{ reply: string; started?: { chatId: string; name: string } }>(async (c) => {
    const invite = (await c.query('SELECT * FROM sticky.group_invites WHERE code = $1 FOR UPDATE', [code])).rows[0];
    const me = (await c.query(
      `INSERT INTO sticky.group_invite_members (code, phone, texted_at) VALUES ($1, $2, now())
       ON CONFLICT (code, phone) DO UPDATE SET texted_at = COALESCE(sticky.group_invite_members.texted_at, now())
       RETURNING added_at`,
      [code, phone],
    )).rows[0];
    if (me.added_at) return { reply: COPY.groupJoinAlready(invite.name) };
    const failed = async (err: unknown) => {
      const msg = errMsg(err);
      log('invite', { code, phone: last4(phone), failed: msg }, 'warn');
      await c.query('UPDATE sticky.group_invite_members SET error = $3 WHERE code = $1 AND phone = $2', [code, phone, msg.slice(0, 300)]);
      return { reply: COPY.groupJoinFailed(joinText(code)) };
    };

    if (invite.chat_id) {
      try { await addParticipant(invite.chat_id, phone); } catch (err) { return failed(err); }
      await c.query('UPDATE sticky.group_invite_members SET added_at = now(), error = NULL WHERE code = $1 AND phone = $2', [code, phone]);
      log('invite', { code, chat: invite.chat_id, added: last4(phone) });
      return { reply: COPY.groupJoined(invite.name) };
    }

    // No group yet: it starts with everyone who has texted, once that's two people.
    const ready: string[] = (await c.query(
      'SELECT phone FROM sticky.group_invite_members WHERE code = $1 AND texted_at IS NOT NULL AND added_at IS NULL ORDER BY texted_at',
      [code],
    )).rows.map((r) => r.phone);
    if (ready.length < 2) return { reply: COPY.groupJoinWaiting(invite.name) };
    let chatId: string | null;
    try {
      chatId = (await openChat(config.line, ready, [{ type: 'text', value: COPY.groupHello }])).chatId;
      if (!chatId) throw new Error('Linq returned no chat id');
    } catch (err) {
      return failed(err);
    }
    await c.query('UPDATE sticky.group_invites SET chat_id = $2 WHERE code = $1', [code, chatId]);
    await c.query('UPDATE sticky.group_invite_members SET added_at = now(), error = NULL WHERE code = $1 AND phone = ANY($2)', [code, ready]);
    // The hello above was the group's greeting, so the first clip doesn't get a second one.
    await c.query(
      `INSERT INTO sticky.threads (chat_id, line, is_group, greeted_at) VALUES ($1, $2, true, now())
       ON CONFLICT (chat_id) DO UPDATE SET is_group = true, greeted_at = COALESCE(sticky.threads.greeted_at, now())`,
      [chatId, config.line],
    );
    log('invite', { code, chat: chatId, started: ready.map(last4).join(',') });
    return { reply: COPY.groupJoined(invite.name), started: { chatId, name: invite.name } };
  });
  if (out.started) {
    const { chatId, name } = out.started;
    await nameChat(chatId, name).catch((err) => log('invite', { code, chat: chatId, name: 'failed', error: errMsg(err) }, 'warn'));
  }
  return out.reply;
}
