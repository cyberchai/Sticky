/**
 * Sticky processor HTTP surface.
 *   POST /webhooks/linq           Sticky's OWN Linq subscription (Sticky line only); no Asaply code involved
 *   POST /pubsub/inbound?token=   Pub/Sub push from the core-api bridge (only if the line is shared)
 *   POST /forward/linq            HMAC-signed direct forward from the bridge (fallback mode)
 *   GET  /v/:token.mp4            tap-to-play link fallback (byte ranges for iOS)
 *   GET  /health  (Cloud Run reserves /healthz)
 *   GET  /admin/runs | /admin/latest | /admin/projects/:id | /admin/trends   (Bearer STICKY_ADMIN_TOKEN)
 *   POST /admin/trends/refresh
 * Ack = the event and its rows are committed. Everything else happens after.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { config, today } from './config.js';
import { initDb, one, q } from './db.js';
import { acceptEvent } from './inbound.js';
import { startWorker } from './jobs.js';
import { verifyLinqSignature } from './linq.js';
import { handleWeb } from './web.js';
import { handleLive } from './live.js';
import { handleReels } from './reels.js';
import { errMsg, log } from './log.js';
import { migrate } from './migrate.js';
import { readStream, sizeOf } from './store.js';
import { refreshSnapshot } from './trends/refresh.js';
import { selectCandidates } from './trends/select.js';
import { isExpired, loadSnapshot, refreshInBackground } from './trends/snapshot.js';

function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body, null, 2));
}

function isAdmin(req: http.IncomingMessage, _url: URL): boolean {
  if (!config.adminToken) return false;
  // Header only: a token in a query string ends up in request logs.
  const header = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return header !== '' && safeEqual(header, config.adminToken);
}

async function ingest(raw: string, eventId: string): Promise<void> {
  const { after } = await acceptEvent(raw, eventId);
  for (const fn of after) void fn().catch((err) => log('after', { event: eventId, error: errMsg(err) }, 'warn'));
}

async function serveVideo(req: http.IncomingMessage, res: http.ServerResponse, token: string): Promise<void> {
  const v = await one(`SELECT out_key FROM sticky.versions WHERE link_token = $1 AND created_at > now() - interval '7 days'`, [token]);
  if (!v) { res.writeHead(404); res.end(); return; }
  const size = await sizeOf(v.out_key);
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' };
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    readStream(v.out_key, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req.method === 'HEAD') { res.end(); return; }
  readStream(v.out_key).pipe(res);
}

async function projectDetail(id: string): Promise<unknown> {
  const project = await one('SELECT * FROM sticky.projects WHERE id = $1', [id]);
  if (!project) return null;
  const [sources, jobs, versions] = await Promise.all([
    q(`SELECT clip_id, status, duration_ms, has_audio, width, height, color_transfer, followup, timings, error, created_at FROM sticky.sources WHERE project_id = $1 ORDER BY clip_id`, [id]),
    q(`SELECT id, kind, status, direction, stage, stage_ms, model, version_no, error, inbound_at, created_at, finished_at FROM sticky.jobs WHERE project_id = $1 ORDER BY created_at`, [id]),
    q(`SELECT version_no, segments, technique, explanation, direction, duration_ms, delivery, provider_message_id, accepted_at, delivered_at, kept, link_token FROM sticky.versions WHERE project_id = $1 ORDER BY version_no`, [id]),
  ]);
  return {
    project: { id: project.id, chat_id: project.chat_id, state: project.state, direction: project.direction, kept_version: project.kept_version, created_at: project.created_at },
    analysis: project.analysis,
    sources,
    jobs,
    versions: versions.map((v: any) => ({
      ...v,
      technique: { id: v.technique.id, title: v.technique.title, kind: v.technique.kind, source: v.technique.sourceName, url: v.technique.url, observedOn: v.technique.observedOn, dateBasis: v.technique.dateBasis },
      link: config.publicBaseUrl ? `${config.publicBaseUrl}/v/${v.link_token}.mp4` : undefined,
      link_token: undefined,
    })),
  };
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local');
  const path = url.pathname;

  if (await handleWeb(req, res, url)) return;
  if (await handleLive(req, res, url)) return;
  if (await handleReels(req, res, url)) return;

  if (req.method === 'POST' && path === '/webhooks/linq') {
    const body = await readBody(req);
    if (!verifyLinqSignature(body, req.headers, config.linqWebhookSecret)) return json(res, 401, { ok: false });
    // Persist before the 200; a storage failure is a 500, which Linq retries (up to 30 min).
    await ingest(body, String(req.headers['webhook-id'] ?? ''));
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/pubsub/inbound') {
    if (!config.pushToken || !safeEqual(url.searchParams.get('token') ?? '', config.pushToken)) return json(res, 401, { ok: false });
    let envelope: any;
    try {
      envelope = JSON.parse(await readBody(req));
    } catch {
      // A body that will never parse is acked, not redelivered forever.
      log('http', { push: 'unparseable envelope, acked' }, 'warn');
      res.writeHead(204); res.end();
      return;
    }
    const msg = envelope?.message ?? {};
    const raw = Buffer.from(String(msg.data ?? ''), 'base64').toString('utf8');
    await ingest(raw, String(msg.attributes?.webhookId || msg.messageId || msg.message_id || ''));
    res.writeHead(204); res.end();
    return;
  }

  if (req.method === 'POST' && path === '/forward/linq') {
    const body = await readBody(req);
    const sig = String(req.headers['x-sticky-signature'] ?? '');
    const expected = config.forwardSecret ? crypto.createHmac('sha256', config.forwardSecret).update(body).digest('hex') : '';
    if (!expected || !safeEqual(sig, expected)) return json(res, 401, { ok: false });
    await ingest(body, String(req.headers['x-linq-webhook-id'] ?? ''));
    return json(res, 200, { ok: true });
  }

  const video = /^\/v\/([a-f0-9]{32})\.mp4$/.exec(path);
  if (video && (req.method === 'GET' || req.method === 'HEAD')) return serveVideo(req, res, video[1]);

  if (path === '/health') {
    const snap = await loadSnapshot();
    return json(res, 200, { ok: true, line: config.line, snapshot: { origin: snap.origin, refreshedAt: snap.refreshedAt, expired: isExpired(snap) } });
  }

  if (path.startsWith('/admin/')) {
    if (!isAdmin(req, url)) return json(res, 401, { ok: false });
    if (path === '/admin/runs') {
      const rows = await q(`
        SELECT j.id, j.kind, j.status, j.stage, j.error, j.model, j.stage_ms, j.version_no, j.project_id, p.chat_id,
               j.inbound_at, j.created_at, j.finished_at, v.delivery, v.accepted_at, v.delivered_at, v.technique->>'id' AS technique,
               ROUND(EXTRACT(EPOCH FROM (v.accepted_at - j.inbound_at)) * 1000) AS inbound_to_accepted_ms,
               ROUND(EXTRACT(EPOCH FROM (v.delivered_at - j.inbound_at)) * 1000) AS inbound_to_delivered_ms
        FROM sticky.jobs j JOIN sticky.projects p ON p.id = j.project_id
        LEFT JOIN sticky.versions v ON v.job_id = j.id
        ORDER BY j.created_at DESC LIMIT 20`);
      return json(res, 200, rows);
    }
    if (path === '/admin/latest') {
      const p = await one(`SELECT id FROM sticky.projects ORDER BY created_at DESC LIMIT 1`);
      return json(res, 200, p ? await projectDetail(p.id) : null);
    }
    const pm = /^\/admin\/projects\/([0-9a-f-]{36})$/.exec(path);
    if (pm) return json(res, 200, await projectDetail(pm[1]));
    if (path === '/admin/trends' && req.method === 'GET') {
      const snap = await loadSnapshot();
      const { candidates, freshCount } = selectCandidates(snap, today());
      return json(res, 200, {
        origin: snap.origin, refreshedAt: snap.refreshedAt, expired: isExpired(snap), today: today(), sources: snap.sources, freshCount,
        candidates: candidates.map((c) => ({ rank: c.rank, id: c.id, kind: c.kind, observedOn: c.observedOn, dateBasis: c.dateBasis, ageDays: c.ageDays, corroboratedBy: c.corroboratedBy.map((s) => s.sourceName), requires: c.requires })),
        excluded: snap.techniques.filter((t) => !t.renderable).map((t) => ({ id: t.id, why: t.whyNotRenderable })),
      });
    }
    if (path === '/admin/trends/refresh' && req.method === 'POST') {
      const snap = await refreshSnapshot('admin');
      return json(res, 200, { refreshedAt: snap.refreshedAt, sources: snap.sources, techniques: snap.techniques.length });
    }
  }

  json(res, 404, { ok: false });
}

async function main(): Promise<void> {
  await initDb();
  await migrate();
  const snap = await loadSnapshot();
  log('trends', { loaded: snap.origin, refreshedAt: snap.refreshedAt, techniques: snap.techniques.length, expired: isExpired(snap) });
  // One worker at a time: the Pub/Sub push target runs it; a standby (Mac or Cloud Run) sets STICKY_WORKER=off.
  if (process.env.STICKY_WORKER !== 'off') {
    if (isExpired(snap)) refreshInBackground('boot');
    startWorker();
  } else {
    log('worker', { started: false, reason: 'STICKY_WORKER=off (standby)' });
  }
  http.createServer((req, res) => {
    route(req, res).catch((err) => {
      log('http', { path: req.url?.split('?')[0], error: errMsg(err) }, 'error');
      if (!res.headersSent) json(res, 500, { ok: false });
      else res.end();
    });
  }).listen(config.port, () => log('http', { listening: config.port, line: config.line, bucket: config.bucket || 'local-disk', model: config.gemini.videoModel || config.gemini.fallbackModel }));
}

main().catch((err) => {
  console.error('[sticky:boot] failed', err);
  process.exit(1);
});
