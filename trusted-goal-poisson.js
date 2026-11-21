// Pure goal-only Poisson: no dependence on seven optional match statistics.
const norm=s=>String(s??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const validScore=x=>(typeof x==="number"||typeof x==="string"&&x.trim()!=="")&&Number.isSafeInteger(Number(x))&&Number(x)>=0&&Number(x)<=30;
const prob=(lambda,k)=>{let p=Math.exp(-lambda);for(let i=1;i<=k;i++)p*=lambda/i;return p};
export function predictTrustedGoals(matches,{home_team,away_team,as_of,min_matches=3,max_goals=12}={}){
 const counts={total:Array.isArray(matches)?matches.length:0,used:0,excluded:0,reasons:{}};
 const exclude=reason=>{counts.excluded++;counts.reasons[reason]=(counts.reasons[reason]||0)+1};
 if(!Array.isArray(matches)||!home_team||!away_team||!Number.isFinite(Date.parse(as_of??"")))return {available:false,reason:"invalid_request",...counts};
 const home=norm(home_team),away=norm(away_team),seen=new Set(),h=[],a=[];
 if(!home||!away||home===away)return {available:false,reason:"invalid_teams",...counts};
 for(const m of matches){
  if(!m||m.identity_verified!==true||m.score_verified!==true||!m.source||m.fixture_id==null){exclude("unverified_identity_or_score");continue}
  const date=Date.parse(m.kickoff);if(!Number.isFinite(date)||date>=Date.parse(as_of)){exclude("invalid_or_future_date");continue}
  const mh=norm(m.home_team),ma=norm(m.away_team);
  if(!mh||!ma||mh===ma||m.conflicting===true){exclude("conflicting_teams");continue}
  if(!validScore(m.home_goals)||!validScore(m.away_goals)){exclude("invalid_score");continue}
  const key=String(m.source)+"|"+String(m.fixture_id);if(seen.has(key)){exclude("duplicate_fixture");continue}seen.add(key);
  if(mh===home){h.push(Number(m.home_goals));counts.used++}
  else if(ma===away){a.push(Number(m.away_goals));counts.used++}
  else exclude("not_relevant_to_home_away");
 }
 if(h.length<min_matches||a.length<min_matches)return {available:false,reason:"insufficient_verified_sample",home_samples:h.length,away_samples:a.length,...counts};
 const lambdaHome=h.reduce((x,y)=>x+y,0)/h.length,lambdaAway=a.reduce((x,y)=>x+y,0)/a.length;
 let homeWin=0,draw=0,awayWin=0,total=0;
 for(let i=0;i<=max_goals;i++)for(let j=0;j<=max_goals;j++){const p=prob(lambdaHome,i)*prob(lambdaAway,j);total+=p;if(i>j)homeWin+=p;else if(i===j)draw+=p;else awayWin+=p}
 return {available:true,model:"goal_only_poisson",home_samples:h.length,away_samples:a.length,lambda_home:lambdaHome,lambda_away:lambdaAway,probabilities:{home_win:homeWin/total,draw:draw/total,away_win:awayWin/total},data_quality:{score_and_identity_verified:true,seven_statistics_required:false},...counts};
}
