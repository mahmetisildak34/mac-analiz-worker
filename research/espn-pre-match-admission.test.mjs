import test from 'node:test';
import assert from 'node:assert/strict';
import {admitEspnScoreboard,reportLeagueAdmissions} from './espn-pre-match-admission.mjs';
const kickoff='2026-12-01T18:00:00Z',capturedAt='2026-11-22T10:00:00Z';
const event=(id='123')=>({id,date:kickoff,status:{type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}},competitions:[{competitors:[{homeAway:'home',team:{id:'1'}},{homeAway:'away',team:{id:'2'}}]}]});
const payload=(events,slug='tur.1')=>({leagues:[{slug}],events});
test('accepts only ESPN pre-kickoff fixtures with distinct team identity and source hash',()=>{
 const r=admitEspnScoreboard(payload([event()]),{leagueId:'tur.1',capturedAt,now:capturedAt});
 assert.equal(r.inspected,1);assert.equal(r.validKickoff,1);assert.equal(r.eligible,1);
 assert.equal(r.accepted[0].provider,'ESPN');
 assert.match(r.accepted[0].providerPayloadSha256,/^[a-f0-9]{64}$/);
 assert.equal('models' in r.accepted[0],false);
});

test('accepts valid ESPN UTC kickoff timestamps with minute precision without inventing a time',()=>{
 const fixture={...event('minute-precision'),date:'2026-11-23T12:00Z'};
 const r=admitEspnScoreboard(payload([fixture]),{leagueId:'tur.1',capturedAt,now:capturedAt});
 assert.equal(r.validKickoff,1);
 assert.equal(r.eligible,1);
 assert.equal(r.accepted[0].kickoff,'2026-11-23T12:00Z');
});

test('rejects impossible calendar dates and malformed UTC timestamps',()=>{
 for(const date of ['2026-02-30T12:00Z','2026-11-23T25:00Z','2026-11-23T12:00','2026-11-23T12:00:00+00:00']){
  const r=admitEspnScoreboard(payload([{...event('bad-'+date),date}]),{leagueId:'tur.1',capturedAt,now:capturedAt});
  assert.equal(r.validKickoff,0,date);
  assert.equal(r.rejected.invalid_kickoff,1,date);
 }
});
test('rejects post-match, duplicate, wrong league, bad kickoff, teams and late capture',()=>{
 const badDate={...event('2'),date:'2026-13-40T18:00:00Z'};
 const finished={...event('3'),status:{type:{state:'post',completed:true}}};
 const badTeams={...event('4'),competitions:[{competitors:[{homeAway:'home',team:{id:'1'}},{homeAway:'away',team:{id:'1'}}]}]};
 const r=admitEspnScoreboard(payload([event(),event(),badDate,finished,badTeams]),{leagueId:'tur.1',capturedAt,now:capturedAt});
 assert.equal(r.inspected,5);assert.equal(r.eligible,1);assert.equal(r.validKickoff,3);
 assert.equal(r.rejected.missing_or_duplicate_fixture,1);
 assert.equal(r.rejected.invalid_kickoff,1);
 assert.equal(r.rejected.not_scheduled,1);
 assert.equal(r.rejected.invalid_team_identity,1);
 assert.equal(admitEspnScoreboard(payload([event()],'eng.1'),{leagueId:'tur.1',capturedAt,now:capturedAt}).eligible,0);
 assert.equal(admitEspnScoreboard(payload([event()]),{leagueId:'tur.1',capturedAt:kickoff,now:kickoff}).eligible,0);
});
test('league admission report never mistakes fixture discovery for real model predictions',()=>{
 const r=reportLeagueAdmissions([{leagueId:'tur.1',capturedAt,payload:payload([event()])},{leagueId:'eng.1',capturedAt,payload:payload([event('9')],'eng.1')}],{now:capturedAt});
 assert.equal(r.leagues['tur.1'].eligible,1);
 assert.equal(r.leagues['eng.1'].eligible,1);
 assert.equal(r.realPredictionCount,0);
 assert.equal(r.modelComparison.status,'insufficient_verified_pre_match_predictions');
 assert.throws(()=>reportLeagueAdmissions([{leagueId:'tur.1',capturedAt,payload:payload([])},{leagueId:'tur.1',capturedAt,payload:payload([])}],{now:capturedAt}),/Duplicate/);
});

