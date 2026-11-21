const overThresholds = [0.5, 1.5, 2.5, 3.5, 4.5];
const result = (home, away) => Math.sign(away - home) + 1;

export function evaluateMarkets(rows, cap) {
  const size = cap + 1;
  const markets = {
    result: [3, result],
    home_or_draw: [2, (h, a) => Number(h >= a)],
    away_or_draw: [2, (h, a) => Number(a >= h)],
    home_or_away: [2, (h, a) => Number(h !== a)],
    btts: [2, (h, a) => Number(h > 0 && a > 0)],
    ...Object.fromEntries(overThresholds.map(line => ["over_" + line, [2, (h, a) => Number(h + a > line)]])),
    home_goals: [size + 1, h => Math.min(h, size)],
    away_goals: [size + 1, (_, a) => Math.min(a, size)],
    score: [size ** 2 + 1, (h, a) => h > cap || a > cap ? size ** 2 : h * size + a],
  };
  const output = {};
  for (const [name, [classes, category]] of Object.entries(markets)) {
    const bins = Array.from({ length: 10 }, () => ({ n: 0, predicted: 0, observed: 0 }));
    let brier = 0, logLoss = 0, predictedGoals = 0, observedGoals = 0, squaredGoalError = 0;
    const isGoalCount = name === "home_goals" || name === "away_goals";
    for (const { prediction, target } of rows) {
      const probabilities = Array(classes).fill(0);
      prediction.values.forEach((value, i) => {
        probabilities[category(Math.floor(i / size), i % size)] += value;
      });
      const actual = category(target.home_goals, target.away_goals);
      const label = classes === 2 ? 1 : probabilities.indexOf(Math.max(...probabilities));
      const confidence = probabilities[label];
      const bin = bins[Math.min(9, Math.floor(confidence * 10))];
      bin.n++;
      bin.predicted += confidence;
      bin.observed += Number(label === actual);
      brier += probabilities.reduce((sum, probability, i) => sum + (probability - Number(i === actual)) ** 2, 0);
      logLoss -= Math.log(Math.max(probabilities[actual], 1e-15));
      if (isGoalCount) {
        const expected = probabilities.reduce((sum, p, i) => sum + p * i, 0);
        const actualGoals = name === "home_goals" ? target.home_goals : target.away_goals;
        predictedGoals += expected;
        observedGoals += actualGoals;
        squaredGoalError += (expected - actualGoals) ** 2;
      }
    }
    const n = rows.length;
    output[name] = {
      n,
      brier: n ? brier / n : null,
      log_loss: n ? logLoss / n : null,
      ece: n ? bins.reduce((sum, b) => sum + Math.abs(b.predicted - b.observed), 0) / n : null,
      ...(isGoalCount && n ? {
        expected_goal_mean: predictedGoals / n,
        observed_goal_mean: observedGoals / n,
        goal_rmse: Math.sqrt(squaredGoalError / n),
      } : {}),
    };
  }
  return output;
}
