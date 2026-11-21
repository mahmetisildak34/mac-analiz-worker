import assert from "node:assert/strict";
import fs from "node:fs";
import {predictTrustedGoals,predictTrustedHalfTime} from "../trusted-goal-poisson.js";

const directory=process.argv[2];
const leagues=["tr","en","es","de","it","fr"];
const cut="2025-07-01";
const lines=["0.5","1.5","2.5","3.5","4.5"];
const valid=s=>Array.isArray(s)&&s.length===2&&s.every(n=>Number.isSafeInteger(n)&&n>=0);
const squared=(p,y)=>(p-Number(y))**2;
const mass=(lambda,goals)=>{
  let p=Math.exp(-lambda);
  for(let g=1;g<=goals;g++)p*=lambda/g;
  return p;
};
const report=leagues.map(league=>{
  const matches=["2024-25","2025-26"].flatMap(season=>JSON.parse(fs.readFileSync(directory+"/"+season+"/"+league+".1.json","utf8")).matches)
    .filter(r=>valid(r.score?.ft)).map(r=>{
      const [home_goals,away_goals]=r.score.ft;
      const half=valid(r.score.ht)&&r.score.ht[0]<=home_goals&&r.score.ht[1]<=away_goals;
      return {source:"openfootball",fixture_id:[league,r.date,r.team1,r.team2].join("|"),kickoff:r.date,
        home_team:r.team1,away_team:r.team2,home_goals,away_goals,identity_verified:true,score_verified:true,completed:true,
        halftime_score_verified:Boolean(half),halftime_home_goals:half?r.score.ht[0]:null,halftime_away_goals:half?r.score.ht[1]:null};
    });
  assert.equal(new Set(matches.map(r=>r.fixture_id)).size,matches.length);
  return {league,periods:[false,true].map(firstHalf=>{
    const eligible=firstHalf?matches.filter(r=>r.halftime_score_verified):matches;
    const fixtures=eligible.filter(r=>r.kickoff>=cut);
    const sums={outcome_brier:0,outcome_log_loss:0,btts_brier:0,score_log_loss:0,top_score_accuracy:0,
      home_goal_mae:0,away_goal_mae:0,total_goal_mae:0,...Object.fromEntries(lines.map(line=>["over_"+line+"_brier",0]))};
    let count=0;
    for(const target of fixtures){
      const history=eligible.filter(r=>r.kickoff<target.kickoff);
      const field=side=>firstHalf?"halftime_"+side+"_goals":side+"_goals";
      const avg=side=>history.reduce((sum,row)=>sum+row[field(side)],0)/history.length;
      const options={home_team:target.home_team,away_team:target.away_team,as_of:target.kickoff};
      const p=firstHalf?predictTrustedHalfTime(history,{...options,league_average_home_half_goals:avg("home"),
        league_average_away_half_goals:avg("away")}):predictTrustedGoals(history,{...options,
        league_average_home_goals:avg("home"),league_average_away_goals:avg("away")});
      if(!p.available)continue;
      assert(p.used_fixtures.every(r=>r.kickoff.slice(0,10)<target.kickoff));
      count++;
      const h=target[field("home")],a=target[field("away")], goals=h+a;
      const outcome=h>a?"home_win":h<a?"away_win":"draw";
      sums.outcome_brier+=["home_win","draw","away_win"].reduce((s,k)=>s+squared(p.probabilities[k],k===outcome),0);
      sums.outcome_log_loss-=Math.log(Math.max(1e-15,p.probabilities[outcome]));
      sums.btts_brier+=squared(p.probabilities.btts_yes,h>0&&a>0);
      for(const line of lines)sums["over_"+line+"_brier"]+=squared(p.totals[line].over,goals>Number(line));
      const observed=h<p.goal_distribution.home.length&&a<p.goal_distribution.away.length?
        mass(p.lambda_home,h)*mass(p.lambda_away,a)/p.goal_distribution.retained_mass:0;
      sums.score_log_loss-=Math.log(Math.max(1e-15,observed));
      sums.top_score_accuracy+=Number(p.most_likely_scores[0].home===h&&p.most_likely_scores[0].away===a);
      sums.home_goal_mae+=Math.abs(p.lambda_home-h);
      sums.away_goal_mae+=Math.abs(p.lambda_away-a);
      sums.total_goal_mae+=Math.abs(p.lambda_home+p.lambda_away-goals);
    }
    return {period:firstHalf?"first_half":"full_time",fixtures:fixtures.length,predicted:count,
      metrics:count?Object.fromEntries(Object.entries(sums).map(([k,v])=>[k,v/count])):null};
  })};
});
console.log(JSON.stringify({data_source:"https://github.com/openfootball/football.json",cutoff:cut,report},null,2));
