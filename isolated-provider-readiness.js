// Readiness preflight: never contacts API-Sports and never writes to D1.
// A green offline test is not evidence that live provider or D1 access works.
export function isolatedProviderReadiness(env) {
 const blockers=[];
 if(env?.ISOLATED_STATISTICS_REPAIR_ENABLED!=='true')blockers.push('isolated_repair_disabled');
 if(env?.ISOLATED_PROVIDER_FETCH_ENABLED!=='true')blockers.push('isolated_provider_disabled');
 if(!env?.TEST_WRITE_DB)blockers.push('isolated_d1_missing');
 if(env?.DB||env?.PRODUCTION_READ_DB||env?.PREVIEW_READ_DB)blockers.push('production_or_preview_binding_present');
 if(!env?.API_FOOTBALL_KEY)blockers.push('provider_key_missing');
 if(env?.API_FOOTBALL_QUOTA_VERIFIED!=='true')blockers.push('quota_not_verified');
 const daily=Number(env?.API_FOOTBALL_DAILY_LIMIT),verified=Number(env?.API_FOOTBALL_VERIFIED_LIMIT);
 if(!Number.isSafeInteger(daily)||daily<=0||!Number.isSafeInteger(verified)||verified<=0||verified>daily)blockers.push('quota_limits_invalid');
 return {ready:blockers.length===0,blockers,liveProviderChecked:false,d1WriteChecked:false};
}
