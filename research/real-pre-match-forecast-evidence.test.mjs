import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const evidence=JSON.parse(await readFile(new URL('./real-pre-match-forecast-evidence-2026-11-22.json',import.meta.url),'utf8'));
const fields=evidence.predictionFields;

test('prospective v1.2 forecasts are point-in-time, source-linked and fully hashed',()=>{
 assert.equal(evidence.modelVersion,'1.2');
 assert.equal(evidence.fixtureCapture.configuredLeagues,38);
 assert.equal(evidence.fixtureCapture.capturedLeagues,38);
 assert.equal(evidence.fixtureCapture.eligiblePreMatchFixtures,117);
 assert.equal(evidence.fixtureCapture.captureFailures,0);
 assert.equal(evidence.coverage.modelInputsMeetingMinimumsAtQueryTime,25);
 assert.equal(evidence.coverage.predictionsRecorded,24);
 assert.equal(evidence.predictions.length,24);
 assert.equal(fields.length,25);
 const ids=new Set();
 for(const row of evidence.predictions){
  assert.equal(row.length,fields.length);
  assert.ok(!ids.has(row[0]),'duplicate fixture '+row[0]);ids.add(row[0]);
  assert.match(row[6],/^[a-f0-9]{64}$/);
  assert.match(row[24],/^[a-f0-9]{64}$/);
  assert.ok(Date.parse(row[2])>Date.parse(evidence.generatedAt),'prediction must precede kickoff '+row[0]);
  assert.ok(row[7]>=5&&row[7]<=10,'home venue sample '+row[0]);
  assert.ok(row[8]>=5&&row[8]<=10,'away venue sample '+row[0]);
  assert.ok(row[15]>=30,'league baseline sample '+row[0]);
  assert.ok(row[16]>0&&row[17]>0,'positive expected goals '+row[0]);
  assert.ok(Math.abs(row[18]+row[19]+row[20]-1)<1e-9,'1X2 probabilities '+row[0]);
  for(const index of [21,22])assert.ok(row[index]>=0&&row[index]<=1,'bounded probability '+row[0]);
  const digest=createHash('sha256').update(JSON.stringify(row.slice(0,-1))).digest('hex');
  assert.equal(row[24],digest,'evidence digest '+row[0]);
  assert.equal(row[23].length,3);
 }
});

test('halftime forecasts remain unavailable without verified halftime archive evidence',()=>{
 assert.equal(evidence.coverage.halfTimePredictions,0);
 assert.ok(evidence.limitations.some(x=>x.includes('halftime-score history')));
});
