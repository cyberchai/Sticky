-- Sticky: one schema, nothing shared with Asaply. Idempotent.
CREATE SCHEMA IF NOT EXISTS sticky;

-- Every inbound Linq event, keyed by the provider's webhook id: replays and Pub/Sub redeliveries
-- land on the primary key and do nothing.
CREATE TABLE IF NOT EXISTS sticky.events (
  provider_event_id TEXT PRIMARY KEY,
  chat_id           TEXT,
  kind              TEXT NOT NULL,            -- video | text | receipt | other
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  handled_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_unhandled ON sticky.events (received_at) WHERE handled_at IS NULL AND kind = 'text';

CREATE TABLE IF NOT EXISTS sticky.threads (
  chat_id            TEXT PRIMARY KEY,
  line               TEXT,
  phone              TEXT,
  opted_out          BOOLEAN NOT NULL DEFAULT false,
  current_project_id UUID,
  pending_direction  TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sticky.projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id          TEXT NOT NULL REFERENCES sticky.threads(chat_id),
  state            TEXT NOT NULL CHECK (state IN ('collecting','queued','rendering','delivered','failed','closed')),
  collect_deadline TIMESTAMPTZ,
  direction        TEXT[] NOT NULL DEFAULT '{}',
  analysis         JSONB,                      -- v1 transcript + moments, reused by revisions
  kept_version     INT,
  last_inbound_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS projects_collecting ON sticky.projects (collect_deadline) WHERE state = 'collecting';

CREATE TABLE IF NOT EXISTS sticky.sources (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES sticky.projects(id),
  clip_id             TEXT NOT NULL,           -- c1..c3, stable for the project
  provider_message_id TEXT NOT NULL,
  part_id             TEXT NOT NULL,
  url                 TEXT NOT NULL,
  mime                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','downloading','normalized','failed')),
  attempts            INT NOT NULL DEFAULT 0,
  original_key        TEXT,
  norm_key            TEXT,
  proxy_key           TEXT,
  duration_ms         INT,
  has_audio           BOOLEAN,
  width               INT,
  height              INT,
  color_transfer      TEXT,
  followup            BOOLEAN NOT NULL DEFAULT false,
  timings             JSONB NOT NULL DEFAULT '{}',
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_message_id, part_id),
  UNIQUE (project_id, clip_id)
);

CREATE TABLE IF NOT EXISTS sticky.jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES sticky.projects(id),
  kind        TEXT NOT NULL CHECK (kind IN ('v1','revise')),
  direction   TEXT,
  status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','superseded')),
  attempts    INT NOT NULL DEFAULT 0,
  claimed_at  TIMESTAMPTZ,
  stage       TEXT,
  stage_ms    JSONB NOT NULL DEFAULT '{}',
  model       TEXT,
  version_no  INT,
  error       TEXT,
  inbound_at  TIMESTAMPTZ NOT NULL DEFAULT now(),  -- the last inbound that caused this job (latency clock)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
-- One running job per project: edits to a project are serialized by the database.
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_running ON sticky.jobs (project_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_queued ON sticky.jobs (created_at) WHERE status = 'queued';

CREATE TABLE IF NOT EXISTS sticky.versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL REFERENCES sticky.projects(id),
  version_no          INT NOT NULL,
  job_id              UUID NOT NULL UNIQUE REFERENCES sticky.jobs(id),
  segments            JSONB NOT NULL,
  technique           JSONB NOT NULL,
  explanation         TEXT NOT NULL,
  direction           TEXT,
  out_key             TEXT NOT NULL,
  link_token          TEXT NOT NULL UNIQUE,
  duration_ms         INT NOT NULL,
  delivery            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (delivery IN ('pending','sending','accepted','delivered','failed','link_degraded','superseded')),
  provider_message_id TEXT,
  accepted_at         TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  kept                BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, version_no)
);
CREATE INDEX IF NOT EXISTS versions_provider_message ON sticky.versions (provider_message_id);
