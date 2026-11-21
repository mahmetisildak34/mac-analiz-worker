#!/usr/bin/env python3
"""Offline SQLite pilot: no network, credentials, Cloudflare, or Production writes."""
import copy
import hashlib
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

MANIFEST = Path(__file__).resolve().parent / "fixtures" / "five-match-dry-run.json"
ALLOW = frozenset(("698889", "698888", "698884", "698886", "698890"))
SENTINEL = "SENTINEL-6"
CREATE = """CREATE TABLE pilot_matches (
 source TEXT NOT NULL, fixture_id TEXT PRIMARY KEY, kickoff TEXT NOT NULL,
 status TEXT NOT NULL, league_id TEXT NOT NULL, home_team TEXT NOT NULL,
 away_team TEXT NOT NULL, home_goals INTEGER NOT NULL, away_goals INTEGER NOT NULL,
 statistics_json TEXT, updated_at TEXT NOT NULL)"""
UPDATE = """UPDATE pilot_matches SET statistics_json = ?, updated_at = ?
 WHERE source = ? AND fixture_id = ? AND fixture_id IN (?,?,?,?,?)
 AND status = ? AND league_id = ? AND kickoff = ?
 AND home_team = ? AND away_team = ? AND home_goals = ? AND away_goals = ?
 AND statistics_json IS NULL AND updated_at = ?"""
ROLLBACK = """UPDATE pilot_matches SET statistics_json = NULL, updated_at = ?
 WHERE source = ? AND fixture_id = ? AND fixture_id IN (?,?,?,?,?)
 AND statistics_json = ? AND updated_at = ?"""

def load():
    data = json.loads(MANIFEST.read_text(encoding="utf-8"))
    fixtures = data["fixtures"]
    ids = [x["production"]["fixture_id"] for x in fixtures]
    assert len(ids) == len(set(ids)) == 5 and set(ids) == ALLOW
    for x in fixtures:
        p, v = x["production"], x["preview"]
        assert p["source"] == "espn" and v["source"] == "ESPN"
        assert v["fixture_id"] == "espn-uefa.nations-" + p["fixture_id"]
        assert p["statistics_json"] is None and p["status"] == "FT"
        for k in ("kickoff", "home_team", "away_team", "home_goals", "away_goals"):
            assert p[k] == v[k], (p["fixture_id"], k)
        parsed = json.loads(v["statistics_json"])
        assert len(parsed["teams"]) == 2
        assert [t["homeAway"] for t in parsed["teams"]] == ["home", "away"]
        assert [t["team"] for t in parsed["teams"]] == [p["home_team"], p["away_team"]]
        assert all(len(t["statistics"]) == 28 for t in parsed["teams"])
        assert hashlib.sha256(v["statistics_json"].encode("utf-8")).hexdigest() == x["expected_sha256"]
    return fixtures

class PilotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = load()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = sqlite3.connect(str(Path(self.tmp.name) / "pilot.sqlite"))
        self.conn.execute(CREATE)
        for x in self.fixtures:
            p = x["production"]
            self.conn.execute("INSERT INTO pilot_matches VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                tuple(p[k] for k in ("source","fixture_id","kickoff","status","league_id","home_team","away_team","home_goals","away_goals","statistics_json","updated_at")))
        self.conn.execute("INSERT INTO pilot_matches VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            ("test-only",SENTINEL,"2024-09-05T18:45Z","FT","5","Synthetic Home","Synthetic Away",0,0,None,"2026-11-21 00:00:00"))
        self.conn.commit()
        self.before = self.snapshot()

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def snapshot(self):
        return self.conn.execute("SELECT * FROM pilot_matches ORDER BY fixture_id").fetchall()

    def transfer(self, x, *, fixture_id=None, home=None, score=None, updated_at=None, json_text=None, expected_hash=None):
        p, v = x["production"], x["preview"]
        ident = fixture_id if fixture_id is not None else p["fixture_id"]
        raw = json_text if json_text is not None else v["statistics_json"]
        digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()
        if digest != (expected_hash if expected_hash is not None else x["expected_sha256"]):
            return 0
        if ident not in ALLOW:
            return 0
        params = (raw,"2099-01-01 00:00:00",p["source"],ident,*sorted(ALLOW),
                  p["status"],p["league_id"],p["kickoff"],
                  home if home is not None else p["home_team"],p["away_team"],
                  score if score is not None else p["home_goals"],p["away_goals"],
                  updated_at if updated_at is not None else p["updated_at"])
        return self.conn.execute(UPDATE,params).rowcount

    def restore(self,x):
        p,v=x["production"],x["preview"]
        return self.conn.execute(ROLLBACK,(p["updated_at"],p["source"],p["fixture_id"],*sorted(ALLOW),v["statistics_json"],"2099-01-01 00:00:00")).rowcount

    def test_01_hashes_and_exact_allowlist(self):
        self.assertEqual(len(self.fixtures),5)
        self.assertEqual({x["production"]["fixture_id"] for x in self.fixtures},ALLOW)
        for x in self.fixtures:
            self.assertEqual(hashlib.sha256(x["preview"]["statistics_json"].encode()).hexdigest(),x["expected_sha256"])
        self.assertEqual(len(self.before),6)
        print("HASHES 5/5; ALLOWLIST 5; INITIAL ROWS 6")

    def test_02_first_run_second_run_sentinel_and_rollback(self):
        changed=sum(self.transfer(x) for x in self.fixtures)
        self.assertEqual(changed,5)
        self.assertEqual(self.conn.execute("SELECT COUNT(*) FROM pilot_matches WHERE statistics_json IS NOT NULL").fetchone()[0],5)
        self.assertEqual(self.conn.execute("SELECT statistics_json FROM pilot_matches WHERE fixture_id=?",(SENTINEL,)).fetchone()[0],None)
        first=self.snapshot()
        self.assertEqual(sum(self.transfer(x) for x in self.fixtures),0)
        self.assertEqual(self.snapshot(),first)
        self.assertEqual(sum(self.restore(x) for x in self.fixtures),5)
        self.assertEqual(self.snapshot(),self.before)
        print("FIRST UPDATE 5; SECOND UPDATE 0; SENTINEL UNCHANGED; ROLLBACK 5; RESTORED 6/6")

    def test_03_wrong_team_score_updated_at(self):
        x=self.fixtures[0]
        self.assertEqual(self.transfer(x,home="Wrong Team"),0)
        self.assertEqual(self.transfer(x,score=999),0)
        self.assertEqual(self.transfer(x,updated_at="2000-01-01 00:00:00"),0)
        self.assertEqual(self.snapshot(),self.before)

    def test_04_wrong_hash_and_allowlist(self):
        x=self.fixtures[0]
        self.assertEqual(self.transfer(x,json_text=x["preview"]["statistics_json"]+" "),0)
        self.assertEqual(self.transfer(x,expected_hash="0"*64),0)
        self.assertEqual(self.transfer(x,fixture_id=SENTINEL),0)
        self.assertEqual(self.snapshot(),self.before)

    def test_05_race_and_null_guard(self):
        x=self.fixtures[0]
        id=x["production"]["fixture_id"]
        self.conn.execute("UPDATE pilot_matches SET updated_at=? WHERE fixture_id=?",("changed-concurrently",id))
        self.assertEqual(self.transfer(x),0)
        self.conn.execute("UPDATE pilot_matches SET updated_at=?,statistics_json=? WHERE fixture_id=?",
                          (x["production"]["updated_at"],'{"other":"writer"}',id))
        self.assertEqual(self.transfer(x),0)
        self.assertEqual(self.conn.execute("SELECT statistics_json FROM pilot_matches WHERE fixture_id=?",(id,)).fetchone()[0],'{"other":"writer"}')

    def test_06_rollback_does_not_overwrite_other_writer(self):
        x=self.fixtures[0]
        self.assertEqual(self.transfer(x),1)
        id=x["production"]["fixture_id"]
        self.conn.execute("UPDATE pilot_matches SET statistics_json=? WHERE fixture_id=?",('{"newer":"value"}',id))
        self.assertEqual(self.restore(x),0)
        self.assertEqual(self.conn.execute("SELECT statistics_json FROM pilot_matches WHERE fixture_id=?",(id,)).fetchone()[0],'{"newer":"value"}')

if __name__ == "__main__":
    unittest.main(verbosity=2)
