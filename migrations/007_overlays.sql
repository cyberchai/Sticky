-- Text and stickers over a version (src/overlays.ts) and transitions between its shots (src/transitions.ts).
-- Both are keyed by shot id and carry into later versions until changed.
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS overlays JSONB NOT NULL DEFAULT '[]';
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS transitions JSONB NOT NULL DEFAULT '[]';
