/**
 * The free Linq line's allowlist (Hobby "Shared" line): Sticky only hears from, and can only reply to,
 * up to 20 contacts, and each contact must text the line once before Sticky can text them back.
 * These are the endpoints Linq's own CLI uses (`linq contacts add|list|remove`), called with Sticky's key.
 */
import { config } from './config.js';
import { errMsg, last4, log } from './log.js';

const BACKEND = process.env.LINQ_BACKEND_URL || 'https://prod.zero-service.linqapp.com';
export const CONTACT_LIMIT = Number(process.env.STICKY_CONTACT_LIMIT ?? 20);
const orgId = () => process.env.LINQ_ORG_ID ?? '';

/** E.164, US by default: "(212) 555-0142" → "+12125550142". Null when it can't be a phone number. */
export function toE164(raw: string): string | null {
  const s = String(raw ?? '').trim();
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Every phone number written in a message ("add 347-555-0100 and +1 917 555 0101"). */
export function phonesIn(text: string): string[] {
  const found = String(text).match(/\+?\d[\d\s().-]{8,}\d/g) ?? [];
  return [...new Set(found.map(toE164).filter((p): p is string => Boolean(p)))];
}

async function call(path: string, init: RequestInit = {}): Promise<any> {
  if (!orgId()) throw new Error('LINQ_ORG_ID is not set');
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.linq.apiKey}`, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Linq contacts HTTP ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

export async function listContacts(): Promise<string[]> {
  const body = await call(`/cli/contacts?orgId=${encodeURIComponent(orgId())}`, { method: 'GET' });
  const rows: any[] = Array.isArray(body) ? body : body.contacts ?? body.data ?? [];
  return rows.map((r) => (typeof r === 'string' ? r : r.contactPhone ?? r.phone ?? r.phone_number)).filter(Boolean);
}

export interface AddResult { added: string[]; already: string[]; failed: Array<{ phone: string; error: string }>; full: string[]; used: number }

/** Add numbers until the list is full; never removes anyone to make room. */
export async function addContacts(phones: string[]): Promise<AddResult> {
  const out: AddResult = { added: [], already: [], failed: [], full: [], used: 0 };
  const have = new Set(await listContacts().catch(() => [] as string[]));
  for (const phone of [...new Set(phones)]) {
    if (have.has(phone)) { out.already.push(phone); continue; }
    if (have.size >= CONTACT_LIMIT) { out.full.push(phone); continue; }
    try {
      await call('/cli/contacts/add', { method: 'POST', body: JSON.stringify({ orgId: orgId(), contactPhone: phone }) });
      have.add(phone);
      out.added.push(phone);
    } catch (err) {
      const e = errMsg(err);
      if (/already/i.test(e)) { have.add(phone); out.already.push(phone); } else out.failed.push({ phone, error: e });
    }
  }
  out.used = have.size;
  log('contacts', { added: out.added.map(last4).join(',') || undefined, already: out.already.length || undefined, full: out.full.length || undefined, failed: out.failed.length || undefined, used: out.used });
  return out;
}

export async function removeContact(phone: string): Promise<void> {
  await call('/cli/contacts/remove', { method: 'POST', body: JSON.stringify({ orgId: orgId(), contactPhone: phone }) });
  log('contacts', { removed: last4(phone) });
}

/** One tap on an iPhone opens Messages to Sticky with a first line ready (that first text is what unlocks replies). */
export function textStickyLink(body = 'Hi Sticky'): string {
  return `sms:${config.line}&body=${encodeURIComponent(body)}`;
}

/** The public page that adds someone and hands them the one-tap text link. */
export function joinUrl(): string {
  return `${config.publicBaseUrl || 'https://sticky-editor-1097661752215.us-central1.run.app'}/join`;
}
