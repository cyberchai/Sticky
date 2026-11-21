# Sticky

Text raw footage to the Sticky iMessage number and get back a trend-informed Reel.

Two ways in, one pipeline:

```
iPhone  → Sticky's own Linq Sandbox line (+1 205 503 0508) → POST /webhooks/linq (signed)
Browser → https://sticky-editor-1097661752215.us-central1.run.app (chunked upload) → same Linq-shaped event
      → Postgres rows (persist before ack) → 1s ticker: download/pick up → normalize → 5s window
      → Gemini 4 Argon (one multimodal call) → validated EDL → FFmpeg → ffprobe
      → iMessage: Linq upload into the same chat · Browser: version appears in the page
```

Nothing is shared with Asaply: separate Linq account and key, separate GCP project
(`gemini4nyc26nyc-2243`, never Asaply billing), no core-api code. The sandbox line only replies to
contacts who were added (`npx @linqapp/cli contacts add +1…`, max 20) and texted first; it expires 2026-11-28.

## Run

```bash
cp .env.example .env               # fill names; never commit values
npm i
npm run dev                        # boots, migrates, starts the worker on :8787
cloudflared tunnel --url http://localhost:8787   # then point the push subscription at it
```

Local Postgres without touching the system: `initdb -D .data/pg -U sticky --auth=trust && pg_ctl -D .data/pg -o "-p 5433 -k /tmp" start && createdb -h localhost -p 5433 -U sticky sticky`, then `DATABASE_URL=postgres://sticky@localhost:5433/sticky`.
`./buildandrundev` does all of that (local Postgres, local disk, worker on) and opens the page; add `--gcs` for Omni edits.

## Text, stickers, transitions

Ask in any channel ("put 'Animalliyah' on it", "a 🔥 on the last shot", "crossfade between every shot").
Revisions return overlays (text in four styles, emoji stickers from Noto Emoji, fade/pop/slide entrances) and
transitions (ffmpeg xfade presets: crossfade, dissolve, dip to black/white, slides, wipe, zoom, circle, whip).
Both are keyed by shot id and carry into later versions. Text is drawn with sharp/Pango and the bundled Poppins
(`assets/fonts`, OFL) and burned in with ffmpeg's overlay filter, so it works without `drawtext`.

## Live sessions

"Edit live with your team" on a reel (or the link in the first texted cut) opens `/live/<token>`: everyone joins
with camera and mic (WebRTC, peer to peer), points at the reel with a tracked hand (MediaPipe) or a click, and says
"Sticky, add a dog here" (or holds Space). The pointed frame is grounded by Gemini into a scene phrase that rides
into the normal revise job, so Omni puts the change at that spot. Notes pin to a moment and tag people in the
host's network (texted when they have a phone). Versions made live aren't texted; the host's **Finish** texts the
chosen cut (back into the iMessage thread, or to the browser host's phone). Every version records its channel,
author, pointed spot and parent version. `STICKY_ICE_SERVERS` (JSON) adds a TURN server for strict networks.

## Checks

| Command | What it proves |
|---|---|
| `npm test` | EDL validation/ops, trend freshness/ranking, page date parsing |
| `npx tsx scripts/render-smoke.ts [clip]` | normalize (portrait + landscape-silent) → cut with a mute → ffprobe; prints mute volume |
| `npm run linq:check -- --to +1…` | number status + a known-good MP4 sent from the Sticky line |
| `npm run probe:gemini -- clip.MOV` | model access, timestamp quality, HDR detection |
| `npm run trends:prime [-- --dry]` | live trend pages → snapshot; `--dry` parses only |
| `npx tsx scripts/sim-event.ts video|text …` | a forwarded Linq event without a phone |
| `npm run replay -- <eventId>` | webhook replay is a no-op |

## Operate

`GET /admin/runs`, `/admin/latest`, `/admin/projects/:id`, `/admin/trends` (Bearer `STICKY_ADMIN_TOKEN`) show stage timings, the exact
EDL and technique per version, delivery state, and inbound→delivered latency. Logs are `[sticky:<area>] key=value`.

Switches: `STICKY_ECHO=1` (send the normalized clip straight back; first round-trip test), `STICKY_FORCE_LINK=1`
(exercise the tap-to-play fallback), `STICKY_TRENDS_FETCH=off` (sources down), `STICKY_TODAY=YYYY-MM-DD` (age the evidence).
