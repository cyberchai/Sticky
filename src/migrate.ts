import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db.js';
import { log } from './log.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Every migration is idempotent DDL; apply all of them in order on boot. */
export async function migrate(): Promise<void> {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) await db().query(fs.readFileSync(path.join(dir, f), 'utf8'));
  log('db', { migrated: files.join(',') });
}
