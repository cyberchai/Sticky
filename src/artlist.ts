/**
 * Artlist (music) over its MCP server, https://mcp.artlist.io/mcp. Auth is OAuth with the user's own
 * Artlist account (AI credits); scripts/artlist-login.ts does the one-time sign-in and stores
 * { clientId, refreshToken } as STICKY_ARTLIST_OAUTH (JSON). Here we only refresh and call tools.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { log } from './log.js';

export const ARTLIST_MCP = 'https://mcp.artlist.io/mcp';
export const ARTLIST_RESOURCE = 'https://mcp.artlist.io/';
export const ARTLIST_TOKEN_URL = 'https://auth.artlist.io/oauth/token';

let cached: { token: string; exp: number } | null = null;
let rotatedRefresh: string | null = null;

function creds(): { clientId: string; refreshToken: string } {
  const raw = process.env.STICKY_ARTLIST_OAUTH ?? '';
  if (!raw) throw new Error('Artlist is not connected (run scripts/artlist-login.ts)');
  const c = JSON.parse(raw);
  return { clientId: c.clientId, refreshToken: rotatedRefresh ?? c.refreshToken };
}

export async function artlistAccessToken(): Promise<string> {
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const { clientId, refreshToken } = creds();
  const res = await fetch(ARTLIST_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({})) as any;
  if (!res.ok || !body.access_token) throw new Error(`Artlist token refresh failed: HTTP ${res.status} ${body.error ?? ''}`);
  if (body.refresh_token) rotatedRefresh = body.refresh_token; // rotation: keep the newest for this process
  cached = { token: body.access_token, exp: Date.now() + Number(body.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export async function withArtlist<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const token = await artlistAccessToken();
  const transport = new StreamableHTTPClientTransport(new URL(ARTLIST_MCP), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'sticky', version: '0.1.0' });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Every content item a tool returned, flattened to text (Artlist answers in text/JSON). */
export function toolText(result: any): string {
  return (result?.content ?? []).map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? JSON.stringify(c.resource) : '')).join('\n');
}

export function logArtlist(fields: Record<string, unknown>): void {
  log('artlist', fields);
}