test('rejects interrupted pre-state ESPN fixtures and conflicting league metadata',()=>{
 for(const name of ['STATUS_POSTPONED','STATUS_CANCELED','STATUS_CANCELLED','STATUS_ABANDONED','STATUS_SUSPENDED','STATUS_DELAYED','STATUS_INTERRUPTED']){
  const interrupted={...event('i'+name),status:{type:{state:'pre',completed:false,name}}};
  const result=admitEspnScoreboard(payload([interrupted]),{leagueId:'tur.1',capturedAt,now:capturedAt});
  assert.equal(result.eligible,0,name);
  assert.equal(result.rejected.not_scheduled,1,name);
 }
 const conflicting={leagues:[{slug:'tur.1'},{slug:'eng.1'}],events:[event()]};
 const result=admitEspnScoreboard(conflicting,{leagueId:'tur.1',capturedAt,now:capturedAt});
 assert.equal(result.eligible,0);
 assert.equal(result.rejected.league_mismatch,1);
});

test('pre-state alone cannot override final or unknown provider status',()=>{
 for(const name of ['STATUS_FINAL','STATUS_IN_PROGRESS','STATUS_HALFTIME','STATUS_UNKNOWN',undefined]){
  const fixture={...event('status'+String(name)),status:{type:{state:'pre',completed:false,name}}};
  const report=admitEspnScoreboard(payload([fixture]),{leagueId:'tur.1',capturedAt,now:capturedAt});
  assert.equal(report.eligible,0,String(name));
  assert.equal(report.rejected.not_scheduled,1,String(name));
 }
 for(const name of ['STATUS_SCHEDULED','STATUS_NOT_STARTED','STATUS_PRE_GAME','STATUS_PREGAME']){
  const fixture={...event('status'+name),status:{type:{state:'pre',completed:false,name}}};
  assert.equal(admitEspnScoreboard(payload([fixture]),{leagueId:'tur.1',capturedAt,now:capturedAt}).eligible,1,name);
 }
});

test('ESPN fixture admission fails closed when completed flag is missing or malformed',()=>{
 for(const completed of [undefined,null,'false',0,true]){
  const fixture={...event('flag'+String(completed)),status:{type:{state:'pre',name:'STATUS_SCHEDULED',completed}}};
  const result=admitEspnScoreboard(payload([fixture]),{leagueId:'tur.1',capturedAt,now:capturedAt});
  assert.equal(result.eligible,0,String(completed));
  assert.equal(result.rejected.not_scheduled,1,String(completed));
 }
 assert.equal(admitEspnScoreboard(payload([event('valid')]),{leagueId:'tur.1',capturedAt,now:capturedAt}).eligible,1);
});

test('league admission rejects one ESPN fixture identity claimed by two leagues',()=>{
 const inputs=[{leagueId:'tur.1',capturedAt,payload:payload([event('shared')],'tur.1')},
 {leagueId:'eng.1',capturedAt,payload:payload([event('shared')],'eng.1')}];
 assert.throws(()=>reportLeagueAdmissions(inputs,{now:capturedAt}),/Cross-league fixture identity collision/);
 inputs[1].payload=payload([event('distinct')],'eng.1');
 const report=reportLeagueAdmissions(inputs,{now:capturedAt});
 assert.equal(report.leagues['tur.1'].eligible,1);
 assert.equal(report.leagues['eng.1'].eligible,1);
 assert.equal(report.realPredictionCount,0);
});
