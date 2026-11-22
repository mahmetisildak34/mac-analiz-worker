-- Apply ONLY to a new, isolated test D1/SQLite database.
-- No migration of existing production or preview databases.
CREATE TABLE IF NOT EXISTS isolated_prediction_evidence (
 fixture_id TEXT PRIMARY KEY NOT NULL,
 league_id TEXT NOT NULL,
 kickoff TEXT NOT NULL,
 recorded_at TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 CHECK(recorded_at < kickoff)
);
CREATE TABLE IF NOT EXISTS isolated_verified_results (
 fixture_id TEXT PRIMARY KEY NOT NULL REFERENCES isolated_prediction_evidence(fixture_id),
 verified_at TEXT NOT NULL,
 evidence_id TEXT NOT NULL,
 sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json))
);
CREATE TRIGGER IF NOT EXISTS isolated_predictions_no_update
 BEFORE UPDATE ON isolated_prediction_evidence BEGIN SELECT RAISE(ABORT,'immutable prediction'); END;
CREATE TRIGGER IF NOT EXISTS isolated_predictions_no_delete
 BEFORE DELETE ON isolated_prediction_evidence BEGIN SELECT RAISE(ABORT,'immutable prediction'); END;
CREATE TRIGGER IF NOT EXISTS isolated_results_no_update
 BEFORE UPDATE ON isolated_verified_results BEGIN SELECT RAISE(ABORT,'immutable result'); END;
CREATE TRIGGER IF NOT EXISTS isolated_results_no_delete
 BEFORE DELETE ON isolated_verified_results BEGIN SELECT RAISE(ABORT,'immutable result'); END;
