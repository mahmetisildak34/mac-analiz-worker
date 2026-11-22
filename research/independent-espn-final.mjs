// Read-only ESPN final-result admission. This module never invents independent verification.
// A second provider's matching identity and score must be supplied explicitly.
import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const score=x=>Number.isInteger(x)&&x>=0;
function extract(event){
 if(!event||!validId(String(event.id??'')))throw new Error('Invalid ESPN fixture identity');
 const status=event.status?.type;
 if(status?.state!=='post'||status?.completed!==true||status?.name!=='STATUS_FINAL')throw new Error('ESPN fixture is not final');
 const competitors=event.competitions?.[0]?.competitors;
 if(!Array.isArray(competitors)||competitors.length!==2)throw new Error('Invalid ESPN competitors');
 const home=competitors.find(x=>x.homeAway==='home'),away=competitors.find(x=>x.homeAway==='away');
 if(!home||!away||home===away||competitors.filter(x=>x.homeAway==='home').length!==1||competitors.filter(x=>x.homeAway==='away').length!==1)throw new Error('Ambiguous home/away');
 const homeTeamId=String(home.team?.id??''),awayTeamId=String(away.team?.id??'');
 if(!validId(homeTeamId)||!validId(awayTeamId)||homeTeamId===awayTeamId)throw new Error('Invalid team identities');
 const homeGoals=Number(home.score),awayGoals=Number(away.score);
 if(!score(homeGoals)||!score(awayGoals)||!/^\d+$/.test(String(home.score))||!/^\d+$/.test(String(away.score)))throw new Error('Invalid final scores');
 if(typeof event.date!=='string'||!Number.isFinite(Date.parse(event.date)))throw new Error('Invalid kickoff');
 return {fixtureId:String(event.id),homeTeamId,awayTeamId,homeGoals,awayGoals,date:event.date};
}
export function verifyIndependentFinal({espnEvent,leagueId,independent,verifiedAt=new Date().toISOString()}={}){
 if(!validId(leagueId)||!Number.isFinite(Date.parse(verifiedAt)))throw new Error('Invalid verification metadata');
 const result=extract(espnEvent);
 if(Date.parse(verifiedAt)<Date.parse(result.date))throw new Error('Result verified before kickoff');
 if(!independent||independent.provider==='ESPN'||!validId(independent.provider)||!validId(independent.evidenceId)||
  independent.fixtureId!==result.fixtureId||independent.leagueId!==leagueId||
  independent.homeTeamId!==result.homeTeamId||independent.awayTeamId!==result.awayTeamId||
  independent.homeGoals!==result.homeGoals||independent.awayGoals!==result.awayGoals||
  independent.completed!==true)throw new Error('Independent final result evidence missing or mismatched');
 return {...result,leagueId,identity_verified:true,score_verified:true,
  espnEvidenceSha256:digest(espnEvent),independentProvider:independent.provider,
  independentEvidenceId:independent.evidenceId,independentEvidenceSha256:digest(independent),verifiedAt};
}
