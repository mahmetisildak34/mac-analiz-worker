CREATE TABLE IF NOT EXISTS mam_memberships (
  user_id TEXT PRIMARY KEY,
  tier TEXT NOT NULL CHECK (tier IN ('PREMIUM')),
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS mam_memberships_expiry_idx
  ON mam_memberships (tier, ends_at);

CREATE TABLE IF NOT EXISTS mam_user_daily_analyses (
  user_id TEXT NOT NULL,
  day_tr TEXT NOT NULL,
  match_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, day_tr, match_key)
);

CREATE INDEX IF NOT EXISTS mam_user_daily_analyses_day_idx
  ON mam_user_daily_analyses (user_id, day_tr);
