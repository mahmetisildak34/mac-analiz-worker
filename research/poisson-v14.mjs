// Experimental Poisson v1.4 research model. No production integration.
// Point-in-time venue scoring rates and Dixon-Coles low-score dependence.
const finiteScore = value => Number.isInteger(value) && value >= 0 && value <= 30;
const parseTime = value => { const stamp=Date.parse(value??""); return Number.isFinite(stamp)?stamp:NaN; };
const teamKey = value => String(value??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("en").replace(/[^a-z0-9]/g,"");
const poissonPmf = (lambda,goals) => { let p=Math.exp(-lambda); for(let i=1;i<=goals;i++)p*=lambda/i; return p; };
function correction(home,away,rho,h,a){
 if(h===0&&a===0)return 1-home*away*rho;
 if(h===0&&a===1)return 1+home*rho;
 if(h===1&&a===0)return 1+away*rho;
 if(h===1&&a===1)return 1-rho;
 return 1;
}
export function exactScoreProbability(home,away,rho,homeGoals,awayGoals){
 if(![home,away,rho].every(Number.isFinite)||home<=0||away<=0||home>20||away>20)throw new RangeError("Invalid score probability input");
 if(homeGoals==null||awayGoals==null)return null;
 if(!finiteScore(homeGoals)||!finiteScore(awayGoals))throw new RangeError("Invalid score probability input");
 const tau=correction(home,away,rho,homeGoals,awayGoals);
 if(tau<0)throw new RangeError("Dixon-Coles correction produces negative probability");
 return poissonPmf(home,homeGoals)*poissonPmf(away,awayGoals)*tau;
}
export function scoreGrid(home,away,rho=0){
 if(![home,away,rho].every(Number.isFinite)||home<=0||away<=0||home>20||away>20)throw new RangeError("Invalid rates");
 if(rho<Math.max(-1/home,-1/away)||rho>Math.min(1,1/(home*away)))throw new RangeError("Invalid rho");
 const h=Array.from({length:101},(_,i)=>poissonPmf(home,i)),a=Array.from({length:101},(_,i)=>poissonPmf(away,i));
 let win=0,draw=0,loss=0,btts=0,over15=0,over25=0,over35=0,total=0;
 for(let i=0;i<h.length;i++)for(let j=0;j<a.length;j++){
  const p=h[i]*a[j]*correction(home,away,rho,i,j);total+=p;
  if(i>j)win+=p;else if(i===j)draw+=p;else loss+=p;
  if(i&&j)btts+=p;if(i+j>=2)over15+=p;if(i+j>=3)over25+=p;if(i+j>=4)over35+=p;
 }
 if(!(total>0)||Math.abs(total-1)>1e-10)throw new RangeError("Invalid score-grid probability mass");
 return {home:win/total,draw:draw/total,away:loss/total,btts:btts/total,over15:over15/total,over25:over25/total,over35:over35/total};
}
export function estimateRates(history,target,{window=10,halfLifeDays=90,period="full"}={}){
 if(!Array.isArray(history)||!target||!Number.isInteger(window)||window<1||window>100||!Number.isFinite(halfLifeDays)||halfLifeDays<=0||!["full","half"].includes(period))throw new RangeError("Invalid rate estimation input");
 const cutoff=parseTime(target.kickoff),home=teamKey(target.home_team),away=teamKey(target.away_team);
 if(!Number.isFinite(cutoff)||!home||!away||home===away)return null;
 const unique=new Map(),conflicts=new Set();
 for(const match of history){
  const date=parseTime(match?.kickoff);if(!Number.isFinite(date)||date>=cutoff||match.completed!==true)continue;
  const hg=period==="full"?match.home_goals:match.ht_home,ag=period==="full"?match.away_goals:match.ht_away;
  if(!finiteScore(hg)||!finiteScore(ag))continue;
  const h=teamKey(match.home_team),a=teamKey(match.away_team);if(!h||!a||h===a)continue;
  const key=[date,h,a].join("|"),row={date,h,a,hg,ag};
  if(conflicts.has(key))continue;
  if(unique.has(key)){const old=unique.get(key);if(old.hg!==hg||old.ag!==ag){unique.delete(key);conflicts.add(key);}continue;}
  unique.set(key,row);
 }
 const rows=[...unique.values()].sort((a,b)=>b.date-a.date);
 const homeVenue=rows.filter(r=>r.h===home).slice(0,window),awayVenue=rows.filter(r=>r.a===away).slice(0,window);
 if(!homeVenue.length||!awayVenue.length)return null;
 const weight=row=>Math.pow(.5,(cutoff-row.date)/(halfLifeDays*86400000));
 const mean=(items,field)=>{const denominator=items.reduce((s,r)=>s+weight(r),0);return denominator?items.reduce((s,r)=>s+r[field]*weight(r),0)/denominator:null;};
 const rates={home:mean(homeVenue,"hg"),away:mean(awayVenue,"ag"),homeSample:homeVenue.length,awaySample:awayVenue.length,excludedConflicts:conflicts.size};
 return [rates.home,rates.away].every(x=>Number.isFinite(x)&&x>0&&x<=20)?rates:null;
}
export function fitRho(rows,cutoff){
 if(!Array.isArray(rows)||!Number.isFinite(parseTime(cutoff)))throw new RangeError("Invalid rho fit input");
 const limit=parseTime(cutoff),seen=new Set(),sample=[];
 for(const row of rows){
  const date=parseTime(row?.kickoff),home=row?.home,away=row?.away;
  if(!Number.isFinite(date)||date>=limit||typeof row.fixtureId!=="string"||!row.fixtureId||seen.has(row.fixtureId)||
     !Number.isFinite(home)||!Number.isFinite(away)||home<=0||away<=0||!finiteScore(row.homeGoals)||!finiteScore(row.awayGoals))return null;
  seen.add(row.fixtureId);sample.push(row);
 }
 if(sample.length<24)return null;
 let low=-.15,high=.15;
 for(const row of sample){low=Math.max(low,-1/row.home,-1/row.away);high=Math.min(high,1,1/(row.home*row.away));}
 low+=1e-9;high-=1e-9;if(!(low<high))return null;
 const objective=rho=>{let score=0;for(const row of sample){const p=exactScoreProbability(row.home,row.away,rho,row.homeGoals,row.awayGoals);if(!(p>0))return Infinity;score-=Math.log(p);}return score;};
 const phi=(Math.sqrt(5)-1)/2;let x1=high-phi*(high-low),x2=low+phi*(high-low),f1=objective(x1),f2=objective(x2);
 for(let i=0;i<100;i++){if(f1<=f2){high=x2;x2=x1;f2=f1;x1=high-phi*(high-low);f1=objective(x1);}else{low=x1;x1=x2;f1=f2;x2=low+phi*(high-low);f2=objective(x2);}}
 const rho=(low+high)/2;return Number.isFinite(objective(rho))?rho:null;
}
