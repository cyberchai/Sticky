/**
 * Recovery test: re-deliver a stored inbound event through the real push endpoint, exactly as a
 * Pub/Sub redelivery or Linq retry would. Expect `result=duplicate` in the processor log and no new job.
 *   npm run replay -- <provider_event_id> [http://localhost:8787]
 */
import { config } from '../src/config.js';
import { db, initDb, one } from '../src/db.js';

const [eventId, base = `http://localhost:${config.port}`] = process.argv.slice(2);
if (!eventId) { console.error('usage: npm run replay -- <provider_event_id> [baseUrl]'); process.exit(1); }
await initDb();
const ev = await one('SELECT payload FROM sticky.events WHERE provider_event_id = $1', [eventId]);
if (!ev) { console.error('no such event'); process.exit(1); }
const before = await one('SELECT count(*)::int AS n FROM sticky.jobs');
const envelope = { message: { data: Buffer.from(JSON.stringify(ev.payload)).toString('base64'), attributes: { webhookId: eventId }, messageId: `replay-${Date.now()}` } };
const res = await fetch(`${base}/pubsub/inbound?token=${encodeURIComponent(config.pushToken)}`, { method: 'POST', body: JSON.stringify(envelope), headers: { 'Content-Type': 'application/json' } });
await new Promise((r) => setTimeout(r, 3000));
const after = await one('SELECT count(*)::int AS n FROM sticky.jobs');
console.log(`push → HTTP ${res.status}; jobs before=${before.n} after=${after.n} ${before.n === after.n ? '(no new job: OK)' : '(NEW JOB: dedupe failed)'}`);
await db().end();
