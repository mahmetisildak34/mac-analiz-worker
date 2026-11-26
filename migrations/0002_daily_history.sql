-- ADD-ONLY DRAFT — apply only after explicit production-migration approval.
-- Stores separately verified completed-history references and bounded retry state.
-- This migration has no DML/backfill and never alters `matches`.
CREATE TABLE IF NOT EXISTS mam_verified_history_matches (
  provider TEXT NOT NULL,
  provider_fixture_id TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  opponent_team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  kickoff TEXT NOT NULL,
  competition_id TEXT NOT NULL,
  home_team_id TEXT NOT NULL,
  away_team_id TEXT NOT NULL,
  home_score INTEGER NOT NULL CHECK (home_score >= 0),
  away_score INTEGER NOT NULL CHECK (away_score >= 0),
  status TEXT NOT NULL CHECK (status = 'completed'),
  verified INTEGER NOT NULL CHECK (verified = 1),
  source TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_fixture_id, team_id),
  CHECK (team_id <> opponent_team_id)
);
CREATE INDEX IF NOT EXISTS mam_verified_history_by_team_date
  ON mam_verified_history_matches(team_id, kickoff DESC);

CREATE TABLE IF NOT EXISTS mam_daily_history_retry_state (
  query_key TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 2),
  next_attempt_at TEXT,
  last_error TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'exhausted', 'resolved')),
  updated_at TEXT NOT NULL
);
