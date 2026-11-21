-- Generated inserts (Veo): a source the user did not film, always labeled as AI-generated.
ALTER TABLE sticky.sources ADD COLUMN IF NOT EXISTS generated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE sticky.sources ADD COLUMN IF NOT EXISTS gen_prompt TEXT;
