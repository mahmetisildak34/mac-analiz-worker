// Research-only read-only refresh executor. Never writes D1 or calls a provider itself.
import {planFixtureChecks} from './fixture-check-planner.mjs';
import {createRequestCoordinator} from './request-coordinator.mjs';
export async function executeFixtureReadChecks(rows,{readFixture,nowMs=Date.now(),maxChecks=10,minRetryMs=300000,concurrency=2,timeoutMs=3000}={}){
 if(typeof readFixture!=='function'||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>5||!Number.isFinite(timeoutMs)||timeoutMs<=0)throw new TypeError('Invalid safe read configuration');
 const plan=planFixtureChecks(rows,{nowMs,maxChecks,minRetryMs});
 const coordinator=createRequestCoordinator();
 const results=new Array(plan.selected.length);
 let next=0;
 async function worker(){
  while(next<plan.selected.length){
   const i=next++,item=plan.selected[i];
   try{
    // The caller supplies a read-only adapter; do not pass credentials or write bindings.
    const controller=new AbortController();
    let timer;
    try{
     const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Read timeout'));},timeoutMs);});
     const value=await Promise.race([coordinator.run(item.fixtureId,()=>readFixture({fixtureId:item.fixtureId,source:item.source,signal:controller.signal}),{provider:item.source,limit:maxChecks||1,windowMs:60000}),timeout]);
     results[i]={fixtureId:item.fixtureId,status:'read',value};
    }finally{clearTimeout(timer);}
   }catch(error){results[i]={fixtureId:item.fixtureId,status:'failed',reason:String(error?.message??error)};}
  }
 }
 await Promise.all(Array.from({length:Math.min(concurrency,plan.selected.length)},()=>worker()));
 return {mode:'research-read-only',productionWrites:0,planned:plan.selected.length,deferred:plan.deferred.length,results,metrics:coordinator.stats()};
}
