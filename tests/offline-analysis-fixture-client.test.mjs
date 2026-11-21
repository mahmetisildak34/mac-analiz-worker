import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createOfflineAnalysisFixtureClient} from "../docs/offline-analysis-fixture-client.js";

const read=name=>JSON.parse(readFileSync(new URL("../docs/"+name,import.meta.url),"utf8"));
const client=createOfflineAnalysisFixtureClient(read("poisson-integration-examples.json"),read("archive-espn-example.json"));
const previous=globalThis.fetch;
try {
  globalThis.fetch=()=>{throw new Error("Offline fixtures must not call the network");};
  const archive=await client.getArchive();
  assert.equal(archive.status,200);
  assert.equal(archive.body.response[0].verification_evidence,"archived_espn_provider_payload");
  for(const period of ["full_time","first_half"]){
    const {status,body}=await client.getAnalysis(period);
    assert.equal(status,200);
    assert.equal(body.available,true);
    assert.equal(body.period,period);
    assert.equal(body.model_version,"venue-poisson-v1.2");
    assert.equal(body.calibration_status,"uncalibrated");
    assert(body.home_samples>=5&&body.away_samples>=5);
    assert.equal(Object.keys(body.totals).length,5);
    body.totals["2.5"].over=-1;
    assert((await client.getAnalysis(period)).body.totals["2.5"].over>=0);
  }
  for(const [scenario,reason] of [["missing_data","missing_league_averages"],["insufficient","insufficient_verified_venue_sample"]]){
    const {body}=await client.getAnalysis(scenario);
    assert.equal(body.available,false);
    assert.equal(body.reason,reason);
    assert.equal(body.probabilities,undefined);
  }
  const unavailable=await client.getAnalysis("api_error");
  assert.equal(unavailable.status,503);
  assert.equal(unavailable.body.probabilities,undefined);
  await assert.rejects(client.getAnalysis("typo"),RangeError);
} finally {
  globalThis.fetch=previous;
}
