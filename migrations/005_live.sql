-- Live sessions: a reel opened in the browser by its host and anyone they invite (camera, pointing,
-- voice commands, notes). Idempotent like every migration; triggers keep src/jobs.ts untouched.

-- The guest link (/live/<live_token>) and the host's key (host-only actions: finish, contacts, phone).
ALTER TABLE sticky.projects ADD COLUMN IF NOT EXISTS live_token TEXT;
ALTER TABLE sticky.projects ADD COLUMN IF NOT EXISTS host_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS projects_live_token ON sticky.projects (live_token) WHERE live_token IS NOT NULL;
-- Where a browser host's final cut is texted. Not threads.phone: for web threads that holds the sender
-- handle ("web") and is rewritten on every message.
ALTER TABLE sticky.threads ADD COLUMN IF NOT EXISTS notify_phone TEXT;

-- Anyone who has joined a live session, or a contact a host added. `id` is the browser's secret
-- (localStorage); `handle` is the public id used in mentions, presence and authorship.
CREATE TABLE IF NOT EXISTS sticky.people (
  id         TEXT PRIMARY KEY,
  handle     TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A host's network: people who edited with them or whom they added. Keyed by the host's thread.
CREATE TABLE IF NOT EXISTS sticky.network (
  owner_chat_id TEXT NOT NULL,
  person_id     TEXT NOT NULL REFERENCES sticky.people(id),
  added_via     TEXT NOT NULL CHECK (added_via IN ('session','contact')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_chat_id, person_id)
);

-- Notes pinned to a moment (and optionally a spot) of a version, with tagged people.
CREATE TABLE IF NOT EXISTS sticky.notes (
  id            BIGSERIAL PRIMARY KEY,
  project_id    UUID NOT NULL REFERENCES sticky.projects(id),
  version_no    INT,
  author_handle TEXT NOT NULL,
  author_name   TEXT NOT NULL,
  body          TEXT NOT NULL,
  mentions      TEXT[] NOT NULL DEFAULT '{}',   -- people.handle
  at_ms         INT,
  x             REAL,
  y             REAL,
  notified      JSONB NOT NULL DEFAULT '{}',    -- handle → texted | no_phone | failed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_project ON sticky.notes (project_id, id);

-- Who is in the room right now (one row per browser tab), swept when heartbeats stop.
CREATE TABLE IF NOT EXISTS sticky.live_presence (
  peer_id    TEXT PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES sticky.projects(id),
  handle     TEXT NOT NULL,
  name       TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('host','guest')),
  color      TEXT NOT NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_presence_project ON sticky.live_presence (project_id);

-- Room events (WebRTC signaling, commands, Sticky's replies). Rows + NOTIFY so every instance fans
-- them out to its own SSE subscribers, and a reconnecting browser replays what it missed.
CREATE TABLE IF NOT EXISTS sticky.live_events (
  id         BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL,
  to_peer    TEXT,
  from_peer  TEXT,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS live_events_project ON sticky.live_events (project_id, id);

-- Version history: who asked for each version, from where, pointing at what, and which version it changed.
ALTER TABLE sticky.jobs ADD COLUMN IF NOT EXISTS channel TEXT;      -- sms | web | live (NULL = derived from the chat)
ALTER TABLE sticky.jobs ADD COLUMN IF NOT EXISTS author_handle TEXT;
ALTER TABLE sticky.jobs ADD COLUMN IF NOT EXISTS author_name TEXT;
ALTER TABLE sticky.jobs ADD COLUMN IF NOT EXISTS anchor JSONB;      -- {said, versionNo, atMs, x, y, where, segmentId}
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS channel TEXT;
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS author_handle TEXT;
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS author_name TEXT;
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS anchor JSONB;
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS parent_version_no INT;
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS final_sent_at TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION sticky.version_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE j RECORD;
BEGIN
  SELECT jb.kind, jb.channel, jb.author_handle, jb.author_name, jb.anchor, p.chat_id
    INTO j FROM sticky.jobs jb JOIN sticky.projects p ON p.id = jb.project_id WHERE jb.id = NEW.job_id;
  NEW.channel := COALESCE(NEW.channel, j.channel, CASE WHEN j.chat_id LIKE 'web:%' THEN 'web' ELSE 'sms' END);
  NEW.author_handle := COALESCE(NEW.author_handle, j.author_handle);
  NEW.author_name := COALESCE(NEW.author_name, j.author_name);
  NEW.anchor := COALESCE(NEW.anchor, j.anchor);
  -- A revision changes the newest version that was shown (the same row jobs.ts revises from).
  IF NEW.parent_version_no IS NULL AND j.kind = 'revise' THEN
    SELECT max(v.version_no) INTO NEW.parent_version_no FROM sticky.versions v
     WHERE v.project_id = NEW.project_id AND v.version_no < NEW.version_no AND v.delivery NOT IN ('superseded','failed','pending');
  END IF;
  RETURN NEW;
END $$;

-- Job and version progress reaches live sessions without the worker knowing about them.
CREATE OR REPLACE FUNCTION sticky.live_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('sticky_live_state', NEW.project_id::text);
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'versions_lineage') THEN
    CREATE TRIGGER versions_lineage BEFORE INSERT ON sticky.versions FOR EACH ROW EXECUTE FUNCTION sticky.version_lineage();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'versions_live_touch') THEN
    CREATE TRIGGER versions_live_touch AFTER INSERT OR UPDATE ON sticky.versions FOR EACH ROW EXECUTE FUNCTION sticky.live_touch();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'jobs_live_touch') THEN
    CREATE TRIGGER jobs_live_touch AFTER INSERT OR UPDATE ON sticky.jobs FOR EACH ROW EXECUTE FUNCTION sticky.live_touch();
  END IF;
END $$;

-- Versions made before lineage existed: say where they came from.
UPDATE sticky.versions v SET channel = CASE WHEN p.chat_id LIKE 'web:%' THEN 'web' ELSE 'sms' END
  FROM sticky.projects p WHERE p.id = v.project_id AND v.channel IS NULL;
