-- ADD-ONLY DRAFT — apply only after explicit approval.
-- Stores per-match, provider-verified statistics for the separately verified
-- history path. A row is written only when two independent captures of the same
-- provider endpoint agree (identical canonical hash) and the match identity,
-- kickoff and score already exist in mam_verified_history_matches.
-- No legacy rows are copied, updated, deleted, or backfilled by this migration.
CREATE TABLE IF NOT EXISTS mam_verified_history_statistics (
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_fixture_id TEXT NOT NULL CHECK (length(trim(provider_fixture_id)) > 0),
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  metric TEXT NOT NULL CHECK (length(trim(metric)) > 0),
  value REAL NOT NULL CHECK (value >= 0),
  unit TEXT,
  provider_metric TEXT NOT NULL CHECK (length(trim(provider_metric)) > 0),
  capture_hash_a TEXT NOT NULL CHECK (length(capture_hash_a) = 64),
  capture_hash_b TEXT NOT NULL CHECK (length(capture_hash_b) = 64),
  source_url TEXT NOT NULL CHECK (length(trim(source_url)) > 0),
  verified INTEGER NOT NULL CHECK (verified = 1),
  verified_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_fixture_id, team_id, metric),
  CHECK (capture_hash_a = capture_hash_b)
);
CREATE INDEX IF NOT EXISTS mam_verified_history_statistics_team
  ON mam_verified_history_statistics(team_id, metric);
