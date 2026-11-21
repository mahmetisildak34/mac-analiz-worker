"""Convert Football-Data's Turkish league CSV files to score-only benchmark inputs."""
import csv
from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import sys


def convert(source, destination):
    provenance = {}
    for file in sorted(source.glob("????-??.csv")):
        matches = []
        with file.open(encoding="utf-8-sig", errors="strict", newline="") as stream:
            for row in csv.DictReader(stream):
                if not row.get("Date"):
                    continue
                date = datetime.strptime(row["Date"], "%d/%m/%Y").date().isoformat()
                score = {}
                for period, columns in (("ft", ("FTHG", "FTAG")), ("ht", ("HTHG", "HTAG"))):
                    values = [row[name].strip() for name in columns]
                    if all(value.isdecimal() for value in values):
                        score[period] = [int(value) for value in values]
                if score:
                    matches.append({"date": date, "team1": row["HomeTeam"], "team2": row["AwayTeam"], "score": score})
        assert len({(row["date"], row["team1"], row["team2"]) for row in matches}) == len(matches)
        season = file.stem
        folder = destination / season
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "tr.1.json").write_text(json.dumps({"matches": matches}) + "\n", encoding="utf-8")
        short_season = season[2:4] + season[-2:]
        provenance[season] = {
            "url": f"https://www.football-data.co.uk/mmz4281/{short_season}/T1.csv",
            "sha256": sha256(file.read_bytes()).hexdigest(),
            "matches": len(matches),
        }
    assert provenance, "No Turkish league CSV files"
    (destination / "turkey-sources.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    convert(Path(sys.argv[1]), Path(sys.argv[2]))
