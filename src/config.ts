import 'dotenv/config';
import path from 'node:path';

const env = (key: string, fallback = ''): string => (process.env[key] ?? '').trim() || fallback;
const flag = (key: string): boolean => ['1', 'true', 'on', 'yes'].includes(env(key).toLowerCase());

export const config = {
  port: Number(env('PORT', '8787')),
  line: env('STICKY_LINE', '+14044471637'),
  linq: {
    apiBase: env('LINQ_API_BASE', 'https://api.linqapp.com/api/partner/v3'),
    apiKey: env('LINQ_API_KEY'),
    mediaHosts: env('LINQ_MEDIA_HOSTS', 'cdn.linqapp.com').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
  },
  gemini: {
    apiKey: env('GEMINI_API_KEY'),
    project: env('STICKY_GCP_PROJECT', env('GOOGLE_CLOUD_PROJECT')),
    location: env('STICKY_VERTEX_LOCATION', 'global'),
    videoModel: env('STICKY_VIDEO_MODEL_ID'),
    fallbackModel: env('STICKY_FALLBACK_MODEL_ID', 'gemini-3.8-flash'),
    textModel: env('STICKY_TEXT_MODEL_ID', 'gemini-3.5-flash-lite'),
    fps: Number(env('STICKY_VIDEO_FPS', '4')),
  },
  bucket: env('STICKY_BUCKET'),
  workDir: path.resolve(env('STICKY_WORK_DIR', '.data')),
  publicBaseUrl: env('STICKY_PUBLIC_BASE_URL').replace(/\/$/, ''),
  pushToken: env('STICKY_PUSH_TOKEN'),
  // Signing secret of Sticky's OWN Linq webhook subscription (phone_numbers = the Sticky line only).
  linqWebhookSecret: env('STICKY_LINQ_WEBHOOK_SECRET'),
  forwardSecret: env('STICKY_FORWARD_SECRET'),
  adminToken: env('STICKY_ADMIN_TOKEN'),
  collectWindowMs: Number(env('STICKY_COLLECT_MS', '5000')),
  echo: flag('STICKY_ECHO'),
  forceLink: flag('STICKY_FORCE_LINK'),
  trendsFetch: env('STICKY_TRENDS_FETCH', 'on').toLowerCase() !== 'off',
  /** Share Sticky's iMessage contact card into each chat (once a day) after the card is set up. */
  contactCard: flag('STICKY_CONTACT_CARD'),
};

/** "Today" for trend freshness. STICKY_TODAY lets the recovery test age every entry without touching data. */
export function today(): string {
  return env('STICKY_TODAY') || new Date().toISOString().slice(0, 10);
}

