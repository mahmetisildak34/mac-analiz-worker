"""Exercise the repair plans in an in-memory SQLite database."""
import hashlib
import json
import pathlib
import sqlite3

ROOT = pathlib.Path(__file__).resolve().parents[1]
DATE = "2026-11-21"


def read(prefix):
    return json.loads((ROOT / (prefix + "_" + DATE + ".json")).read_text())


def identity(row):
    return row["source"], row["fixture_id"]


repairs = read("UEFA_KICKOFF_REPAIR_MANIFEST")["repairs"]
audit_manifest = read("STATISTICS_TRANSFER_REVALIDATION")
audit = audit_manifest["rows"]
eligible = [row for row in audit if row["candidate_data_eligible"]]
verified = {identity(row): row for row in read("STATISTICS_REPAIR_VERIFIED")["fullMatches"]}
assert len({identity(row) for row in repairs}) == len(repairs) == 55
assert len({identity(row) for row in audit}) == len(audit) == audit_manifest["total"]
assert len({(row["provider"], row["provider_event_id"]) for row in eligible}) == len(eligible) == audit_manifest["data_eligible"]
assert all(not row["live_apply_approved"] for row in repairs + audit)

db = sqlite3.connect(":memory:")
db.executescript("""
CREATE TABLE fixture(source TEXT, id TEXT, kickoff TEXT, home TEXT, away TEXT,
                     home_goals INT, away_goals INT, stats TEXT, updated_at TEXT,
                     PRIMARY KEY(source,id));
CREATE TABLE prior(source TEXT, id TEXT, kind TEXT, before_value TEXT, applied_value TEXT,
                   PRIMARY KEY(source,id,kind));
""")
for row in repairs:
    db.execute("INSERT INTO fixture VALUES(?,?,?,?,?,?,?,?,?)",
               (*identity(row), row["old_kickoff"], row["home"], row["away"], row["home_goals"],
                row["away_goals"], None, row["current_updated_at"]))
for row in eligible:
    db.execute("INSERT INTO fixture VALUES(?,?,?,?,?,?,?,?,?)",
               (*identity(row), row["kickoff"], row["home"]["name"], row["away"]["name"],
                row["home"]["goals"], row["away"]["goals"], None, row["current_archive_updated_at"]))
db.commit()


def snapshot():
    return db.execute("SELECT * FROM fixture ORDER BY source,id").fetchall()


def apply(dry_run=False, fail_after=None):
    applied = 0
    with db:
        for kind, candidates in [("kickoff", repairs), ("stats", eligible)]:
            for row in candidates:
                source, fixture = identity(row)
                historic = kind == "kickoff"
                before = row["old_kickoff"] if historic else None
                after = row["new_kickoff"] if historic else verified[(source, fixture)]["statistics_json"]
                date = row["old_kickoff"] if historic else row["kickoff"]
                teams = (row["home"], row["away"], row["home_goals"], row["away_goals"]) if historic else (
                    row["home"]["name"], row["away"]["name"], row["home"]["goals"], row["away"]["goals"])
                revision = row["current_updated_at"] if historic else row["current_archive_updated_at"]
                if not historic:
                    assert hashlib.sha256(after.encode()).hexdigest() == row["statistics_sha256"]
                where = ("source=? AND id=? AND kickoff=? AND home=? AND away=? "
                         "AND home_goals=? AND away_goals=? AND updated_at IS ? AND " + kind + " IS ?")
                params = (source, fixture, date, *teams, revision, before)
                if not db.execute("SELECT 1 FROM fixture WHERE " + where, params).fetchone():
                    continue
                applied += 1
                if dry_run:
                    continue
                db.execute("INSERT INTO prior VALUES(?,?,?,?,?)", (source, fixture, kind, before, after))
                assert db.execute("UPDATE fixture SET " + kind + "=? WHERE " + where, (after, *params)).rowcount == 1
                if fail_after == applied:
                    raise RuntimeError("rollback injection")
    return applied


before = snapshot()
planned = len(repairs) + len(eligible)
assert apply(dry_run=True) == planned and snapshot() == before
try:
    apply(fail_after=56)
except RuntimeError:
    pass
else:
    raise AssertionError("Expected injected failure")
assert snapshot() == before and db.execute("SELECT count(*) FROM prior").fetchone()[0] == 0
assert apply() == planned and apply() == 0
assert db.execute("SELECT count(*) FROM fixture").fetchone()[0] == planned
with db:
    for source, fixture, kind, previous, written in db.execute("SELECT * FROM prior"):
        assert kind in {"kickoff", "stats"}
        assert db.execute("UPDATE fixture SET " + kind + "=? WHERE source=? AND id=? AND " + kind + " IS ?",
                          (previous, source, fixture, written)).rowcount == 1
    db.execute("DELETE FROM prior")
assert snapshot() == before
print(f"PASS {len(repairs)} kickoff repairs, {len(eligible)} statistics candidates, dry-run, atomic failure, idempotence, rollback")
