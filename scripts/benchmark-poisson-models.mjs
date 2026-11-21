import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { selectOnValidation } from "./poisson-validation-selection.mjs";
import { evaluateMarkets } from "./poisson-market-metrics.mjs";
import { predictTrustedGoals } from "../trusted-goal-poisson.js";

const directory=process.argv[2];
const period=process.argv.includes("--half")?"ht":"ft";
const allMarkets=process.argv.includes("--markets");
const extended=process.argv.includes("--extended");
const turkeyEarly=process.argv.includes("--turkey-early");
const leagues=turkeyEarly||process.argv.includes("--turkey-only")?["tr.1"]:["tr.1","en.1","es.1","de.1","it.1","fr.1"];
const trainingEnd=turkeyEarly?"2024-11-01":"2025-01-01";
const validationEnd=turkeyEarly?"2025-01-01":"2025-07-01";
const nextSeason=process.argv.includes("--next-season");
const testStart=nextSeason?"2026-07-01":validationEnd;
const testEnd=turkeyEarly?"2025-07-01":"9999-01-01";
const seasons=extended?["2023-24","2024-25","2025-26","2026-27"]:["2024-25","2025-26"];
const cap=15;
const models=["frequency","current","window5","window10","window15","window20","recency","shrinkage","opponent","dixon_coles","elo","dynamic_home","league_mix","calibrated"];
if(allMarkets)models.push("weighted5","weighted10","venue_strength","elo_calibrated");
const probabilities=(lambda)=>{
  const values=[Math.exp(-lambda)];
  for(let i=1;i<=cap;i++)values.push(values.at(-1)*lambda/i);
  return values;
};
const distribution=(home,away,rho=0,goalLimit=cap)=>{
  if(![home,away].every(x=>Number.isFinite(x)&&x>=0&&x<=8))return null;
  const p=probabilities(home),q=probabilities(away);
  const corrections=[1-home*away*rho,1+home*rho,1+away*rho,1-rho];
  if(corrections.some(x=>x<=0))return null;
  const values=p.flatMap((a,h)=>q.map((b,v)=>h>goalLimit||v>goalLimit?0:a*b*(h<2&&v<2?corrections[h*2+v]:1)));
  const mass=values.reduce((a,b)=>a+b,0);
  if(mass<0.98)return null;
  return values.map(x=>x/mass);
};
const renormalize=values=>{const total=values.reduce((a,b)=>a+b,0);return values.map(x=>x/total);};
const temperature=(values,t)=>renormalize(values.map(v=>v**(1/t)));
function summary(values){
  const outcome=[0,0,0];
  let btts=0,over=0;
  values.forEach((p,i)=>{
    const h=Math.floor(i/(cap+1)),a=i%(cap+1);
    outcome[Math.sign(a-h)+1]+=p;
    if(h>0&&a>0)btts+=p;
    if(h+a>=3)over+=p;
  });
  return {outcome,btts,over,values};
}
const average=(rows,field,weight)=>rows.reduce((sum,row,i)=>sum+row[field]*weight(i),0)/
  rows.reduce((sum,_,i)=>sum+weight(i),0);
