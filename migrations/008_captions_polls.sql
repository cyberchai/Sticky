-- Auto-captions: a version's caption settings (null = off), carried into later versions like overlays.
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS captions JSONB;
-- Timed words per clip, aligned once (src/captions.ts) and reused by every later version.
ALTER TABLE sticky.sources ADD COLUMN IF NOT EXISTS words JSONB;

-- The "want any of these?" poll after a first cut (src/polls.ts). iMessage polls are Linq's; browser
-- threads get the same options as chips. message_id is Linq's poll-definition message (or web-poll-<uuid>).
CREATE TABLE IF NOT EXISTS sticky.polls (
  message_id TEXT PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES sticky.projects(id),
  chat_id    TEXT NOT NULL,
  version_no INT NOT NULL,
  options    JSONB NOT NULL,       -- [{ optionId, label, instruction, applied }]
  how        TEXT NOT NULL CHECK (how IN ('poll','text','web')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS polls_project ON sticky.polls (project_id, created_at DESC);

-- One row per vote toggle, so a group's votes are auditable and an option is applied once.
CREATE TABLE IF NOT EXISTS sticky.poll_votes (
  id         BIGSERIAL PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES sticky.polls(message_id),
  option_id  TEXT NOT NULL,
  voter      TEXT,
  action     TEXT NOT NULL CHECK (action IN ('added','removed')),
  outcome    TEXT NOT NULL,        -- queued | already_applied | cancelled | ignored
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
