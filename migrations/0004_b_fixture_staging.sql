-- ADD-ONLY DRAFT — verified scheduled fixtures may be staged outside the legacy archive.
-- The B preparation adapter reads this table in addition to (never instead of) `matches`.
-- No legacy rows are copied, updated, deleted, or backfilled by this migration.
CREATE TABLE IF NOT EXISTS mam_b_fixture_staging (
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_fixture_id TEXT NOT NULL CHECK (length(trim(provider_fixture_id)) > 0),
  competition_id TEXT NOT NULL CHECK (length(trim(competition_id)) > 0),
  kickoff TEXT NOT NULL CHECK (datetime(kickoff) IS NOT NULL),
  status TEXT NOT NULL CHECK (status = 'scheduled'),
  home_provider_team_id TEXT NOT NULL CHECK (length(trim(home_provider_team_id)) > 0),
  home_team_name TEXT NOT NULL CHECK (length(trim(home_team_name)) > 0),
  home_country_code TEXT NOT NULL DEFAULT '',
  away_provider_team_id TEXT NOT NULL CHECK (length(trim(away_provider_team_id)) > 0),
  away_team_name TEXT NOT NULL CHECK (length(trim(away_team_name)) > 0),
  away_country_code TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL CHECK (verified = 1),
  verification_source TEXT NOT NULL CHECK (length(trim(verification_source)) > 0),
  verified_at TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (length(trim(approved_by)) > 0),
  PRIMARY KEY (provider, provider_fixture_id),
  CHECK (home_provider_team_id <> away_provider_team_id)
);
CREATE INDEX IF NOT EXISTS mam_b_fixture_staging_status_kickoff
  ON mam_b_fixture_staging(status, kickoff);
