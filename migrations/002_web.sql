-- The browser channel: a web thread is a chat whose id starts with "web:". Its replies land here
-- instead of in iMessage. Clip file names are kept for both channels.
CREATE TABLE IF NOT EXISTS sticky.web_messages (
  id         BIGSERIAL PRIMARY KEY,
  chat_id    TEXT NOT NULL,
  body       TEXT NOT NULL,
  version_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_messages_chat ON sticky.web_messages (chat_id, id);

ALTER TABLE sticky.sources ADD COLUMN IF NOT EXISTS name TEXT;