/** Product scope, in one place. */
export const LIMITS = {
  maxClips: 3,
  maxSourceMs: 60_000,
  /** A group's reel combines everyone's clips, so it takes more of them. */
  groupMaxClips: 6,
  groupMaxSourceMs: 90_000,
  defaultTargetMs: 12_000,
  minTotalMs: 6_000,
  maxTotalMs: 20_000,
  minSegmentMs: 400,
  maxSegments: 12,
  maxDownloadBytes: 100 * 1024 * 1024,
  freshDays: 14,
  snapshotTtlMs: 6 * 60 * 60 * 1000,
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The fixed reply copy (Sticky's product spec; Sticky is not the Asaply bot). */
export const COPY = {
  delivered: "Here's your reel. Text me a change if you want.",
  linkFallback: (url: string) => `Here's your reel: ${url}\nText me a change if you want.`,
  briefWaiting: 'Got it. Send the video.',
  kept: (n: number) => `Saved v${n}.`,
  newReel: 'Fresh start. Send the footage.',
  optedOut: "You're opted out. Text START to come back.",
  optedIn: "You're back in. Send a video.",
  tooMany: `I can cut up to ${3} videos at once. I kept the first three.`,
  tooLong: (s: number, maxS = 60) => `That's ${s}s of footage. I can cut up to ${maxS} seconds total. Send shorter clips?`,
  notVideo: 'Send me a video and I’ll cut it into a reel.',
  help: 'Text me a change to the cut, ask “Why this cut?”, or send new footage.',
  nothingYet: 'Nothing to explain yet. Send a video first.',
  failed: (stage: string) => `I couldn't finish that cut (${stage} failed). Your last cut is still above.`,
  failedFirst: (stage: string) => `I couldn't finish that cut (${stage} failed). Try sending the video again.`,
  unsupported: (reason: string) => `${reason} Your last cut is unchanged.`,
  generating: (label: string) => `There's no ${label} in your footage, so I'm generating one with Veo (AI-generated, about 30 seconds).`,
  generateFailed: (reason: string) => `I couldn't generate that shot (${reason}). Your last cut is unchanged.`,
  /** Group chats: name whose request a version answers, so a room of editors can follow along. */
  deliveredFor: (versionNo: number, who: string, said: string) =>
    `Here's v${versionNo} for ${who}: “${said.length > 80 ? `${said.slice(0, 77)}…` : said}”. Anyone here can text a change.`,
  groupHello: "Hi all, I'm Sticky. Send clips and I'll cut a reel. Anyone here can text a change or send a voice note.",
  groupClipIn: (who: string, clips: number, people: number) =>
    `Got ${who}'s clip (${plural(clips, 'clip')} from ${plural(people, 'person', 'people')} so far). Send more, or say “go ahead” and I'll cut everyone's footage into one reel.`,
  groupGoAhead: (clips: number, people: number) => `On it: cutting ${plural(clips, 'clip')} from ${plural(people, 'person', 'people')} into one reel.`,
  groupHeld: (said: string) => `Noted: “${said.length > 60 ? `${said.slice(0, 57)}…` : said}”. Say “go ahead” when everyone’s ready and I’ll make one version with everything.`,
  groupPicksHeld: 'Got it. Everyone can vote, then say “go ahead” and I’ll make one version with all the picks.',
  groupApplying: (n: number) => `On it: one version with ${plural(n, 'change')}.`,
  groupNothingNew: 'Everything picked is already in the cut. Text a change or vote, then say “go ahead”.',
  groupTooMany: `I can combine up to ${6} clips in a group reel. I kept the first six.`,
  groupStop: "To stop me in this group, remove me from the chat. I'll only answer messages meant for me.",
  /** Scan-to-join (invites.ts): the one-on-one answer to "Join group <code>". */
  groupJoinWaiting: (name: string) => `You're in “${name}”. I'll start the group chat as soon as one more person joins.`,
  groupJoined: (name: string) => `You're in “${name}”. Look for the group chat in Messages.`,
  groupJoinAlready: (name: string) => `You're already in “${name}”. Look for the group chat in Messages.`,
  groupJoinByHand: (name: string) => `You're in “${name}”. You'll be added to the group chat shortly.`,
  heard: (text: string) => `Heard: “${text}”`,
  addedPeople: (r: { added: string[]; already: string[]; full: string[]; used: number; limit: number; link: string }) => [
    r.added.length ? `Added ${r.added.join(', ')}.` : '',
    r.already.length ? `${r.already.join(', ')} ${r.already.length === 1 ? 'was' : 'were'} already on.` : '',
    r.full.length ? `No room for ${r.full.join(', ')}: this free line holds ${r.limit} people.` : '',
    `${r.used}/${r.limit} spots used.`,
    r.added.length ? `Each of them needs to text me once before I can reply. One tap: ${r.link}` : '',
  ].filter(Boolean).join(' '),
  groupRosterAdded: (r: { added: number; full: number; link: string; limit: number }) => [
    r.added ? `I added the ${r.added} other ${r.added === 1 ? 'person' : 'people'} in your group chat.` : '',
    r.full ? `${r.full} didn't fit: this free line holds ${r.limit} people.` : '',
    `Before I can post in the group, each of them has to text me once. Forward them this: ${r.link}`,
  ].filter(Boolean).join(' '),
  voiceFailed: "I couldn't make out that voice note. Mind trying again or typing it?",
  scoring: (label: string) => `Scoring your reel with AI music (Lyria): ${label}. About 30 seconds; your original audio stays on top.`,
  scoreFailed: (reason: string) => `I couldn't make that music (${reason}). The cut keeps its current sound.`,
  editing: (label: string) => `Editing your footage with Gemini Omni: ${label} (AI-edited, about a minute). Your original audio stays.`,
  editFailed: (reason: string) => `I couldn't make that visual edit (${reason}). Your last cut is unchanged.`,
};
