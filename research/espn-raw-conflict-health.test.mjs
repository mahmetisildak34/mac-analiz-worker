import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyFixtureHealth,summarizeFixtureHealth} from './fixture-health-readonly.mjs';

const kickoff='2026-11-22T16:00:00Z';
const event=(overrides={})=>({
 id:'401888249',date:kickoff,
 status:{type:{name:'STATUS_FULL_TIME',state:'post',completed:true}},
 competitions:[{competitors:[
  {homeAway:'home',score:'2',team:{displayName:'Trabzonspor'}},
  {homeAway:'away',score:'1',team:{displayName:'Eyüpspor'}}
 ]}],
 ...overrides
});
const match=(overrides={})=>({
 source:'ESPN',fixture_id:'espn-tur.1-401888249',status:'FT',
 kickoff,home_goals:2,away_goals:1,
 raw_json:JSON.stringify(event()),
 statistics_json:JSON.stringify({independentCrossSourceVerification:false}),
 ...overrides
});
const health=record=>classifyFixtureHealth(record,{nowMs:Date.parse('2026-11-22T20:00:00Z')});
test('matching real-style ESPN snapshot stays review until independently verified',()=>{
 const result=health(match());
 assert.equal(result.priority,'review');
 assert.deepEqual(result.issues,['not_independently_verified']);
});
test('the wrong ESPN source event ID is a blocking conflict',()=>{
 const result=health(match({raw_json:JSON.stringify(event({id:'401888250'}))}));
 assert.equal(result.priority,'error');assert.ok(result.issues.includes('raw_fixture_id_mismatch'));
});
test('kickoff offset over one minute is a blocking conflict',()=>{
 const result=health(match({raw_json:JSON.stringify(event({date:'2026-11-22T16:05:00Z'}))}));
 assert.equal(result.priority,'error');assert.ok(result.issues.includes('raw_kickoff_mismatch'));
});
test('same instant expressed in +03:00 Istanbul timezone is not a conflict',()=>{
 const result=health(match({raw_json:JSON.stringify(event({date:'2026-11-22T19:00:00+03:00'}))}));
 assert.ok(!result.issues.includes('raw_kickoff_mismatch'));
});
test('raw full-time score difference triggers blocking review',()=>{
 const raw=event();raw.competitions[0].competitors[1].score='3';
 const result=health(match({raw_json:JSON.stringify(raw)}));
 assert.equal(result.priority,'error');assert.ok(result.issues.includes('raw_score_mismatch'));
});
test('malformed ESPN raw JSON is rejected, not assumed verified',()=>{
 const result=health(match({raw_json:'{broken'}));
 assert.equal(result.priority,'error');assert.ok(result.issues.includes('invalid_raw_json'));
});
test('missing raw ESPN snapshot does not fabricate independent verification',()=>{
 const result=health(match({raw_json:null}));
 assert.equal(result.priority,'review');assert.ok(result.issues.includes('not_independently_verified'));
});
test('invalid or unavailable raw scores are not invented',()=>{
 const raw=event();raw.competitions[0].competitors[0].score=null;
 const result=health(match({raw_json:JSON.stringify(raw)}));
 assert.ok(!result.issues.includes('raw_score_mismatch'));
});
test('non ESPN source is never interpreted as an ESPN event',()=>{
 const result=health(match({source:'TFF',raw_json:'{broken'}));
 assert.ok(!result.issues.includes('invalid_raw_json'));
});
test('batch summary counts raw-data conflicts',()=>{
 const all=summarizeFixtureHealth([match(),match({raw_json:JSON.stringify(event({id:'bad'}))}),match({raw_json:'{bad'})],{nowMs:Date.parse('2026-11-22T20:00:00Z')});
 assert.equal(all.total,3);assert.equal(all.error,2);assert.equal(all.review,1);
});

test('same match across two source IDs is reported but never removed',()=>{
 const a=match({league_id:'203',home_team:'Trabzonspor',away_team:'Eyüpspor',fixture_id:'espn-tur.1-401888249'});
 const b={...a,source:'TFF',fixture_id:'tff-99',raw_json:null,kickoff:'2026-11-22T19:00:00+03:00'};
 const summary=summarizeFixtureHealth([a,b],{nowMs:Date.parse('2026-11-22T20:00:00Z')});
 assert.equal(summary.total,2);
 assert.ok(summary.fixtures.every(f=>f.issues.includes('potential_cross_source_duplicate')));
});
test('duplicate audit never merges different leagues',()=>{
 const a=match({league_id:'203',home_team:'Trabzonspor',away_team:'Eyüpspor'});
 const b={...a,league_id:'39',source:'TFF',raw_json:null};
 const result=summarizeFixtureHealth([a,b]);
 assert.ok(result.fixtures.every(f=>!f.issues.includes('potential_cross_source_duplicate')));
});
test('duplicate audit never flags different opponents or distant kickoff',()=>{
 const a=match({league_id:'203',home_team:'Trabzonspor',away_team:'Eyüpspor'});
 const b={...a,source:'TFF',raw_json:null,away_team:'Fenerbahçe'};
 const c={...a,source:'TFF',raw_json:null,kickoff:'2026-11-22T16:12:00Z'};
 const result=summarizeFixtureHealth([a,b,c]);
 assert.ok(result.fixtures.every(f=>!f.issues.includes('potential_cross_source_duplicate')));
});
