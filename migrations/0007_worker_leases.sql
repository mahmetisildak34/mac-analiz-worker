-- ADD-ONLY DRAFT — apply only in isolated Preview after explicit scope confirmation.
-- One row per logical Worker job. Acquisition is an atomic INSERT/UPDATE CAS;
-- expired leases may be reclaimed, active leases cannot be stolen.
CREATE TABLE IF NOT EXISTS mam_worker_leases (
  lease_key TEXT PRIMARY KEY CHECK (length(trim(lease_key)) > 0),
  owner_token TEXT NOT NULL CHECK (length(trim(owner_token)) > 0),
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (expires_at > acquired_at)
);
CREATE INDEX IF NOT EXISTS mam_worker_leases_expiry
  ON mam_worker_leases(expires_at);
