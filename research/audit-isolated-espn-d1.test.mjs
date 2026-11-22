import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {auditIsolatedEvidence} from './audit-isolated-espn-d1.mjs';
const makeRow=()=>{
 const stat=(shots,on,corners,fouls,possession,goals)=>[['totalShots',shots],['shotsOnTarget',on],['wonCorners',corners],['foulsCommitted',fouls],['possessionPct',possession],['totalGoals',goals]].map(([name,displayValue])=>({name,displayValue:String(displayValue)}));
 const event={id:'401234567',date:'2026-11-22T12:00:00Z',status:{type:{state:'post',completed:true}},competitions:[{competitors:[{homeAway:'home',score:'2',team:{id:'10',displayName:'Home'},statistics:stat(10,4,5,8,55,2)},{homeAway:'away',score:'1',team:{id:'20',displayName:'Away'},statistics:stat(8,3,2,11,45,1)}],details:[]}]};
 const raw_json=JSON.stringify(event),rawSha256=createHash('sha256').update(raw_json).digest('hex');
 return {source:'ESPN',fixture_id:'espn-tur.1-401234567',kickoff:event.date,status:'FT',home_team_id:10,away_team_id:20,home_team:'Home',away_team:'Away',home_goals:2,away_goals:1,raw_json,statistics_json:JSON.stringify({provider:'ESPN',validation:'completed_scoreboard_payload_structural_validation',independentCrossSourceVerification:false,rawSha256,home:{totalShots:10,shotsOnTarget:4,wonCorners:5,foulsCommitted:8,possessionPct:55,cards:{yellow:0,red:0}},away:{totalShots:8,shotsOnTarget:3,wonCorners:2,foulsCommitted:11,possessionPct:45,cards:{yellow:0,red:0}}})};
};
const mock=(rows)=>async(url,options)=>{
 assert.match(url,/fb9b42cc-8d96-4911-b193-0983527ee593\/query$/);
 assert.doesNotMatch(url,/b3103550|704a5c24/);
 assert.equal(options.method,'POST');
 const request=JSON.parse(options.body);
 assert.match(request.sql,/^SELECT /);
 assert.doesNotMatch(request.sql,/INSERT|UPDATE|DELETE|DROP|ALTER/i);
 return {ok:true,json:async()=>({success:true,result:[{results:rows}]})};
};
test('audits valid isolated ESPN rows without writes',async()=>{
 const result=await auditIsolatedEvidence({token:'fake',fetcher:mock([makeRow()])});
 assert.equal(result.passed,true);assert.equal(result.valid,1);assert.equal(result.leagues['tur.1'],1);
});
test('rejects tampered raw payload',async()=>{
 const row=makeRow();row.raw_json=row.raw_json.replace('Home','Tampered');
 const result=await auditIsolatedEvidence({token:'fake',fetcher:mock([row])});
 assert.equal(result.passed,false);assert.equal(result.invalid,1);
});
test('rejects duplicate fixtures',async()=>{
 const row=makeRow(),result=await auditIsolatedEvidence({token:'fake',fetcher:mock([row,row])});
 assert.equal(result.passed,false);assert.equal(result.invalid,1);
});
test('rejects empty results and missing token',async()=>{
 const result=await auditIsolatedEvidence({token:'fake',fetcher:mock([])});
 assert.equal(result.passed,false);
 await assert.rejects(auditIsolatedEvidence({fetcher:mock([])}),/token/);
});
test('fails closed on malformed API response',async()=>{
 await assert.rejects(auditIsolatedEvidence({token:'fake',fetcher:async()=>({ok:true,json:async()=>({success:true,result:[]})})}),/query failed/);
});
