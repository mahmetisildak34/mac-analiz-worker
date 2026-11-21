import assert from "node:assert/strict";

export function selectOnValidation(rows, models, baseline, validationEnd, score) {
  assert(rows.every(row => row.target.kickoff < validationEnd), "Selection received post-validation outcomes");
  const common = rows.filter(row => models.every(model => row.map[model]));
  assert(common.length > 0, "No common validation predictions");
  const ranking = models.map(model => ({
    model,
    logLoss: score(common.map(row => ({ target: row.target, prediction: row.map[model] }))),
  }));
  assert(ranking.every(row => Number.isFinite(row.logLoss)), "Invalid validation loss");
  const baselineLoss = ranking.find(row => row.model === baseline)?.logLoss;
  assert(Number.isFinite(baselineLoss), "Baseline missing from validation ranking");
  ranking.sort((a, b) => a.logLoss - b.logLoss || a.model.localeCompare(b.model));
  return { model: ranking[0].logLoss < baselineLoss ? ranking[0].model : baseline, common: common.length, ranking };
}
