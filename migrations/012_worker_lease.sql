-- One worker claims work at a time: the newest instance to start. Cloud Run keeps a replaced revision's
-- instance alive for minutes after a deploy; without this its worker kept claiming jobs with the old code.
CREATE TABLE IF NOT EXISTS sticky.worker_lease (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner TEXT NOT NULL,
  beat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
