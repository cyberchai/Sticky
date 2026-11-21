/**
 * Measured outliers: posts that got far more views than their creator's following, with the counts the
 * source reports (Viral Outliers' free trending feed). These are real numbers about OTHER posts, used to
 * pick an opening pattern and cited as evidence. They are never turned into a prediction for the user's reel.
 */
import { errMsg, log } from '../log.js';

export interface Outlier {
  id: string;
  platform: string;
  handle: string;
  caption: string;
  views: number;
  likes: number;
  followers: number;
  viewsPerFollower: number;   // views ÷ followers, computed from the source's own counts
  outlierScore: number | null; // the source's metric, quoted as-is
  postLink: string;
  thumbnail: string | null;
  retrievedAt: string;         // when it was on the trending feed (the feed has no post dates)
  hook?: string;               // opening pattern, labeled by Gemini from caption + thumbnail
  opening?: string;            // one line: how the post opens
}

const FEED = 'https://viraloutliers.com/api/v1/trending';

export async function fetchOutliers(): Promise<Outlier[]> {
  const res = await fetch(FEED, { headers: { 'User-Agent': 'Mozilla/5.0 StickyTrendReader/0.1', Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Viral Outliers HTTP ${res.status}`);
  const body = await res.json() as { outliers?: any[] };
  const retrievedAt = new Date().toISOString();
  return (body.outliers ?? [])
    .filter((o) => ['Video', 'Short', 'Reel'].includes(o?.contentType) && Number(o.views) > 0 && Number(o.followerCount) > 0 && typeof o.postLink === 'string')
    .map((o) => ({
      id: String(o.id),
      platform: String(o.platform ?? 'unknown'),
      handle: String(o.handle ?? ''),
      caption: String(o.title ?? '').slice(0, 300),
      views: Number(o.views),
      likes: Number(o.likes ?? 0),
      followers: Number(o.followerCount),
      viewsPerFollower: Math.round((Number(o.views) / Number(o.followerCount)) * 10) / 10,
      outlierScore: Number.isFinite(Number(o.outlierScore)) ? Number(o.outlierScore) : null,
      postLink: o.postLink,
      thumbnail: typeof o.thumbnail === 'string' ? o.thumbnail : null,
      retrievedAt,
    }));
}

/** Thumbnails often carry the on-screen hook; fetch them best-effort for the hook classifier. */
export async function thumbnailsOf(outliers: Outlier[]): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  await Promise.all(outliers.map(async (o) => {
    if (!o.thumbnail) return;
    try {
      const r = await fetch(o.thumbnail, { signal: AbortSignal.timeout(6_000) });
      if (r.ok && (r.headers.get('content-type') ?? '').startsWith('image/')) out.set(o.id, Buffer.from(await r.arrayBuffer()));
    } catch (err) {
      log('outliers', { thumbnail: 'failed', id: o.id, error: errMsg(err) }, 'warn');
    }
  }));
  return out;
}

/** Instagram first, then by how far views outran the following. */
export function topOutliers(all: Outlier[], n = 6): Outlier[] {
  return [...all]
    .filter((o) => o.hook && o.hook !== 'other')
    .sort((a, b) => Number(b.platform === 'instagram') - Number(a.platform === 'instagram') || b.viewsPerFollower - a.viewsPerFollower)
    .slice(0, n);
}

export function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

export function outlierLine(o: Pick<Outlier, 'handle' | 'platform' | 'views' | 'followers' | 'viewsPerFollower' | 'retrievedAt'>): string {
  const when = new Date(o.retrievedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const platform = o.platform === 'instagram' ? 'Instagram' : o.platform === 'tiktok' ? 'TikTok' : o.platform === 'youtube' ? 'YouTube Shorts' : o.platform;
  return `@${o.handle} on ${platform}: ${fmtCount(o.views)} views on ${fmtCount(o.followers)} followers (${o.viewsPerFollower}× their following), Viral Outliers trending feed, ${when}`;
}
