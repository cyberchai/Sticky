-- The host's key for a scan-to-join invite. Only the laptop that made the invite sees the joiners' numbers,
-- so the host can add them to a group chat by hand when Linq can't. The group link is on a public QR, so
-- the code alone must never reveal anyone's number.
ALTER TABLE sticky.group_invites ADD COLUMN IF NOT EXISTS host_key TEXT;
