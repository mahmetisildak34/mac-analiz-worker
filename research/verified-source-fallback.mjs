// Research-only provider failover. No API-Football calls or production bindings.
export class SourceUnavailableError extends Error {
 constructor(message='No verified source available'){super(message);this.name='SourceUnavailableError';}
}
export async function fetchVerifiedWithFallback(sources,{timeoutMs=3000,validate=()=>true,signal}={}){
 if(!Array.isArray(sources)||!sources.length||!Number.isFinite(timeoutMs)||timeoutMs<=0||typeof validate!=='function')throw new RangeError('Invalid fallback configuration');
 const attempts=[];
 for(const source of sources){
  if(signal?.aborted)throw signal.reason??new Error('Aborted');
  if(!source||typeof source.name!=='string'||typeof source.fetch!=='function')throw new TypeError('Invalid source');
  const controller=new AbortController();
  const onAbort=()=>controller.abort(signal.reason);
  signal?.addEventListener('abort',onAbort,{once:true});
  let timer;
  try{
   const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Source timeout'));},timeoutMs);});
   // Source adapters must honor the abort signal to avoid unbounded upstream work.
   const data=await Promise.race([Promise.resolve().then(()=>source.fetch({signal:controller.signal})),timeout]);
   if(!validate(data,source.name))throw new Error('Unverified source data');
   return {source:source.name,data,attempts};
  }catch(error){
   if(signal?.aborted)throw signal.reason??error;
   attempts.push({source:source.name,reason:error?.message||'Source failed'});
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',onAbort);}
 }
 const error=new SourceUnavailableError();
 error.attempts=attempts;
 throw error;
}
