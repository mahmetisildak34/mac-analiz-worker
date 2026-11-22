-- Isolated statistics acceptance only. NEVER execute against production or preview D1.
-- Apply solely to mam-statistics-isolated-test (fb9b42cc-8d96-4911-b193-0983527ee593).
-- Does not alter the existing mam_archive_test_* tables.
CREATE TABLE IF NOT EXISTS matches (
  source TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  kickoff TEXT NOT NULL,
  status TEXT NOT NULL,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  home_goals INTEGER,
  away_goals INTEGER,
  statistics_json TEXT,
  raw_json TEXT,
  PRIMARY KEY (source, fixture_id)
);

-- Isolated test quota ledger; shared by all isolated provider requests.
-- Do not install in or modify production/preview databases.
CREATE TABLE IF NOT EXISTS mam_api_quota_guard (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0),
  minute_last_ms INTEGER NOT NULL DEFAULT 0
);
