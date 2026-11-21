-- Group chats make one reel from everyone's footage: who sent each clip, so the cut can use every
-- person's clip. A group project holds its clips (collect_deadline NULL) until someone says "go ahead".
ALTER TABLE sticky.sources ADD COLUMN IF NOT EXISTS author_handle TEXT;
-- Changes a group asked for (poll picks and texted edits) after a cut, held until someone says
-- "go ahead"; then they go out together as one version instead of one version each.
ALTER TABLE sticky.projects ADD COLUMN IF NOT EXISTS held_notes TEXT[] NOT NULL DEFAULT '{}';
