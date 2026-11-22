// Offline admission for genuine ESPN pre-match fixtures. No network or D1 access.
// The caller must supply raw, independently fetched ESPN scoreboard JSON and
// independently timestamped feature/model evidence. A schedule is not a prediction.
import {createHash} from 'node:crypto';
const id=x=>typeof x==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(x);
const utc=x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(x)&&Number.isFinite(Date.parse(x))&&new Date(x).toISOString().replace('.000Z','Z')===x.replace('.000Z','Z')?Date.parse(x):NaN;
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
export function admitEspnScoreboard(payload,{leagueId,capturedAt,now=new Date().toISOString()}={}){
 if(!id(leagueId)||!Number.isFinite(utc(capturedAt))||!Number.isFinite(utc(now))||utc(capturedAt)>utc(now))
  throw new Error('Invalid league or capture timestamp');
 if(!payload||!Array.isArray(payload.events))throw new Error('Missing ESPN scoreboard events');
 const summary={leagueId,inspected:0,validKickoff:0,eligible:0,rejected:{},accepted:[]},seen=new Set();
 const reject=reason=>{summary.rejected[reason]=(summary.rejected[reason]??0)+1;};
 for(const event of payload.events){
  summary.inspected++;
  const fixtureId=String(event?.id??'');
  const competition=event?.competitions?.[0],competitors=competition?.competitors;
  const kickoff=event?.date;
  if(!id(fixtureId)||seen.has(fixtureId)){reject('missing_or_duplicate_fixture');continue;}
  seen.add(fixtureId);
  if(!Number.isFinite(utc(kickoff))){reject('invalid_kickoff');continue;}
  summary.validKickoff++;
  const status=event?.status?.type;
  if(status?.state!=='pre'||status?.completed!==false||!['STATUS_SCHEDULED','STATUS_NOT_STARTED','STATUS_PRE_GAME','STATUS_PREGAME'].includes(status?.name)){reject('not_scheduled');continue;}
  if(utc(kickoff)<=utc(now)||utc(kickoff)<=utc(capturedAt)){reject('already_started');continue;}
  if(!Array.isArray(competitors)||competitors.length!==2){reject('invalid_competitors');continue;}
  const home=competitors.find(x=>x.homeAway==='home'),away=competitors.find(x=>x.homeAway==='away');
  const homeTeamId=String(home?.team?.id??''),awayTeamId=String(away?.team?.id??'');
  if(!id(homeTeamId)||!id(awayTeamId)||homeTeamId===awayTeamId){reject('invalid_team_identity');continue;}
  const providerLeagues=payload?.leagues;
  // Never accept a scoreboard that explicitly identifies a different league.
  if(Array.isArray(providerLeagues)&&providerLeagues.some(x=>typeof x?.slug==='string'&&x.slug!==leagueId)){reject('league_mismatch');continue;}
  summary.eligible++;
  summary.accepted.push({fixtureId,leagueId,homeTeamId,awayTeamId,kickoff,provider:'ESPN',
   providerEvidenceId:'espn:'+leagueId+':'+fixtureId,providerPayloadSha256:hash(event),capturedAt});
 }
 return summary;
}
export function reportLeagueAdmissions(inputs,{now=new Date().toISOString()}={}){
 if(!Array.isArray(inputs))throw new TypeError('League inputs required');
 const leagues={},seen=new Set(),fixtureLeagues=new Map();
 for(const input of inputs){
  if(seen.has(input?.leagueId))throw new Error('Duplicate league');
  seen.add(input.leagueId);
  const report=admitEspnScoreboard(input.payload,{leagueId:input.leagueId,capturedAt:input.capturedAt,now});
  for(const fixture of report.accepted){
   const previous=fixtureLeagues.get(fixture.fixtureId);
   if(previous&&previous!==input.leagueId)throw new Error('Cross-league fixture identity collision');
   fixtureLeagues.set(fixture.fixtureId,input.leagueId);
  }
  leagues[input.leagueId]={inspected:report.inspected,validKickoff:report.validKickoff,
   eligible:report.eligible,recordedPreMatchPredictions:0,verifiedResultPairs:0,rejected:report.rejected};
 }
 return {leagues,realPredictionCount:0,modelComparison:{status:'insufficient_verified_pre_match_predictions'}};
}
