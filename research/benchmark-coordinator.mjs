// Reproducible offline microbenchmark. No provider requests, no production bindings.
// Run: node --expose-gc research/benchmark-coordinator.mjs
import {performance} from 'node:perf_hooks';
import {createRequestCoordinator} from './request-coordinator.mjs';
import {fetchVerifiedWithFallback} from './verified-source-fallback.mjs';
const runs=Number(process.env.BENCH_RUNS??1000);
if(!Number.isInteger(runs)||runs<1||runs>100000)throw new RangeError('BENCH_RUNS must be 1..100000');
const time=async fn=>{global.gc?.();const start=performance.now(),heapStart=process.memoryUsage().heapUsed;const result=await fn();return {elapsedMs:Number((performance.now()-start).toFixed(3)),heapDeltaBytes:process.memoryUsage().heapUsed-heapStart,...result};};
const baseline=await time(async()=>{
 let loads=0;
 await Promise.all(Array.from({length:runs},async()=>{loads++;return {ok:true};}));
 return {loads};
});
const coalesced=await time(async()=>{
 let loads=0;const c=createRequestCoordinator();
 await Promise.all(Array.from({length:runs},()=>c.run('same',async()=>{loads++;return {ok:true};},{ttlMs:0,limit:1})));
 if(loads!==1)throw new Error('Coalescing invariant failed');
 return {loads,...c.stats()};
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
console.log(JSON.stringify({benchmark:'offline_coordinator',runs,node:process.version,gcEnabled:typeof global.gc==='function',baseline,coalesced,cached,fallback,comparisonNote:'Baseline executes trivial local promises without coordinator; not an equivalent provider workload and not a speedup claim'},null,2));
