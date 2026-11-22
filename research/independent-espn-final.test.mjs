import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyIndependentFinal} from './independent-espn-final.mjs';
const espnEvent={id:'401',date:'2026-11-21T18:00:00Z',status:{type:{state:'post',completed:true,name:'STATUS_FINAL'}},competitions:[{competitors:[{homeAway:'home',team:{id:'11'},score:'2'},{homeAway:'away',team:{id:'22'},score:'1'}]}]};
const independent={provider:'other-provider',evidenceId:'external:401',fixtureId:'401',leagueId:'tur.1',homeTeamId:'11',awayTeamId:'22',homeGoals:2,awayGoals:1,completed:true};
const verify=(event=espnEvent,other=independent)=>verifyIndependentFinal({espnEvent:event,independent:other,leagueId:'tur.1',verifiedAt:'2026-11-22T12:00:00Z'});
test('final result requires a separate provider with matching team identity and score',()=>{
 const result=verify();
 assert.equal(result.identity_verified,true);assert.equal(result.score_verified,true);
 assert.equal(result.homeGoals,2);assert.equal(result.awayGoals,1);
 assert.match(result.espnEvidenceSha256,/^[a-f0-9]{64}$/);
 assert.match(result.independentEvidenceSha256,/^[a-f0-9]{64}$/);
});
test('rejects false final, wrong scores, swapped teams, and ESPN as independent source',()=>{
 for(const status of [{state:'pre',completed:false,name:'STATUS_SCHEDULED'},{state:'post',completed:true,name:'STATUS_ABANDONED'}]){
  assert.throws(()=>verify({...espnEvent,status:{type:status}}),/not final/);
 }
 assert.throws(()=>verify(espnEvent,{...independent,awayGoals:2}),/mismatched/);
 assert.throws(()=>verify(espnEvent,{...independent,homeTeamId:'22'}),/mismatched/);
 assert.throws(()=>verify(espnEvent,{...independent,provider:'ESPN'}),/mismatched/);
 assert.throws(()=>verify(espnEvent,{...independent,completed:false}),/mismatched/);
 assert.throws(()=>verify({...espnEvent,competitions:[{competitors:[{homeAway:'home',team:{id:'11'},score:'2'},{homeAway:'home',team:{id:'22'},score:'1'}]}]}),/Ambiguous/);
 assert.throws(()=>verify({...espnEvent,competitions:[{competitors:[{homeAway:'home',team:{id:'11'},score:'NaN'},{homeAway:'away',team:{id:'22'},score:'1'}]}]}),/Invalid final scores/);
});
