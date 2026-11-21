/**
 * Object storage: a temp-project GCS bucket, or local disk when STICKY_BUCKET is empty (dev).
 * Every object also has a local cache path (`cachePath(key)`), which is where ffmpeg reads and writes;
 * `ensureLocal` re-downloads after a restart.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';

let storage: Storage | null = null;
const bucket = () => (storage ??= new Storage({ projectId: config.gemini.project || undefined })).bucket(config.bucket);
const useGcs = () => Boolean(config.bucket);

const localStoreRoot = () => path.join(config.workDir, 'store');

export function cachePath(key: string): string {
  return path.join(config.workDir, 'cache', key);
}

export async function ensureDir(file: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
}

/** Persist a local file under `key`. */
export async function putFile(key: string, localFile: string, contentType: string): Promise<void> {
  if (useGcs()) {
    await bucket().upload(localFile, {
      destination: key,
      resumable: false,
      contentType,
      metadata: { cacheControl: 'private, max-age=0, no-store' },
    });
    return;
  }
  const dest = path.join(localStoreRoot(), key);
  if (path.resolve(dest) === path.resolve(localFile)) return;
  await ensureDir(dest);
  await fsp.copyFile(localFile, dest);
}

/** A local path for `key`, downloading it into the cache when missing. */
export async function ensureLocal(key: string): Promise<string> {
  const local = cachePath(key);
  if (fs.existsSync(local)) return local;
  await ensureDir(local);
  if (useGcs()) await bucket().file(key).download({ destination: local });
  else await fsp.copyFile(path.join(localStoreRoot(), key), local);
  return local;
}

export async function sizeOf(key: string): Promise<number> {
  const local = cachePath(key);
  if (fs.existsSync(local)) return (await fsp.stat(local)).size;
  if (useGcs()) {
    const [meta] = await bucket().file(key).getMetadata();
    return Number(meta.size);
  }
  return (await fsp.stat(path.join(localStoreRoot(), key))).size;
}

export function readStream(key: string, range?: { start: number; end: number }): NodeJS.ReadableStream {
  const local = cachePath(key);
  if (fs.existsSync(local)) return fs.createReadStream(local, range);
  if (useGcs()) return bucket().file(key).createReadStream(range ? { start: range.start, end: range.end } : {});
  return fs.createReadStream(path.join(localStoreRoot(), key), range);
}

/** A single-object write: GCS replaces the object atomically, so readers see the old or the new JSON. */
export async function putJson(key: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2);
  if (useGcs()) {
    await bucket().file(key).save(body, { resumable: false, contentType: 'application/json' });
    return;
  }
  const dest = path.join(localStoreRoot(), key);
  await ensureDir(dest);
  const tmp = `${dest}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, dest); // atomic on one filesystem
}

export async function getJson<T>(key: string): Promise<T | null> {
  try {
    if (useGcs()) {
      const [buf] = await bucket().file(key).download();
      return JSON.parse(buf.toString('utf8')) as T;
    }
    return JSON.parse(await fsp.readFile(path.join(localStoreRoot(), key), 'utf8')) as T;
  } catch {
    return null;
  }
}
