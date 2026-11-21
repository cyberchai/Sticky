import { initDb, db } from '../src/db.js';
import { migrate } from '../src/migrate.js';

await initDb();
await migrate();
await db().end();
