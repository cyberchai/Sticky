-- AI music bed (Lyria): the project's current music carries into every later version until removed.
ALTER TABLE sticky.projects ADD COLUMN IF NOT EXISTS music JSONB;
ALTER TABLE sticky.versions ADD COLUMN IF NOT EXISTS music JSONB;
