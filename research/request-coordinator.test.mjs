import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestCoordinator} from './request-coordinator.mjs';
test('concurrent identical requests share one upstream operation',async()=>{
 const c=createRequestCoordinator();let calls=0;
 const load=async()=>{calls++;await Promise.resolve();return {ok:true};};
 const [a,b,c3]=await Promise.all([c.run('same',load),c.run('same',load),c.run('same',load)]);
 assert.equal(calls,1);assert.deepEqual(a,b);assert.deepEqual(b,c3);
});
test('cache respects TTL and expires deterministically',async()=>{
 let time=100,calls=0;const c=createRequestCoordinator({now:()=>time});
 const load=()=>++calls;
 assert.equal(await c.run('x',load,{ttlMs:50}),1);
 time=149;assert.equal(await c.run('x',load,{ttlMs:50}),1);
 time=150;assert.equal(await c.run('x',load,{ttlMs:50}),2);
});
test('quota blocks extra calls until window resets',async()=>{
 let time=0;const c=createRequestCoordinator({now:()=>time});let calls=0;
 const load=()=>++calls;
 assert.equal(await c.run('a',load,{provider:'free',limit:1,windowMs:100}),1);
 await assert.rejects(c.run('b',load,{provider:'free',limit:1,windowMs:100}),/quota exhausted/);
 assert.equal(calls,1);time=100;
 assert.equal(await c.run('b',load,{provider:'free',limit:1,windowMs:100}),2);
});
test('failed requests are not cached and are retriable',async()=>{
 const c=createRequestCoordinator();let calls=0;
 const load=()=>{calls++;if(calls===1)throw new Error('offline');return 2;};
 await assert.rejects(c.run('x',load,{ttlMs:100}));
 assert.equal(await c.run('x',load,{ttlMs:100}),2);
});
test('cache evicts oldest entry at capacity',async()=>{
 const c=createRequestCoordinator({maxEntries:1});
 await c.run('a',()=>1,{ttlMs:1000});
 await c.run('b',()=>2,{ttlMs:1000});
 assert.equal(c.stats().cached,1);
});

test('identical fixture keys from different providers cannot share cached responses',async()=>{
 const c=createRequestCoordinator();let calls=0;
 const a=await c.run('fixture:1',()=>{calls++;return 'ESPN';},{provider:'espn',ttlMs:1000});
 const b=await c.run('fixture:1',()=>{calls++;return 'Other';},{provider:'other',ttlMs:1000});
 assert.equal(a,'ESPN');assert.equal(b,'Other');assert.equal(calls,2);
});
test('identical in-flight fixture keys across providers are independent',async()=>{
 const c=createRequestCoordinator();let calls=0;
 const [a,b]=await Promise.all([
  c.run('same',()=>{calls++;return 'A';},{provider:'a'}),
  c.run('same',()=>{calls++;return 'B';},{provider:'b'})
 ]);
 assert.deepEqual([a,b],['A','B']);assert.equal(calls,2);
});
