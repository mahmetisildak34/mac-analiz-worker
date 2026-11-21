import assert from "node:assert/strict";
import fs from "node:fs";
import {predictTrustedGoals,predictTrustedHalfTime} from "../trusted-goal-poisson.js";

const directory=process.argv[2], limit=10, size=limit+1, testStart="2025-07-01";
const thresholds=[0,1,2,3,4];
const markets={
  result:{choices:3,label:(h,a)=>Math.sign(a-h)+1},
  btts:{choices:2,label:(h,a)=>Number(h>0&&a>0)},
  ...Object.fromEntries(thresholds.map(t=>["over_"+(t+0.5),{choices:2,label:(h,a)=>Number(h+a>t)}])),
  score:{choices:size*size+1,label:(h,a)=>h>limit||a>limit?size*size:h*size+a},
  home_goals:{choices:size+1,label:h=>Math.min(h,size)},
  away_goals:{choices:size+1,label:(_,a)=>Math.min(a,size)},
  total_goals:{choices:2*limit+2,label:(h,a)=>Math.min(h+a,2*limit+1)}
};
const mean=(rows,field)=>rows.reduce((s,x)=>s+x[field],0)/rows.length;
const scoreVector=(h,a,maxGoals=limit,retainedMass)=>{
  const poisson=x=>{
    const v=[Math.exp(-x)];
    for(let j=1;j<=maxGoals;j++)v.push(v.at(-1)*x/j);
    return v;
  };
  const a1=poisson(h),a2=poisson(a);
  const grid=a1.flatMap(p=>a2.map(q=>p*q));
  const mass=grid.reduce((s,p)=>s+p,0);
  if(retainedMass===undefined)return {grid,mass};
  assert(Math.abs(mass-retainedMass)<1e-12);
  return {grid:grid.map(x=>x/mass),mass:1};
};
const normalize=values=>{const sum=values.reduce((a,b)=>a+b,0);return values.map(v=>v/sum);};
function distribution(grid,scheme){
  const probabilities=Array(scheme.choices).fill(0);
  grid.forEach((p,i)=>probabilities[scheme.label(Math.floor(i/size),i%size)]+=p);
  return normalize(probabilities);
}
function metric(){
  const bins=Array.from({length:10},()=>[0,0,0]);
  let n=0,brier=0,logLoss=0;
  return {
    record(p,actual){
      assert(p.every(x=>Number.isFinite(x)&&x>=0)&&Math.abs(p.reduce((a,b)=>a+b,0)-1)<1e-9);
      n++;
      brier+=p.reduce((s,x,i)=>s+(x-Number(i===actual))**2,0);
      logLoss-=Math.log(Math.max(1e-15,p[actual]));
      const i=p.length===2?1:p.indexOf(Math.max(...p)), prob=p[i];
      const b=bins[Math.min(9,Math.floor(prob*10))];b[0]++;b[1]+=prob;b[2]+=Number(i===actual);
    },
    result(){return {n,brier:brier/n,log_loss:logLoss/n,ece:bins.reduce((s,[,p,o])=>s+Math.abs(p-o),0)/n,
      reliability:bins.flatMap(([n,p,o],i)=>n?[{lower:i/10,count:n,mean_probability:p/n,observed_rate:o/n}]:[])};}
  };
}
const leagues=["tr","en","es","de","it","fr"];
const periods=["full_time","first_half"];
const valid=s=>Array.isArray(s)&&s.length===2&&s.every(n=>Number.isSafeInteger(n)&&n>=0);
const modelNames=["frequency","league_poisson","venue_poisson","validation_blend"];
const blendCandidates=[0,0.25,0.5,0.75,1];
const blend=(baseline,venue,w)=>baseline.map((p,i)=>p*(1-w)+venue[i]*w);
const all=Object.fromEntries(periods.map(period=>[period,Object.fromEntries(modelNames.map(model=>[model,
  Object.fromEntries(Object.keys(markets).map(key=>[key,metric()]))]))]));
