/**
 * One-time Artlist sign-in for Sticky (OAuth 2.1 + PKCE, offline_access), then list the MCP tools.
 *   npx tsx scripts/artlist-login.ts
 * Opens your browser at Artlist's sign-in; after you approve, stores { clientId, refreshToken } in the
 * temp project's Secret Manager (sticky-artlist-oauth) and in .env as STICKY_ARTLIST_OAUTH. Never prints tokens.
 */
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { ARTLIST_RESOURCE, ARTLIST_TOKEN_URL, withArtlist } from '../src/artlist.js';

const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const AUTH = 'https://auth.artlist.io';

async function register(): Promise<string> {
  for (const path of ['/oidc/register', '/register']) {
    const r = await fetch(`${AUTH}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Sticky', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
    });
    const body = await r.json().catch(() => ({})) as any;
    if (r.ok && body.client_id) { console.log(`registered client via ${path}`); return body.client_id; }
    console.log(`register ${path}: HTTP ${r.status} ${body.error ?? ''} ${body.error_description ?? ''}`);
  }
  throw new Error('no dynamic client registration available');
}

const clientId = process.env.ARTLIST_CLIENT_ID || await register();
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');
const authorize = new URL(`${AUTH}/authorize`);
authorize.search = new URLSearchParams({
  response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: 'openid offline_access',
  code_challenge: challenge, code_challenge_method: 'S256', state, resource: ARTLIST_RESOURCE, audience: ARTLIST_RESOURCE,
}).toString();

const code: string = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', REDIRECT);
    if (u.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
    const err = u.searchParams.get('error');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(err ? `<h2>Artlist sign-in failed: ${err}</h2>` : '<h2>Sticky is connected to Artlist. You can close this tab.</h2>');
    server.close();
    if (err) reject(new Error(`${err}: ${u.searchParams.get('error_description') ?? ''}`));
    else if (u.searchParams.get('state') !== state) reject(new Error('state mismatch'));
    else resolve(u.searchParams.get('code') ?? '');
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log('Opening Artlist sign-in in your browser…');
    spawn('open', [authorize.toString()], { stdio: 'ignore', detached: true }).unref();
  });
  setTimeout(() => { server.close(); reject(new Error('timed out waiting for sign-in (5 min)')); }, 300_000).unref();
});

const tok = await fetch(ARTLIST_TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, redirect_uri: REDIRECT, code_verifier: verifier, resource: ARTLIST_RESOURCE }),
});
const t = await tok.json() as any;
if (!tok.ok || !t.refresh_token) throw new Error(`token exchange failed: HTTP ${tok.status} ${t.error ?? ''} ${t.error_description ?? ''} (refresh_token ${t.refresh_token ? 'present' : 'missing'})`);
const secret = JSON.stringify({ clientId, refreshToken: t.refresh_token });

const env = { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: 'sticky' };
const project = 'gemini4nyc26nyc-2243';
try {
  execFileSync('gcloud', ['secrets', 'create', 'sticky-artlist-oauth', '--project', project, '--replication-policy', 'automatic', '--data-file=-'], { input: secret, env, stdio: ['pipe', 'ignore', 'ignore'] });
} catch {
  execFileSync('gcloud', ['secrets', 'versions', 'add', 'sticky-artlist-oauth', '--project', project, '--data-file=-'], { input: secret, env, stdio: ['pipe', 'ignore', 'ignore'] });
}
execFileSync('gcloud', ['secrets', 'add-iam-policy-binding', 'sticky-artlist-oauth', '--project', project, '--member', 'serviceAccount:1097661752215-compute@developer.gserviceaccount.com', '--role', 'roles/secretmanager.secretAccessor'], { env, stdio: 'ignore' });
const lines = fs.readFileSync('.env', 'utf8').split('\n').filter((l) => l && !l.startsWith('STICKY_ARTLIST_OAUTH='));
lines.push(`STICKY_ARTLIST_OAUTH=${secret}`);
fs.writeFileSync('.env', `${lines.join('\n')}\n`);
process.env.STICKY_ARTLIST_OAUTH = secret;
console.log('stored refresh token (Secret Manager sticky-artlist-oauth + .env); not printed');

const tools = await withArtlist((c) => c.listTools());
for (const tool of tools.tools) {
  console.log(`\n- ${tool.name}: ${(tool.description ?? '').replace(/\s+/g, ' ').slice(0, 220)}`);
  console.log(`  input: ${JSON.stringify(tool.inputSchema?.properties ?? {}).slice(0, 400)}`);
}
process.exit(0);
