-- Add-only audit and daily budget tables for server-verified final-score corrections.
CREATE TABLE IF NOT EXISTS mam_archive_corrections (
  source TEXT NOT NULL,
  fixture_id TEXT NOT NULL,
  league_id TEXT NOT NULL,
  old_status TEXT,
  old_home_goals INTEGER,
  old_away_goals INTEGER,
  new_status TEXT NOT NULL,
  new_home_goals INTEGER NOT NULL,
  new_away_goals INTEGER NOT NULL,
  evidence_json TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (source, fixture_id)
);
CREATE TABLE IF NOT EXISTS mam_archive_verify_quota (
  day TEXT PRIMARY KEY,
  used INTEGER NOT NULL DEFAULT 0
);
