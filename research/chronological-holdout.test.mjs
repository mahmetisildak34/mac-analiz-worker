import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateChronologicalHoldout} from './chronological-holdout.mjs';
const models={'v1.2':{home:.5,draw:.3,away:.2},'v1.3':{home:.6,draw:.2,away:.2},'v1.4':{home:.7,draw:.2,away:.1}};
const rows=Array.from({length:20},(_,i)=>({fixtureId:String(i),date:new Date(Date.UTC(2025,0,i+1)).toISOString(),outcome:'home',models}));
test('chronological holdout evaluates the latest fixtures only',()=>{
 const result=evaluateChronologicalHoldout([...rows].reverse(),{minTrain:5,minHoldout:3});
 assert.equal(result.status,'evaluated');assert.equal(result.trainCount,16);assert.equal(result.holdoutCount,4);
 assert.equal(result.holdoutFrom,rows[16].date);
 assert.ok(result.models['v1.4'].brier<result.models['v1.2'].brier);
});
test('small samples fail closed',()=>assert.equal(evaluateChronologicalHoldout(rows).status,'insufficient_data'));
test('duplicate fixtures fail rather than inflate confidence',()=>assert.throws(()=>evaluateChronologicalHoldout([rows[0],rows[0]]),/metadata/));
test('equal timestamps at split boundary are rejected',()=>{
 const same=rows.map((r,i)=>({...r,date:i===15?rows[16].date:r.date}));
 assert.equal(evaluateChronologicalHoldout(same,{minTrain:5,minHoldout:3}).status,'ambiguous_boundary');
});
