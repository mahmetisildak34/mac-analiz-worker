import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const migration = fileURLToPath(new URL("../migrations/20261124_membership.sql", import.meta.url));

test("membership migration creates isolated membership, quota and coupon tables in memory-only SQLite", () => {
  const script = String.raw`
import json, sqlite3, sys
sql = open(sys.argv[1], encoding="utf-8").read()
db = sqlite3.connect(":memory:")
db.executescript(sql)
db.execute("INSERT INTO mam_memberships(user_id,tier,starts_at,ends_at) VALUES(?,?,?,?)", ("premium-user", "PREMIUM", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"))
try:
    db.execute("INSERT INTO mam_memberships(user_id,tier,starts_at) VALUES(?,?,?)", ("free-user", "ADMIN", "2026-01-01T00:00:00Z"))
    raise AssertionError("membership tier constraint accepted ADMIN")
except sqlite3.IntegrityError:
    pass
db.execute("INSERT INTO mam_user_daily_analyses(user_id,day_tr,match_key) VALUES(?,?,?)", ("premium-user", "2026-11-25", "match:one"))
try:
    db.execute("INSERT INTO mam_user_daily_analyses(user_id,day_tr,match_key) VALUES(?,?,?)", ("premium-user", "2026-11-25", "match:one"))
    raise AssertionError("daily match uniqueness constraint failed")
except sqlite3.IntegrityError:
    pass
db.execute("INSERT INTO mam_user_coupons(user_id,items_json) VALUES(?,?)", ("premium-user", json.dumps([{"id":"m1","market":"1X"}])))
assert db.execute("SELECT items_json FROM mam_user_coupons WHERE user_id=?", ("premium-user",)).fetchone()[0].startswith("[")
assert db.execute("SELECT COUNT(*) FROM mam_user_coupons WHERE user_id=?", ("other-user",)).fetchone()[0] == 0
try:
    db.execute("INSERT INTO mam_user_coupons(user_id,items_json) VALUES(?,?)", ("too-large", "x" * 32769))
    raise AssertionError("coupon payload size constraint failed")
except sqlite3.IntegrityError:
    pass
print("PASS: in-memory SQLite migration, tier/unique constraints, per-user coupon isolation, and size bound")
`;
  const result = execFileSync("python3", ["-c", script, migration], { encoding: "utf8" });
  assert.match(result, /PASS: in-memory SQLite migration/);
});