const report=leagues.map(league=>{
  const matches=["2024-25","2025-26"].flatMap(year=>JSON.parse(fs.readFileSync(directory+"/"+year+"/"+league+".1.json","utf8")).matches)
    .filter(r=>valid(r.score?.ft)).map(r=>{
      const [home_goals,away_goals]=r.score.ft,half=valid(r.score.ht)&&r.score.ht[0]<=home_goals&&r.score.ht[1]<=away_goals;
      return {source:"openfootball",fixture_id:[league,r.date,r.team1,r.team2].join("|"),kickoff:r.date,
        home_team:r.team1,away_team:r.team2,home_goals,away_goals,identity_verified:true,score_verified:true,completed:true,
        halftime_score_verified:Boolean(half),halftime_home_goals:half?r.score.ht[0]:null,halftime_away_goals:half?r.score.ht[1]:null};
    });
  assert.equal(new Set(matches.map(r=>r.fixture_id)).size,matches.length);
  return {league,periods:periods.map(period=>{
    const half=period==="first_half", history=half?matches.filter(r=>r.halftime_score_verified):matches;
    const tests=history.filter(r=>r.kickoff>=testStart);
    let common=0;
    const models=Object.fromEntries(modelNames.map(model=>[model,Object.fromEntries(Object.keys(markets).map(key=>[key,metric()]))]));
    const field=side=>(half?"halftime_":"")+side+"_goals";
    const forecast=test=>{
      const prior=history.filter(r=>r.kickoff<test.kickoff);
      if(!prior.length)return null;
      const h=mean(prior,field("home")),a=mean(prior,field("away"));
      const scope={home_team:test.home_team,away_team:test.away_team,as_of:test.kickoff,max_goals:limit};
      const venue=half?predictTrustedHalfTime(prior,{...scope,league_average_home_half_goals:h,league_average_away_half_goals:a}):
        predictTrustedGoals(prior,{...scope,league_average_home_goals:h,league_average_away_goals:a});
      if(!venue.available)return null;
      assert(venue.used_fixtures.every(r=>r.kickoff.slice(0,10)<test.kickoff));
      const venueGrid=scoreVector(venue.lambda_home,venue.lambda_away,limit,venue.goal_distribution.retained_mass).grid;
      const leagueGrid=scoreVector(h,a).grid;
      return {prior,venueGrid,leagueGrid};
    };
    const validation=history.filter(r=>r.kickoff>="2025-01-01"&&r.kickoff<testStart);
    const validationLoss=blendCandidates.map(()=>0);
    let validationPredictions=0;
    for(const test of validation){
      const f=forecast(test);
      if(!f)continue;
      const actual=markets.result.label(test[field("home")],test[field("away")]);
      validationPredictions++;
      blendCandidates.forEach((w,i)=>{
        const p=distribution(blend(normalize(f.leagueGrid),f.venueGrid,w),markets.result);
        validationLoss[i]-=Math.log(Math.max(1e-15,p[actual]));
      });
    }
    assert(validationPredictions>0);
    const venueWeight=blendCandidates[validationLoss.indexOf(Math.min(...validationLoss))];
    for(const test of tests){
      const f=forecast(test);
      if(!f)continue;
      const {prior,venueGrid,leagueGrid}=f;
      common++;
      for(const [key,scheme] of Object.entries(markets)){
        const counts=Array(scheme.choices).fill(0.5);
        for(const r of prior)counts[scheme.label(r[field("home")],r[field("away")])]++;
        const actual=scheme.label(test[field("home")],test[field("away")]);
        const forecasts={frequency:normalize(counts),league_poisson:distribution(leagueGrid,scheme),venue_poisson:distribution(venueGrid,scheme),
          validation_blend:distribution(blend(normalize(leagueGrid),venueGrid,venueWeight),scheme)};
        for(const [model,p] of Object.entries(forecasts)){
          models[model][key].record(p,actual);
          all[period][model][key].record(p,actual);
        }
      }
    }
    return {period,fixtures:tests.length,common_predictions:common,validation_predictions:validationPredictions,venue_weight:venueWeight,coverage:{
      frequency:1,league_poisson:1,venue_poisson:common/tests.length,validation_blend:common/tests.length
    },results:Object.fromEntries(Object.entries(models).map(([name,ms])=>[name,Object.fromEntries(Object.entries(ms).map(([k,m])=>{
      const {reliability,...summary}=m.result();
      return [k,k==="result"?{...summary,reliability}:summary];
    }))]))};
  })};
});
const pooled=Object.fromEntries(periods.map(p=>[p,Object.fromEntries(modelNames.map(n=>[n,
  Object.fromEntries(Object.entries(all[p][n]).map(([k,m])=>[k,m.result()]))]))]));
console.log(JSON.stringify({source:"https://github.com/openfootball/football.json",test_from:testStart,
  methodology:"Same test matches for all models, same-day history excluded. The experimental blend is chosen by 1X2 log loss on Jan–Jun 2025, separately per league and period. Test starts in Jul 2025. Distributions use a common 0–10 per-side grid with an explicit overflow category. Binary ECE uses event probability and multiclass ECE uses the top label.",pooled,report},null,2));
