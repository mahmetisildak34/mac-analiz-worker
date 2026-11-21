const loss = probability => -Math.log(Math.max(1e-15, probability));

function aggregate(rows) {
  if (!rows.length) return { n: 0, mean_delta: null };
  return { n: rows.length, mean_delta: rows.reduce((sum, row) => sum + row.delta, 0) / rows.length };
}

export function pairedOutcomeDiagnostics(rows, selected) {
  const differences = rows.map(({ target, map }) => {
    const outcome = Math.sign(target.away_goals - target.home_goals) + 1;
    return {
      day: target.kickoff,
      outcome,
      delta: loss(map[selected].outcome[outcome]) - loss(map.current.outcome[outcome]),
    };
  });
  const days = [...new Set(differences.map(row => row.day))];
  const sensitivity = days.map(day => aggregate(differences.filter(row => row.day !== day)).mean_delta)
    .filter(value => value !== null);
  return {
    ...aggregate(differences),
    per_result: Object.fromEntries(["home", "draw", "away"].map((label, i) => [
      label, aggregate(differences.filter(row => row.outcome === i)),
    ])),
    kickoff_days: days.length,
    leave_one_day_out: sensitivity.length ? { min: Math.min(...sensitivity), max: Math.max(...sensitivity) } : null,
  };
}
