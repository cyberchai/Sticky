/**
 * Set Sticky's iMessage contact card (name "Sticky", yellow logo) on the Sticky line, then show it.
 *   npx tsx scripts/linq-contact-card.ts [--share <chatId>]
 * After it reports is_active: true, set STICKY_CONTACT_CARD=on so Sticky shares it into chats.
 */
import { config } from '../src/config.js';
import { ensureContactCard, linqCall } from '../src/linq.js';

const image = `${config.publicBaseUrl || 'https://sticky-editor-1097661752215.us-central1.run.app'}/assets/sticky-avatar.png`;
const head = await fetch(image, { method: 'HEAD' });
console.log(`avatar ${image} → HTTP ${head.status} ${head.headers.get('content-type')}`);

const r = await ensureContactCard(config.line, 'Sticky', image);
console.log(`set card on ${config.line}: HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);

const got = await linqCall('GET', `/contact_card?phone_number=${encodeURIComponent(config.line)}`);
console.log(`current: HTTP ${got.status} ${JSON.stringify(got.body).slice(0, 400)}`);

const i = process.argv.indexOf('--share');
if (i > 0) {
  const s = await linqCall('POST', `/chats/${encodeURIComponent(process.argv[i + 1])}/share_contact_card`);
  console.log(`share into ${process.argv[i + 1]}: HTTP ${s.status} ${JSON.stringify(s.body).slice(0, 200)}`);
}
