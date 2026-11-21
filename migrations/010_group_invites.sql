-- Scan-to-join group chats. A host makes an invite on /join; each person who scans /join/g/<code> is put on
-- the line's list, then texts "Join group <code>" (that first text is what lets Sticky reach them). The
-- second person's text starts the iMessage group (Linq needs two others besides Sticky); later ones are
-- added to it.
CREATE TABLE IF NOT EXISTS sticky.group_invites (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  -- The Linq group chat, once two people are in.
  chat_id    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sticky.group_invite_members (
  code         TEXT NOT NULL REFERENCES sticky.group_invites(code),
  phone        TEXT NOT NULL,
  -- Added their number on the page.
  signed_up_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Texted Sticky, so Sticky can now reach them.
  texted_at    TIMESTAMPTZ,
  -- In the group chat.
  added_at     TIMESTAMPTZ,
  error        TEXT,
  PRIMARY KEY (code, phone)
);
CREATE INDEX IF NOT EXISTS group_invite_members_phone ON sticky.group_invite_members (phone, signed_up_at DESC);
