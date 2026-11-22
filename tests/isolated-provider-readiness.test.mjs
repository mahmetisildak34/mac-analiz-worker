import test from 'node:test';
import assert from 'node:assert/strict';
import {isolatedProviderReadiness} from '../isolated-provider-readiness.js';
const valid={ISOLATED_STATISTICS_REPAIR_ENABLED:'true',ISOLATED_PROVIDER_FETCH_ENABLED:'true',TEST_WRITE_DB:{},API_FOOTBALL_KEY:'test-key',API_FOOTBALL_QUOTA_VERIFIED:'true',API_FOOTBALL_DAILY_LIMIT:'100',API_FOOTBALL_VERIFIED_LIMIT:'100'};
test('readiness does not claim live provider or D1 write verification',()=>{const r=isolatedProviderReadiness(valid);assert.equal(r.ready,true);assert.equal(r.liveProviderChecked,false);assert.equal(r.d1WriteChecked,false)});
test('readiness blocks production bindings and absent isolated D1',()=>{const r=isolatedProviderReadiness({...valid,DB:{},TEST_WRITE_DB:null});assert.equal(r.ready,false);assert.ok(r.blockers.includes('production_or_preview_binding_present'));assert.ok(r.blockers.includes('isolated_d1_missing'))});
test('readiness refuses invalid quota limits',()=>{for(const [daily,verified] of [['0','100'],['100','101'],['NaN','100'],['100','1.2']])assert.ok(isolatedProviderReadiness({...valid,API_FOOTBALL_DAILY_LIMIT:daily,API_FOOTBALL_VERIFIED_LIMIT:verified}).blockers.includes('quota_limits_invalid'))});
test('readiness refuses missing key and unverified quota',()=>{const r=isolatedProviderReadiness({...valid,API_FOOTBALL_KEY:'',API_FOOTBALL_QUOTA_VERIFIED:'false'});assert.ok(r.blockers.includes('provider_key_missing'));assert.ok(r.blockers.includes('quota_not_verified'))});
