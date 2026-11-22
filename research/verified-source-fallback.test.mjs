import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchVerifiedWithFallback,SourceUnavailableError} from './verified-source-fallback.mjs';
test('first verified source wins without contacting other providers',async()=>{
 let second=0;
 const x=await fetchVerifiedWithFallback([{name:'archive',fetch:async()=>({verified:true})},{name:'backup',fetch:async()=>{second++;return {};}}],{validate:x=>x.verified===true});
 assert.equal(x.source,'archive');assert.equal(second,0);
});
test('invalid primary data triggers validated backup',async()=>{
 const x=await fetchVerifiedWithFallback([{name:'primary',fetch:async()=>({verified:false})},{name:'backup',fetch:async()=>({verified:true})}],{validate:x=>x.verified===true});
 assert.equal(x.source,'backup');assert.equal(x.attempts.length,1);
});
test('failed sources fail closed without inventing results',async()=>{
 await assert.rejects(fetchVerifiedWithFallback([{name:'broken',fetch:async()=>{throw new Error('offline');}}]),e=>e instanceof SourceUnavailableError&&e.attempts.length===1);
});
test('timeout proceeds to backup',async()=>{
 const x=await fetchVerifiedWithFallback([{name:'slow',fetch:()=>new Promise(()=>{})},{name:'backup',fetch:async()=>42}],{timeoutMs:10});
 assert.equal(x.data,42);assert.equal(x.attempts[0].reason,'Source timeout');
});
test('already aborted operation never contacts providers',async()=>{
 const controller=new AbortController();controller.abort();
 let called=false;
 await assert.rejects(fetchVerifiedWithFallback([{name:'x',fetch:()=>{called=true;return 1;}}],{signal:controller.signal}));
 assert.equal(called,false);
});
