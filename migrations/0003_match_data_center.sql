-- ADD-ONLY DRAFT — apply only after explicit production-migration approval.
-- B stores immutable prepared payloads and a small active-generation pointer.
-- Live match/archive behavior remains owned by the existing five-minute Worker path.
CREATE TABLE IF NOT EXISTS mam_b_payloads (
  payload_hash TEXT PRIMARY KEY CHECK (length(payload_hash) = 64),
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mam_b_generations (
  generation_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staging', 'active', 'retired', 'failed')),
  manifest_json TEXT NOT NULL,
  failure_reason TEXT
);

CREATE TABLE IF NOT EXISTS mam_b_generation_items (
  generation_id TEXT NOT NULL REFERENCES mam_b_generations(generation_id) ON DELETE CASCADE,
  item_key TEXT NOT NULL,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('fixture', 'team_analysis')),
  readiness TEXT NOT NULL CHECK (readiness = 'analysis_ready'),
  payload_hash TEXT NOT NULL REFERENCES mam_b_payloads(payload_hash) ON DELETE RESTRICT,
  PRIMARY KEY (generation_id, item_key)
);
CREATE INDEX IF NOT EXISTS mam_b_generation_items_by_kind
  ON mam_b_generation_items(generation_id, item_kind, readiness);

CREATE TABLE IF NOT EXISTS mam_b_active_generation (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  generation_id TEXT NOT NULL REFERENCES mam_b_generations(generation_id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mam_b_live_overlay (
  fixture_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('live', 'completed')),
  observed_at TEXT NOT NULL,
  home_score INTEGER NOT NULL CHECK (home_score >= 0),
  away_score INTEGER NOT NULL CHECK (away_score >= 0),
  minute_label TEXT,
  elapsed_seconds INTEGER CHECK (elapsed_seconds IS NULL OR elapsed_seconds >= 0),
  clock_precise INTEGER NOT NULL CHECK (clock_precise IN (0, 1)),
  statistics_json TEXT NOT NULL,
  CHECK ((clock_precise = 1 AND elapsed_seconds IS NOT NULL) OR
         (clock_precise = 0 AND elapsed_seconds IS NULL))
);
