"""Convert official Football-Data downloads into score-only benchmark inputs."""
import csv
from datetime import datetime
from hashlib import sha256
import json
from pathlib import Path
import sys

LEAGUES = {"T1": "tr.1", "E0": "en.1", "SP1": "es.1", "D1": "de.1", "I1": "it.1", "F1": "fr.1"}


def convert(source, destination):
    provenance = {}
    for season in ("2425", "2526", "2627"):
        folder = destination / f"20{season[:2]}-{season[2:]}"
        folder.mkdir(parents=True, exist_ok=True)
        for code, league in LEAGUES.items():
            file = source / season / f"{code}.csv"
            matches = []
            with file.open(encoding="utf-8-sig", newline="") as stream:
                for row in csv.DictReader(stream):
                    if not row.get("Date"):
                        continue
                    date = datetime.strptime(row["Date"], "%d/%m/%Y").date().isoformat()
                    scores = {}
                    for period, names in (("ft", ("FTHG", "FTAG")), ("ht", ("HTHG", "HTAG"))):
                        values = [row[name].strip() for name in names]
                        if all(value.isdecimal() for value in values):
                            scores[period] = [int(value) for value in values]
                    if scores:
                        matches.append({"date": date, "team1": row["HomeTeam"], "team2": row["AwayTeam"], "score": scores})
            assert matches, f"No completed matches in {file}"
            assert len({(m["date"], m["team1"], m["team2"]) for m in matches}) == len(matches), file
            (folder / f"{league}.json").write_text(json.dumps({"matches": matches}) + "\n", encoding="utf-8")
            provenance[f"{league}|{season}"] = {
                "url": f"https://www.football-data.co.uk/mmz4281/{season}/{code}.csv",
                "sha256": sha256(file.read_bytes()).hexdigest(),
            }
    (destination / "benchmark-sources.json").write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    convert(Path(sys.argv[1]), Path(sys.argv[2]))