function loss(probability){return -Math.log(Math.max(1e-15,probability));}
function measures(rows){
  let brier=0,logLoss=0,bttsBrier=0,overBrier=0,scoreLoss=0,exact=0,distributionCount=0;
  const bins=Array.from({length:10},()=>[0,0,0]);
  for(const {prediction,target} of rows){
    const {outcome,values,btts,over}=prediction;
    assert(Math.abs(outcome.reduce((a,b)=>a+b,0)-1)<1e-10);
    if(values)assert(values.every(p=>Number.isFinite(p)&&p>=0)&&Math.abs(values.reduce((a,b)=>a+b,0)-1)<1e-10);
    const h=target.home_goals,a=target.away_goals,actual=Math.sign(a-h)+1;
    const confidence=Math.max(...outcome), label=outcome.indexOf(confidence);
    const bin=bins[Math.min(9,Math.floor(confidence*10))];
    bin[0]++; bin[1]+=confidence; bin[2]+=Number(label===actual);
    brier+=outcome.reduce((total,p,i)=>total+(p-Number(i===actual))**2,0);
    logLoss+=loss(outcome[actual]);
    if(!values)continue;
    distributionCount++;
    bttsBrier+=(btts-Number(h>0&&a>0))**2;
    overBrier+=(over-Number(h+a>=3))**2;
    const idx=h*(cap+1)+a;
    scoreLoss+=loss(h>cap||a>cap?0:values[idx]);
    exact+=Number(h<=cap&&a<=cap&&idx===values.indexOf(Math.max(...values)));
  }
  const count=rows.length;
  return {count,brier:brier/count,logLoss:logLoss/count,ece:bins.reduce((sum,[,p,o])=>sum+Math.abs(p-o),0)/count,
    reliability:bins.flatMap(([n,p,o],i)=>n?[{lower:i/10,count:n,confidence:p/n,observed:o/n}]:[]),
    ...(distributionCount?{bttsBrier:bttsBrier/distributionCount,over25Brier:overBrier/distributionCount,
      scoreLogLoss:scoreLoss/distributionCount,exactScoreAccuracy:exact/distributionCount}:{})};
}

