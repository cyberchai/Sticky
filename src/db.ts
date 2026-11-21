import pg from 'pg';

let pool: pg.Pool | null = null;

/** DATABASE_URL (local Postgres while Cloud SQL boots) or the Cloud SQL connector (temp project). */
export async function initDb(): Promise<pg.Pool> {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
  } else if (process.env.CLOUD_SQL_CONNECTION_NAME) {
    const { Connector, IpAddressTypes } = await import('@google-cloud/cloud-sql-connector');
    const connector = new Connector();
    const opts = await connector.getOptions({
      instanceConnectionName: process.env.CLOUD_SQL_CONNECTION_NAME,
      ipType: IpAddressTypes.PUBLIC,
    });
    pool = new pg.Pool({
      ...opts,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      max: 8,
    });
  } else {
    throw new Error('no database configured: set DATABASE_URL or CLOUD_SQL_CONNECTION_NAME');
  }
  pool.on('error', (err) => console.error('[sticky:db] idle client error', err.message));
  return pool;
}

export function db(): pg.Pool {
  if (!pool) throw new Error('db not initialised');
  return pool;
}

export async function q<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db().query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
