// Validate completed ESPN scoreboard statistics without inventing missing fields.
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(x).digest('hex');
const integer=v=>{if(typeof v!=='string'&&typeof v!=='number')return null;const n=Number(v);return Number.isSafeInteger(n)&&n>=0?n:null;};
const numeric=v=>{if(typeof v!=='string'&&typeof v!=='number')return null;const n=Number(v);return Number.isFinite(n)?n:null;};
function statMap(team){const rows=team?.statistics;if(!Array.isArray(rows))return null;const out={};for(const row of rows){if(typeof row?.name==='string'){if(Object.hasOwn(out,row.name))return null;out[row.name]=row.displayValue;}}return out;}
export function normalizeCompletedEspnEvent(event,{leagueId,capturedAt}={}){
 const c=event?.competitions?.[0],teams=c?.competitors;
 if(!/^[a-z0-9.]+$/i.test(leagueId??'')||!Number.isFinite(Date.parse(capturedAt??'')))return {accepted:false,reason:'invalid_capture_context'};
 if(!/^\d{4}-\d\d-\d\dT.*Z$/.test(event?.date??''))return {accepted:false,reason:'invalid_kickoff'};
 const state=event?.status?.type;
 if(state?.state!=='post'||state?.completed!==true||!['STATUS_FULL_TIME','STATUS_FULL_TIME_AET','STATUS_FULL_TIME_PEN'].includes(state?.name))return {accepted:false,reason:'not_final'};
 if(!Array.isArray(teams)||teams.length!==2)return {accepted:false,reason:'invalid_competitors'};
 const home=teams.find(t=>t.homeAway==='home'),away=teams.find(t=>t.homeAway==='away');
 if(!home||!away||!/^\d+$/.test(String(home.team?.id??''))||!/^\d+$/.test(String(away.team?.id??''))||String(home.team.id)===String(away.team.id))return {accepted:false,reason:'invalid_team_identity'};
 const hs=statMap(home),as=statMap(away);if(!hs||!as)return {accepted:false,reason:'missing_or_duplicate_statistics'};
 const fields=['totalShots','shotsOnTarget','wonCorners','foulsCommitted','possessionPct'],values={home:{},away:{}};
 for(const [side,m] of [['home',hs],['away',as]])for(const field of fields){const v=field==='possessionPct'?numeric(m[field]):integer(m[field]);if(v===null)return {accepted:false,reason:'missing_or_invalid_'+field};values[side][field]=v;}
 for(const side of ['home','away'])if(values[side].shotsOnTarget>values[side].totalShots||values[side].possessionPct<0||values[side].possessionPct>100)return {accepted:false,reason:'inconsistent_'+side+'_statistics'};
 if(Math.abs(values.home.possessionPct+values.away.possessionPct-100)>0.25)return {accepted:false,reason:'possession_total_mismatch'};
 const homeGoals=integer(home.score),awayGoals=integer(away.score);
 if(homeGoals===null||awayGoals===null||integer(hs.totalGoals)!==homeGoals||integer(as.totalGoals)!==awayGoals)return {accepted:false,reason:'score_statistics_mismatch'};
 if(!Array.isArray(c.details))return {accepted:false,reason:'missing_card_event_details'};
 const cards={home:{yellow:0,red:0},away:{yellow:0,red:0}};
 for(const detail of c.details){const text=String(detail?.type?.text??'').toLowerCase(),yellow=detail?.yellowCard===true||text.includes('yellow card'),red=detail?.redCard===true||text.includes('red card');if(!yellow&&!red)continue;const teamId=String(detail?.team?.id??'');if(teamId===String(home.team.id)){if(yellow)cards.home.yellow++;if(red)cards.home.red++;}else if(teamId===String(away.team.id)){if(yellow)cards.away.yellow++;if(red)cards.away.red++;}else return {accepted:false,reason:'card_event_team_unresolved'};}
 values.home.cards=cards.home;values.away.cards=cards.away;
 const rawJson=JSON.stringify(event),rawSha256=hash(rawJson);
 const statistics={schemaVersion:1,provider:'ESPN',validation:'completed_scoreboard_payload_structural_validation',independentCrossSourceVerification:false,capturedAt,rawSha256,home:values.home,away:values.away};
 return {accepted:true,record:{source:'ESPN',fixture_id:'espn-'+leagueId+'-'+event.id,kickoff:event.date,status:'FT',home_team_id:Number(home.team.id),away_team_id:Number(away.team.id),home_team:home.team.displayName??home.team.name,away_team:away.team.displayName??away.team.name,home_goals:homeGoals,away_goals:awayGoals,statistics_json:JSON.stringify(statistics),raw_json:rawJson,raw_sha256:rawSha256,statistics_validation:statistics.validation}};
}