function simulate(rows,start){
  const ratings=new Map(), prior=[], results=[];
  const get=team=>ratings.get(team)??1500;
  for(const day of [...new Set(rows.map(r=>r.kickoff))].sort()){
    const played=rows.filter(r=>r.kickoff===day);
    const scoreCounts=Array((cap+1)**2).fill(0.001);
    prior.forEach(row=>{
      if(row.home_goals<=cap&&row.away_goals<=cap)scoreCounts[row.home_goals*(cap+1)+row.away_goals]++;
    });
    const empirical=renormalize(scoreCounts);
    if(day>=start&&prior.length){
      const leagueHome=average(prior,"home_goals",()=>1), leagueAway=average(prior,"away_goals",()=>1);
      const recent=prior.slice(-80);
      const recentHome=average(recent,"home_goals",()=>1), recentAway=average(recent,"away_goals",()=>1);
      for(const target of played){
        const {home_team,away_team}=target;
        const current=predictTrustedGoals(prior,{home_team,away_team,as_of:day,max_matches:10,
          league_average_home_goals:leagueHome,league_average_away_goals:leagueAway});
        const h=prior.filter(r=>r.home_team===home_team&&r.away_team!==away_team).toReversed();
        const a=prior.filter(r=>r.away_team===away_team&&r.home_team!==home_team).toReversed();
        const venue=(limit,weight=()=>1,priorWeight=0,opponentAdjusted=false)=>{
          if(h.length<5||a.length<5)return null;
          const strength=(row,field)=>opponentAdjusted?Math.exp((field==="home_goals"?1:-1)*
            (get(row.away_team)-get(row.home_team))/3000):1;
          const estimate=(rows,field,mean)=>{
            const slice=rows.slice(0,limit), weights=slice.reduce((sum,_,i)=>sum+weight(i),0);
            const observed=slice.reduce((sum,row,i)=>sum+row[field]*weight(i)*strength(row,field),0);
            return (observed+priorWeight*mean)/(weights+priorWeight);
          };
          return [estimate(h,"home_goals",leagueHome)*estimate(a,"home_goals",leagueHome)/leagueHome,
            estimate(a,"away_goals",leagueAway)*estimate(h,"away_goals",leagueAway)/leagueAway];
        };
        const map={frequency:summary(empirical)};
        if(current.available){
          const g=distribution(current.lambda_home,current.lambda_away,0,10);
          if(g)map.current={...summary(g),outcome:["home_win","draw","away_win"].map(k=>current.probabilities[k]),
            btts:current.probabilities.btts_yes,over:current.probabilities.over_2_5};
        }
        const add=(name,rates,rho=0)=>{const values=rates&&distribution(...rates,rho);if(values)map[name]=summary(values);};
        for(const n of [5,10,15,20])add("window"+n,venue(n));
        add("recency",venue(20,i=>2**(-i/6)));
        if(allMarkets){
          for(const n of [5,10])add("weighted"+n,venue(n,i=>2**(-i/(n/2)),3));
          const nonVenueRates=(team,asHome,omit)=>prior
            .filter(r=>r[asHome?"home_team":"away_team"]===team&&r[asHome?"away_team":"home_team"]!==omit).slice(-20);
          const adjustedRate=(sample,field,mean)=>(sample.reduce((sum,row)=>sum+row[field],0)+6*mean)/(sample.length+6);
          const normalized=(sample,field,mean)=>Math.max(0.33,adjustedRate(sample,field,mean)/mean);
          const hAdjusted=h.slice(0,10).map(r=>({...r,
            home_goals:r.home_goals/normalized(nonVenueRates(r.away_team,false,home_team),"home_goals",leagueHome),
            away_goals:r.away_goals/normalized(nonVenueRates(r.away_team,false,home_team),"away_goals",leagueAway)}));
          const aAdjusted=a.slice(0,10).map(r=>({...r,
            home_goals:r.home_goals/normalized(nonVenueRates(r.home_team,true,away_team),"home_goals",leagueHome),
            away_goals:r.away_goals/normalized(nonVenueRates(r.home_team,true,away_team),"away_goals",leagueAway)}));
          if(h.length>=5&&a.length>=5)add("venue_strength",[
            adjustedRate(hAdjusted,"home_goals",leagueHome)*adjustedRate(aAdjusted,"home_goals",leagueHome)/leagueHome,
            adjustedRate(hAdjusted,"away_goals",leagueAway)*adjustedRate(aAdjusted,"away_goals",leagueAway)/leagueAway
          ]);
        }
        const shrink=venue(20,()=>1,6);
        add("shrinkage",shrink);
        add("opponent",venue(20,()=>1,6,true));
        add("dixon_coles",shrink,-0.06);
        if(shrink){
          if(leagueHome>0&&leagueAway>0&&recentHome>0&&recentAway>0){
            const shift=Math.min(1.25,Math.max(0.8,Math.sqrt(recentHome*leagueAway/(recentAway*leagueHome))));
            add("dynamic_home",[shrink[0]*shift,shrink[1]/shift]);
          }
          const adjust=Math.exp(Math.max(-0.35,Math.min(0.35,(get(home_team)-get(away_team))/1800)));
          add("elo",[shrink[0]*adjust,shrink[1]/adjust]);
        }
        results.push({target,map,homeVenueMatches:h.length,awayVenueMatches:a.length});
      }
    }
    const delta=new Map();
    for(const r of played){
      const expected=1/(1+10**((get(r.away_team)-get(r.home_team)-55)/400));
      const actual=(Math.sign(r.home_goals-r.away_goals)+1)/2, change=20*(actual-expected);
      delta.set(r.home_team,(delta.get(r.home_team)??0)+change);
      delta.set(r.away_team,(delta.get(r.away_team)??0)-change);
    }
    delta.forEach((change,team)=>ratings.set(team,get(team)+change));
    prior.push(...played);
  }
  return results;
}
const reports=leagues.map(league=>{
  const hashes={};
  const leagueSeasons=extended&&league==="tr.1"?["2018-19","2019-20","2020-21",...seasons]:seasons;
  const matches=leagueSeasons.flatMap(season=>{
    const file=directory+"/"+season+"/"+league+".json";
    if(extended&&!fs.existsSync(file))return [];
    const raw=fs.readFileSync(file);
    hashes[season]=createHash("sha256").update(raw).digest("hex");
    return JSON.parse(raw).matches.filter(m=>Array.isArray(m.score?.[period])).map(m=>{
      assert(/^\d{4}-\d{2}-\d{2}$/.test(m.date)&&m.team1&&m.team2&&m.team1!==m.team2&&
        m.score[period].length===2&&m.score[period].every(g=>Number.isSafeInteger(g)&&g>=0));
      return {source:"openfootball",fixture_id:[league,m.date,m.team1,m.team2].join("|"),
        kickoff:m.date,home_team:m.team1,away_team:m.team2,home_goals:m.score[period][0],away_goals:m.score[period][1],
        identity_verified:true,score_verified:true,completed:true};
    });
  });
  assert.equal(new Set(matches.map(r=>r.fixture_id)).size,matches.length);
  const training=matches.filter(r=>r.kickoff<trainingEnd).length;
  assert(training>75,"Training data missing for "+league);
  const validation=simulate(matches.filter(r=>r.kickoff<validationEnd),trainingEnd).filter(r=>r.map.shrinkage);
  const choices=[0.8,1,1.15,1.3,1.5,1.8,2.1].map(t=>[t,measures(validation.map(r=>({
    target:r.target,prediction:summary(temperature(r.map.shrinkage.values,t))
  }))).logLoss]);
  choices.sort((a,b)=>a[1]-b[1]);
  assert(validation.length>0,"Validation data missing for "+league);
  const [t]=choices[0];
  const eloValidation=validation.filter(r=>r.map.elo);
  const eloTemperature=allMarkets?[1,1.15,1.3,1.5,1.8,2.1].map(candidate=>[
    candidate,measures(eloValidation.map(r=>({
      target:r.target,prediction:summary(temperature(r.map.elo.values,candidate))
    }))).logLoss
  ]).sort((a,b)=>a[1]-b[1])[0][0]:null;
  const mix=(r,weight)=>summary(r.map.shrinkage.values.map((p,i)=>p*weight+r.map.frequency.values[i]*(1-weight)));
  const mixChoices=[0,0.25,0.5,0.75,1].map(weight=>[weight,measures(validation.map(r=>({
    target:r.target,prediction:mix(r,weight)
  }))).logLoss]).sort((a,b)=>a[1]-b[1]);
  const [mixWeight]=mixChoices[0];
  function applyCalibration(rows){
    for(const r of rows)if(r.map.shrinkage){
      r.map.calibrated=summary(temperature(r.map.shrinkage.values,t));
      r.map.league_mix=mix(r,mixWeight);
      if(allMarkets&&r.map.elo)r.map.elo_calibrated=summary(temperature(r.map.elo.values,eloTemperature));
    }
  }
  applyCalibration(validation);
  const selection=selectOnValidation(validation,models,"current",validationEnd,rows=>measures(rows).logLoss);
  const test=simulate(matches.filter(r=>r.kickoff<testEnd),testStart);
  applyCalibration(test);
  const comparison=test.filter(r=>models.every(model=>r.map[model]));
  const results=Object.fromEntries(models.map(model=>{
    const rows=comparison.map(r=>({target:r.target,prediction:r.map[model]}));
    return [model,{coverage:test.filter(r=>r.map[model]).length/test.length,
      ...measures(rows),...(allMarkets?{markets:evaluateMarkets(rows,cap)}:{})}];
  }));
  return {league,hashes,training,validation:validation.length,temperature:t,mixWeight,testFixtures:test.length,comparisonFixtures:comparison.length,selection,
    belowVenueMinimum:test.filter(r=>r.homeVenueMatches<5||r.awayVenueMatches<5).length,
    ...(allMarkets?{eloTemperature}:{}),results};
});
const sourceFile=directory+"/turkey-sources.json";
const source=fs.existsSync(sourceFile)?JSON.parse(fs.readFileSync(sourceFile)):"https://github.com/openfootball/football.json";
console.log(JSON.stringify({source,period,split:{
  training_before:trainingEnd,validation_from:trainingEnd,validation_before:validationEnd,test_from:testStart,test_before:testEnd
},reports},null,2));
