-- Group chats and the contact card: which threads are groups, whether Sticky said hello there, and when
-- its contact card was last shared into the chat (Linq: at most once a day is useful).
ALTER TABLE sticky.threads ADD COLUMN IF NOT EXISTS is_group BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sticky.threads ADD COLUMN IF NOT EXISTS greeted_at TIMESTAMPTZ;
ALTER TABLE sticky.threads ADD COLUMN IF NOT EXISTS card_shared_at TIMESTAMPTZ;
