import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { predictTrustedGoals } from "../trusted-goal-poisson.js";

const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
const matches = input.matches.sort((a,b) => a.kickoff.localeCompare(b.kickoff));
const outcomes = ["home_win","draw","away_win"];
const outcome = match => Math.sign(match.away_goals - match.home_goals) + 1;
const indexes = new Set(matches.map(match=>match.fixture_id));
assert.equal(indexes.size,matches.length);
assert(matches.every(match=>/^\d{4}-\d{2}-\d{2}$/.test(match.kickoff) &&
  typeof match.fixture_id === "string" && match.identity_verified === true && match.score_verified === true &&
  match.completed === true && [match.home_goals,match.away_goals].every(g=>Number.isInteger(g)&&g>=0)));
const clamp = probability => Math.max(1e-15,Math.min(1-1e-15,probability));
const bins = Array.from({length:10},()=>({count:0,probability:0,observed:0}));
function score(predictions) {
  const calibration = structuredClone(bins);
  let brier=0, logLoss=0, bttsBrier=0, overBrier=0, countBinary=0;
  for (const {probabilities, actual, binary} of predictions) {
    const index = probabilities.indexOf(Math.max(...probabilities));
    const confidence = probabilities[index];
    const bin = calibration[Math.min(9,Math.floor(confidence*10))];
    bin.count++;
    bin.probability+=confidence;
    bin.observed+=Number(index===actual);
    brier+=probabilities.reduce((sum,p,i)=>sum+(p-Number(i===actual))**2,0);
    logLoss-=Math.log(clamp(probabilities[actual]));
    if (binary) {
      countBinary++;
      bttsBrier+=(binary.btts-binary.actualBtts)**2;
      overBrier+=(binary.over-binary.actualOver)**2;
    }
  }
  const count=predictions.length;
  assert(count>0,"No eligible evaluation fixtures");
  return {
    count, brier:brier/count, logLoss:logLoss/count,
    topLabelEce:calibration.reduce((sum,bin)=>sum+Math.abs(bin.probability-bin.observed),0)/count,
    reliability:calibration.flatMap((bin,i)=>bin.count?[{lower:i/10,count:bin.count,
      meanConfidence:bin.probability/bin.count,observedFrequency:bin.observed/bin.count}]:[]),
    ...(countBinary?{bttsBrier:bttsBrier/countBinary,over25Brier:overBrier/countBinary}:{})
  };
}
const reports = [];
for (const max_matches of [5,10]) {
  const model=[],baseline=[];
  for (const target of matches) {
    const past=matches.filter(match=>match.kickoff<target.kickoff);
    if (!past.length) continue;
    const mean=key=>past.reduce((sum,match)=>sum+match[key],0)/past.length;
    const result=predictTrustedGoals(past,{
      home_team:target.home_team,away_team:target.away_team,as_of:target.kickoff,max_matches,
      league_average_home_goals:mean("home_goals"),league_average_away_goals:mean("away_goals")
    });
    if (!result.available) continue;
    assert(result.used_fixtures.every(match=>Date.parse(match.kickoff)<Date.parse(target.kickoff)));
    const probabilities=outcomes.map(key=>result.probabilities[key]);
    assert(Math.abs(probabilities.reduce((sum,p)=>sum+p,0)-1)<1e-10);
    model.push({probabilities,actual:outcome(target),binary:{
      btts:result.probabilities.btts_yes,over:result.probabilities.over_2_5,
      actualBtts:Number(target.home_goals>0&&target.away_goals>0),
      actualOver:Number(target.home_goals+target.away_goals>=3)
    }});
    const frequencies=[1,1,1];
    past.forEach(match=>frequencies[outcome(match)]++);
    baseline.push({probabilities:frequencies.map(n=>n/(past.length+3)),actual:outcome(target)});
  }
  reports.push({max_matches,excluded:matches.length-model.length,model:score(model),pastLeagueFrequency:score(baseline)});
}
console.log(JSON.stringify({source:input.source,sourceSha256:input.sourceSha256,total:matches.length,reports},null,2));
