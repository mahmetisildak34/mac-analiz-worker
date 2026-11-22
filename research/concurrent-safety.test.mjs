import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequestCoordinator} from './request-coordinator.mjs';
import {fetchVerifiedWithFallback,SourceUnavailableError} from './verified-source-fallback.mjs';
test('100 simultaneous identical requests coalesce to one upstream and cache subsequent wave',async()=>{
 let loads=0;let release;
 const gate=new Promise(resolve=>{release=resolve;});
 const c=createRequestCoordinator();
 const wave=Array.from({length:100},()=>c.run('fixture:1',async()=>{loads++;await gate;return {fixtureId:'1'};},{provider:'espn',limit:1,ttlMs:1000}));
 await Promise.resolve();release();
 assert.equal((await Promise.all(wave)).length,100);
 assert.equal(loads,1);
 assert.equal(c.stats().coalesced,99);
 const second=await Promise.all(Array.from({length:100},()=>c.run('fixture:1',()=>{throw Error('cache miss');},{provider:'espn',limit:1,ttlMs:1000})));
 assert.equal(second.length,100);
 assert.equal(c.stats().cacheHits,100);
 assert.equal(c.stats().upstreamCalls,1);
});
test('100 distinct concurrent requests obey a shared provider quota',async()=>{
 const c=createRequestCoordinator();let loads=0;
 const outcomes=await Promise.allSettled(Array.from({length:100},(_,i)=>c.run('fixture:'+i,()=>{loads++;return i;},{provider:'espn',limit:7,windowMs:60000})));
 assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,7);
 assert.equal(outcomes.filter(x=>x.status==='rejected').length,93);
 assert.equal(loads,7);
 assert.equal(c.stats().quotaRejected,93);
});
test('provider outage and wrong fixture identity never produce invented statistics',async()=>{
 const sources=[{name:'primary',fetch:async()=>{throw Error('outage');}},{name:'backup',fetch:async()=>({fixtureId:'wrong',statistics:{shots:8}})}];
 await assert.rejects(fetchVerifiedWithFallback(sources,{validate:x=>x.fixtureId==='expected'&&Number.isFinite(x.statistics?.shots)}),e=>e instanceof SourceUnavailableError&&e.attempts.length===2);
 const missing=[{name:'primary',fetch:async()=>({fixtureId:'expected',statistics:{}})}];
 await assert.rejects(fetchVerifiedWithFallback(missing,{validate:x=>x.fixtureId==='expected'&&Number.isFinite(x.statistics?.shots)}),SourceUnavailableError);
});
