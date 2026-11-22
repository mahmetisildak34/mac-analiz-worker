// Reproducible offline microbenchmark. No provider requests or production bindings.
// Measures identical-request fan-in with a simulated upstream delay and real Response cloning.
// Run: node --expose-gc research/benchmark-coordinator.mjs
import {performance} from 'node:perf_hooks';
import {createRequestCoordinator} from './request-coordinator.mjs';
import {fetchVerifiedWithFallback} from './verified-source-fallback.mjs';
import {coalesceResponse} from '../upstream-coalescer.js';
const runs=Number(process.env.BENCH_RUNS??1000);
if(!Number.isInteger(runs)||runs<1||runs>100000)throw new RangeError('BENCH_RUNS must be 1..100000');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const time=async fn=>{global.gc?.();const start=performance.now(),heapStart=process.memoryUsage().heapUsed;const result=await fn();return {elapsedMs:Number((performance.now()-start).toFixed(3)),heapDeltaBytes:process.memoryUsage().heapUsed-heapStart,...result};};
const baseline=await time(async()=>{
 let upstreamCalls=0;
 const responses=await Promise.all(Array.from({length:runs},async()=>{
  upstreamCalls++;await delay(5);return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});
 }));
 await Promise.all(responses.map(response=>response.arrayBuffer()));
 return {upstreamCalls};
});
const workerCoalesced=await time(async()=>{
 let upstreamCalls=0;
 const responses=await Promise.all(Array.from({length:runs},()=>coalesceResponse('same-fixture-request',async()=>{
  upstreamCalls++;await delay(5);return new Response(JSON.stringify({ok:true}),{headers:{'Content-Type':'application/json'}});
 },{'Access-Control-Allow-Origin':'https://app.test'})));
 await Promise.all(responses.map(response=>response.arrayBuffer()));
 if(upstreamCalls!==1)throw new Error('Worker coalescing invariant failed');
 return {upstreamCalls,coalescingFactor:runs/upstreamCalls};
});
const cached=await time(async()=>{
 let loads=0;const c=createRequestCoordinator();
 for(let i=0;i<runs;i++)await c.run('cached',async()=>{loads++;return {ok:true};},{ttlMs:60000,limit:1});
 if(loads!==1)throw new Error('Cache invariant failed');
 return {loads,...c.stats()};
});
const fallback=await time(async()=>{
 let primary=0,secondary=0;
 for(let i=0;i<runs;i++){
  const r=await fetchVerifiedWithFallback([{name:'primary',fetch:async()=>{primary++;throw new Error('offline simulated outage');}},{name:'secondary',fetch:async()=>{secondary++;return {verified:true};}}],{validate:x=>x.verified===true});
  if(r.source!=='secondary')throw new Error('Fallback invariant failed');
 }
 return {primary,secondary};
});
console.log(JSON.stringify({benchmark:'offline_identical_request_fan_in',runs,node:process.version,gcEnabled:typeof global.gc==='function',baseline,workerCoalesced,cached,fallback,comparisonNote:'Only mocked 5ms local upstream delay; no live provider, D1, quota or latency claim. In-flight coalescing is per Worker isolate; shared Cache API and D1 quota guard remain separate.'},null,2));
