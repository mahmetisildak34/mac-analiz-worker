import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateEvidenceRow,ingestRows} from './ingest-espn-statistics-d1.mjs';

function fixture(){
 const stat=(shots,on,corners,fouls,possession,goals)=>[
  ['totalShots',shots],['shotsOnTarget',on],['wonCorners',corners],
  ['foulsCommitted',fouls],['possessionPct',possession],['totalGoals',goals]
 ].map(([name,displayValue])=>({name,displayValue:String(displayValue)}));
 const event={id:'401234567',date:'2026-11-22T12:00:00Z',status:{type:{state:'post',completed:true,name:'STATUS_FULL_TIME'}},competitions:[{
  competitors:[{homeAway:'home',score:'2',team:{id:'10',displayName:'Home'},statistics:stat(10,4,5,8,55,2)},
   {homeAway:'away',score:'1',team:{id:'20',displayName:'Away'},statistics:stat(8,3,2,11,45,1)}],
  details:[{type:{text:'Yellow Card'},yellowCard:true,team:{id:'10'}}]
 }]};
 const row={source:'ESPN',fixture_id:'espn-tur.1-401234567',kickoff:event.date,status:'FT',home_team_id:10,away_team_id:20,home_team:'Home',away_team:'Away',home_goals:2,away_goals:1};
 const stats={schemaVersion:1,provider:'ESPN',validation:'completed_scoreboard_payload_structural_validation',independentCrossSourceVerification:false,
 home:{totalShots:10,shotsOnTarget:4,wonCorners:5,foulsCommitted:8,possessionPct:55,cards:{yellow:1,red:0}},
 away:{totalShots:8,shotsOnTarget:3,wonCorners:2,foulsCommitted:11,possessionPct:45,cards:{yellow:0,red:0}}};
 return {row,event,stats};
}
function pack({row,event,stats}){
 row.raw_json=JSON.stringify(event);
 row.raw_sha256=createHash('sha256').update(row.raw_json).digest('hex');
 stats.rawSha256=row.raw_sha256;
 row.statistics_json=JSON.stringify(stats);
 return row;
}
test('baseline ESPN evidence passes strict isolated admission',()=>{
 assert.equal(validateEvidenceRow(pack(fixture())).fixtureId,'espn-tur.1-401234567');
});
test('missing card-event evidence is rejected even when cards are zero',()=>{
 const x=fixture();delete x.event.competitions[0].details;
 assert.throws(()=>validateEvidenceRow(pack(x)),/card evidence/);
});
test('missing raw statistics is rejected',()=>{
 const x=fixture();delete x.event.competitions[0].competitors[0].statistics;
 assert.throws(()=>validateEvidenceRow(pack(x)),/Missing or duplicate raw statistics/);
});
test('duplicate raw statistics cannot override an earlier value',()=>{
 const x=fixture();x.event.competitions[0].competitors[0].statistics.push({name:'totalShots',displayValue:'10'});
 assert.throws(()=>validateEvidenceRow(pack(x)),/Missing or duplicate raw statistics/);
});
test('extra third competitor is rejected',()=>{
 const x=fixture();x.event.competitions[0].competitors.push({...x.event.competitions[0].competitors[0],homeAway:'neutral'});
 assert.throws(()=>validateEvidenceRow(pack(x)),/ambiguous competitor/);
});
test('tampered possession, shots and card totals are rejected',()=>{
 for(const field of ['possessionPct','shotsOnTarget']){
  const x=fixture();x.stats.home[field]+=1;
  assert.throws(()=>validateEvidenceRow(pack(x)),/mismatch/);
 }
 const x=fixture();x.stats.home.cards.yellow=0;
 assert.throws(()=>validateEvidenceRow(pack(x)),/Card totals/);
});
test('modified raw JSON without updated digest is rejected',()=>{
 const row=pack(fixture());row.raw_json=row.raw_json.replace('"Home"','"Fake"');
 assert.throws(()=>validateEvidenceRow(row),/hash/);
});
test('unverified or invented cross-source claim is rejected',()=>{
 const x=fixture();x.stats.independentCrossSourceVerification=true;
 assert.throws(()=>validateEvidenceRow(pack(x)),/provenance/);
});
test('duplicate rows fail before any isolated D1 write',async()=>{
 const row=pack(fixture());let calls=0;
 await assert.rejects(ingestRows([row,row],{apply:true,token:'fake',fetcher:async()=>{calls++;}}),/Duplicate/);
 assert.equal(calls,0);
});
test('dry run never contacts D1',async()=>{
 let calls=0;const result=await ingestRows([pack(fixture())],{fetcher:async()=>{calls++;}});
 assert.equal(result.validated,1);assert.equal(calls,0);
});
