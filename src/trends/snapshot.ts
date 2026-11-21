/**
 * The latest trend snapshot the editor can read immediately: memory → stored JSON → committed seed.
 * Refresh runs away from the render: an expired snapshot queues ONE background refresh and the
 * current cut uses whatever is already there.
 */
import { createRequire } from 'node:module';
import { LIMITS } from '../config.js';
import { errMsg, log } from '../log.js';
import { getJson } from '../store.js';
import type { Snapshot } from './types.js';

export const SNAPSHOT_KEY = 'sticky/trends/snapshot.json';
const require = createRequire(import.meta.url);
export const SEED = require('./seed.json') as Snapshot;

let current: Snapshot | null = null;
let inflight: Promise<unknown> | null = null;

export async function loadSnapshot(): Promise<Snapshot> {
  if (current) return current;
  const stored = await getJson<Snapshot>(SNAPSHOT_KEY);
  current = stored && Array.isArray(stored.techniques) && stored.techniques.length ? stored : SEED;
  return current;
}

export function setSnapshot(s: Snapshot): void {
  current = s;
}

export function isExpired(s: Snapshot, now = Date.now()): boolean {
  return now - Date.parse(s.refreshedAt) > LIMITS.snapshotTtlMs;
}

/** Deduplicated in-process; refresh.ts also takes a Postgres advisory lock across processes. */
export function refreshInBackground(reason: string): void {
  if (inflight) return;
  inflight = import('./refresh.js')
    .then(({ refreshSnapshot }) => refreshSnapshot(reason))
    .catch((err) => log('trends', { refresh: 'failed', reason, error: errMsg(err) }, 'warn'))
    .finally(() => { inflight = null; });
}

export async function snapshotForCut(): Promise<Snapshot> {
  const snap = await loadSnapshot();
  if (isExpired(snap)) refreshInBackground('expired-at-cut');
  return snap;
}
