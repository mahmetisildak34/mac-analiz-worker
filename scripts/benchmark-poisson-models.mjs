import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { predictTrustedGoals } from "../trusted-goal-poisson.js";

const directory=process.argv[2];
const leagues=["tr.1","en.1","es.1","de.1","it.1","fr.1"];
const seasons=["2024-25","2025-26"];
const cap=15;
const models=["frequency","current","window5","window10","window15","window20","recency","shrinkage","opponent","dixon_coles","elo","calibrated"];
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
    ...(distributionCount?{bttsBrier:bttsBrier/distributionCount,over25Brier:overBrier/distributionCount,
      scoreLogLoss:scoreLoss/distributionCount,exactScoreAccuracy:exact/distributionCount}:{})};
}

function simulate(rows,start){
  const ratings=new Map(), prior=[], results=[];
  const get=team=>ratings.get(team)??1500;
  for(const day of [...new Set(rows.map(r=>r.kickoff))].sort()){
    const played=rows.filter(r=>r.kickoff===day);
    const counts=[1,1,1];
    prior.forEach(p=>counts[Math.sign(p.away_goals-p.home_goals)+1]++);
    if(day>=start&&prior.length){
      const leagueHome=average(prior,"home_goals",()=>1), leagueAway=average(prior,"away_goals",()=>1);
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
        const map={frequency:{outcome:renormalize(counts)}};
        if(current.available){
          const g=distribution(current.lambda_home,current.lambda_away,0,10);
          if(g)map.current={...summary(g),outcome:["home_win","draw","away_win"].map(k=>current.probabilities[k]),
            btts:current.probabilities.btts_yes,over:current.probabilities.over_2_5};
        }
        const add=(name,rates,rho=0)=>{const values=rates&&distribution(...rates,rho);if(values)map[name]=summary(values);};
        for(const n of [5,10,15,20])add("window"+n,venue(n));
        add("recency",venue(20,i=>2**(-i/6)));
        const shrink=venue(20,()=>1,6);
        add("shrinkage",shrink);
        add("opponent",venue(20,()=>1,6,true));
        add("dixon_coles",shrink,-0.06);
        if(shrink){
          const adjust=Math.exp(Math.max(-0.35,Math.min(0.35,(get(home_team)-get(away_team))/1800)));
          add("elo",[shrink[0]*adjust,shrink[1]/adjust]);
        }
        results.push({target,map});
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
  const matches=seasons.flatMap(season=>{
    const raw=fs.readFileSync(directory+"/"+season+"/"+league+".json");
    hashes[season]=createHash("sha256").update(raw).digest("hex");
    return JSON.parse(raw).matches.filter(m=>Array.isArray(m.score?.ft)).map(m=>{
      assert(/^\d{4}-\d{2}-\d{2}$/.test(m.date)&&m.team1&&m.team2&&m.team1!==m.team2&&
        m.score.ft.length===2&&m.score.ft.every(g=>Number.isSafeInteger(g)&&g>=0));
      return {source:"openfootball",fixture_id:[league,m.date,m.team1,m.team2].join("|"),
        kickoff:m.date,home_team:m.team1,away_team:m.team2,home_goals:m.score.ft[0],away_goals:m.score.ft[1],
        identity_verified:true,score_verified:true,completed:true};
    });
  });
  assert.equal(new Set(matches.map(r=>r.fixture_id)).size,matches.length);
  const training=matches.filter(r=>r.kickoff<"2025-01-01").length;
  assert(training>75,"Training data missing for "+league);
  const validation=simulate(matches.filter(r=>r.kickoff<"2025-07-01"),"2025-01-01").filter(r=>r.map.shrinkage);
  const choices=[0.8,1,1.15,1.3,1.5,1.8,2.1].map(t=>[t,measures(validation.map(r=>({
    target:r.target,prediction:summary(temperature(r.map.shrinkage.values,t))
  }))).logLoss]);
  choices.sort((a,b)=>a[1]-b[1]);
  const [t]=choices[0];
  const test=simulate(matches,"2025-07-01");
  for(const r of test)if(r.map.shrinkage)r.map.calibrated=summary(temperature(r.map.shrinkage.values,t));
  const comparison=test.filter(r=>models.every(model=>r.map[model]));
  return {league,hashes,training,validation:validation.length,temperature:t,testFixtures:test.length,comparisonFixtures:comparison.length,
    results:Object.fromEntries(models.map(model=>[model,{coverage:test.filter(r=>r.map[model]).length/test.length,
      ...measures(comparison.map(r=>({target:r.target,prediction:r.map[model]})))}]))};
});
console.log(JSON.stringify({source:"https://github.com/openfootball/football.json",split:{
  training:"2024-25 before 2025-01-01",validation:"2025-01-01 through 2025-06-30",test:"2025-26"
},reports},null,2));
