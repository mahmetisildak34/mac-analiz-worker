import test from 'node:test';
import assert from 'node:assert/strict';
import {auditPredictionProvenance} from './prediction-provenance.mjs';
const p=(predictedAt)=>({home:.5,draw:.3,away:.2,predictedAt});
const row=(date='2025-05-01T15:00:00Z',predictedAt='2025-05-01T14:59:59Z')=>({fixtureId:'fixture-1',date,identity_verified:true,score_verified:true,models:{'v1.2':p(predictedAt),'v1.3':p(predictedAt),'v1.4':p(predictedAt)}});
test('pre-kickoff evidence accepts paired models',()=>{const x=auditPredictionProvenance([row()]);assert.equal(x.acceptedCount,1);assert.equal(x.rejectedCount,0)});
test('post-kickoff and at-kickoff predictions are rejected',()=>{for(const time of ['2025-05-01T15:00:00Z','2025-05-01T15:00:01Z'])assert.equal(auditPredictionProvenance([row(undefined,time)]).rejected[0].reason,'missing_or_late_prediction_evidence')});
test('missing timestamp on one model rejects entire pair',()=>{const r=row();delete r.models['v1.4'].predictedAt;assert.equal(auditPredictionProvenance([r]).acceptedCount,0)});
test('duplicate fixture and unverified result fail closed',()=>{const r=row(),x=auditPredictionProvenance([r,r,{...r,fixtureId:'fixture-2',score_verified:false}]);assert.deepEqual(x.rejected.map(y=>y.reason),['duplicate_fixture_id','unverified_result'])});
test('date-only kickoff is rejected',()=>assert.equal(auditPredictionProvenance([row('2025-05-01')]).acceptedCount,0));

test('ambiguous local timestamps and invalid calendar dates cannot establish historical provenance',()=>{
 for(const kickoff of ['2025-05-01T15:00:00','2025-02-30T15:00:00Z','2025-05-01T15:00:00+14:30']){
  assert.equal(auditPredictionProvenance([row(kickoff)]).rejected[0].reason,'invalid_kickoff');
 }
 for(const stamp of ['2025-05-01T14:00:00','2025-02-30T14:00:00Z','2025-05-01T14:00:00+14:30']){
  assert.equal(auditPredictionProvenance([row(undefined,stamp)]).rejected[0].reason,'missing_or_late_prediction_evidence');
 }
});
test('explicit timezone offsets before kickoff remain acceptable',()=>{
 assert.equal(auditPredictionProvenance([row('2025-05-01T18:00:00+03:00','2025-05-01T17:59:59+03:00')]).acceptedCount,1);
});
