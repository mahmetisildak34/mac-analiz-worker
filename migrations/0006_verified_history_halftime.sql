-- ADD-ONLY DRAFT — apply only after explicit approval.
-- Stores the separately verified halftime score next to the verified history
-- row so the B data-center payloads keep the half-time markets (first/second
-- half over/under, half-time both teams to score) that the legacy archive path
-- already exposes. A side table keeps the migration idempotent on SQLite
-- (ALTER TABLE ADD COLUMN cannot be re-run safely) and leaves the existing
-- mam_verified_history_matches definition untouched.
-- No row is updated or deleted here; values are written only by a separate,
-- explicitly approved verification backfill. The adapter validates
-- 0 <= halftime <= full-time score before using a value.
-- Integrity note: a verified fixture can legitimately have one history row per
-- selected team, so (provider, fixture) is not unique and a composite foreign
-- key to mam_verified_history_matches is impossible. The adapter reads these
-- values only through a verified history row (correlated subquery), so a row
-- without a verified match is never used; team_id still references the identity
-- table.
CREATE TABLE IF NOT EXISTS mam_verified_history_halftime (
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_fixture_id TEXT NOT NULL CHECK (length(trim(provider_fixture_id)) > 0),
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  halftime_home INTEGER NOT NULL CHECK (halftime_home >= 0),
  halftime_away INTEGER NOT NULL CHECK (halftime_away >= 0),
  verified INTEGER NOT NULL CHECK (verified = 1),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  verified_at TEXT NOT NULL,
  PRIMARY KEY (provider, provider_fixture_id, team_id)
);
