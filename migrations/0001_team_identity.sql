-- ADD-ONLY DRAFT — apply only after explicit production-migration approval.
-- Creates identity/link/review structures separately from the legacy `matches` archive.
-- No legacy rows are copied, updated, deleted, or backfilled by this migration.
CREATE TABLE IF NOT EXISTS mam_team_identities (
  team_id TEXT PRIMARY KEY CHECK (length(trim(team_id)) > 0),
  country_code TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycle_status IN ('active', 'inactive')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mam_team_names (
  name_id TEXT PRIMARY KEY CHECK (length(trim(name_id)) > 0),
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  name_type TEXT NOT NULL CHECK (name_type IN ('current', 'former', 'alternate')),
  verified INTEGER NOT NULL DEFAULT 1 CHECK (verified = 1),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  verified_at TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (length(trim(approved_by)) > 0),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  UNIQUE (team_id, normalized_name, valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS mam_team_names_one_current
  ON mam_team_names(team_id)
  WHERE name_type = 'current' AND valid_to IS NULL;
CREATE INDEX IF NOT EXISTS mam_team_names_lookup
  ON mam_team_names(normalized_name, verified, valid_from, valid_to);

CREATE TABLE IF NOT EXISTS mam_team_provider_ids (
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_team_id TEXT NOT NULL CHECK (length(trim(provider_team_id)) > 0),
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  verified INTEGER NOT NULL DEFAULT 1 CHECK (verified = 1),
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  verified_at TEXT NOT NULL,
  approved_by TEXT NOT NULL CHECK (length(trim(approved_by)) > 0),
  CHECK (valid_to IS NULL OR valid_to > valid_from),
  PRIMARY KEY (provider, provider_team_id, valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS mam_team_provider_ids_one_active
  ON mam_team_provider_ids(provider, provider_team_id)
  WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS mam_team_provider_ids_lookup
  ON mam_team_provider_ids(provider, provider_team_id, valid_from, valid_to);

-- Deliberately not foreign-keyed to legacy matches: old archive rows remain untouched.
CREATE TABLE IF NOT EXISTS mam_team_match_links (
  provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
  provider_fixture_id TEXT NOT NULL CHECK (length(trim(provider_fixture_id)) > 0),
  side TEXT NOT NULL CHECK (side IN ('home', 'away')),
  match_date TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  provider_team_id TEXT,
  raw_team_name TEXT NOT NULL CHECK (length(trim(raw_team_name)) > 0),
  verified_at TEXT NOT NULL,
  verification_source TEXT NOT NULL CHECK (length(trim(verification_source)) > 0),
  approved_by TEXT NOT NULL CHECK (length(trim(approved_by)) > 0),
  PRIMARY KEY (provider, provider_fixture_id, side)
);
CREATE INDEX IF NOT EXISTS mam_team_match_links_history
  ON mam_team_match_links(team_id, match_date);

CREATE TABLE IF NOT EXISTS mam_team_identity_review_queue (
  candidate_key TEXT PRIMARY KEY CHECK (length(trim(candidate_key)) > 0),
  provider TEXT,
  provider_team_id TEXT,
  raw_name TEXT NOT NULL CHECK (length(trim(raw_name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  country_code TEXT,
  competition_id TEXT,
  suggested_team_id TEXT REFERENCES mam_team_identities(team_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  CHECK ((status = 'pending' AND reviewed_at IS NULL AND reviewed_by IS NULL) OR
         (status IN ('approved', 'rejected') AND reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS mam_team_identity_review_pending
  ON mam_team_identity_review_queue(status, created_at);
