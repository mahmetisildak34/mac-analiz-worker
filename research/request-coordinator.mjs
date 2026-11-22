// Research-only request coalescing, TTL caching and quota gating.
// No provider credentials, production bindings, or network requests are included.
export function createRequestCoordinator({now=()=>Date.now(),maxEntries=256}={}){
 if(typeof now!=='function'||!Number.isInteger(maxEntries)||maxEntries<1)throw new RangeError('Invalid coordinator configuration');
 const pending=new Map(),cache=new Map(),usage=new Map();
 const metrics={requests:0,cacheHits:0,coalesced:0,upstreamCalls:0,upstreamFailures:0,quotaRejected:0,upstreamLatencyMs:0};
 function getCached(key){
  const item=cache.get(key);
  if(!item)return undefined;
  if(item.expiresAt<=now()){cache.delete(key);return undefined;}
  cache.delete(key);cache.set(key,item);
  return item.value;
 }
 function reserve(provider,limit,windowMs){
  if(!Number.isInteger(limit)||limit<1||!Number.isFinite(windowMs)||windowMs<=0)throw new RangeError('Invalid quota');
  const key=String(provider);
  const t=now(),current=usage.get(key);
  const state=!current||t>=current.resetAt?{count:0,resetAt:t+windowMs}:current;
  if(state.count>=limit){usage.set(key,state);return false;}
  state.count++;usage.set(key,state);return true;
 }
 async function run(key,load,{ttlMs=0,provider='default',limit=Infinity,windowMs=60000}={}){
  if(typeof key!=='string'||!key||typeof load!=='function'||!Number.isFinite(ttlMs)||ttlMs<0)throw new RangeError('Invalid request');
  if(typeof provider!=='string'||!provider.trim())throw new RangeError('Invalid provider');
  const requestKey=JSON.stringify([provider,key]);
  metrics.requests++;
  const cached=getCached(requestKey);
  if(cached!==undefined){metrics.cacheHits++;return cached;}
  if(pending.has(requestKey)){metrics.coalesced++;return pending.get(requestKey);}
  if(limit!==Infinity&&!reserve(provider,limit,windowMs)){metrics.quotaRejected++;throw new Error('Provider quota exhausted');}
  const startedAt=now();
  metrics.upstreamCalls++;
  const task=Promise.resolve().then(load).then(value=>{
   metrics.upstreamLatencyMs+=Math.max(0,now()-startedAt);
   if(ttlMs>0&&value!==undefined){
    cache.delete(requestKey);cache.set(requestKey,{value,expiresAt:now()+ttlMs});
    while(cache.size>maxEntries)cache.delete(cache.keys().next().value);
   }
   return value;
  },error=>{
   metrics.upstreamFailures++;
   metrics.upstreamLatencyMs+=Math.max(0,now()-startedAt);
   throw error;
  }).finally(()=>pending.delete(requestKey));
  pending.set(requestKey,task);
  return task;
 }
 return {run,clear:()=>cache.clear(),stats:()=>({pending:pending.size,cached:cache.size,providers:usage.size,...metrics,cacheHitRate:metrics.requests?metrics.cacheHits/metrics.requests:0,meanUpstreamLatencyMs:metrics.upstreamCalls?metrics.upstreamLatencyMs/metrics.upstreamCalls:0})};
}
