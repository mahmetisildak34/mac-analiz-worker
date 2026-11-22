// Offline, read-only freshness and data-quality classification. No network or database writes.
const FINAL=new Set(['FT','AET','PEN']);
const ACTIVE=new Set(['LIVE','IN','HT','1H','2H','ET']);
const asTime=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
export function classifyFixtureHealth(row,{nowMs=Date.now(),staleAfterMs=15*60*1000}={}){
 if(!row||typeof row!=='object'||!Number.isFinite(nowMs)||!Number.isFinite(staleAfterMs)||staleAfterMs<=0)throw new TypeError('Invalid fixture or health settings');
 const issues=[],status=String(row.status??'').toUpperCase(),kickoff=asTime(row.kickoff),checked=asTime(row.lastCheckedAt);
 if(!row.fixture_id||!row.source)issues.push('missing_identity');
 if(kickoff===null)issues.push('invalid_kickoff');
 if(checked!==null&&checked>nowMs+60000)issues.push('future_check_timestamp');
 if(ACTIVE.has(status)&&(!checked||nowMs-checked>staleAfterMs))issues.push('live_data_stale_or_unchecked');
 const hasScore=Number.isSafeInteger(row.home_goals)&&row.home_goals>=0&&Number.isSafeInteger(row.away_goals)&&row.away_goals>=0;
 if(FINAL.has(status)&&!hasScore)issues.push('final_score_missing_or_invalid');
 let stats=null;
 if(row.statistics_json!==null&&row.statistics_json!==undefined&&String(row.statistics_json).trim()!==''){
  try{stats=typeof row.statistics_json==='string'?JSON.parse(row.statistics_json):row.statistics_json;if(!stats||typeof stats!=='object'||Array.isArray(stats))throw Error('invalid');}
  catch{issues.push('invalid_statistics_json');}
 }
 if(FINAL.has(status)&&!stats)issues.push('final_statistics_missing_or_unverified');
 if(stats&&stats.independentCrossSourceVerification!==true)issues.push('not_independently_verified');
 const priority=issues.some(x=>x==='missing_identity'||x==='invalid_kickoff'||x==='final_score_missing_or_invalid'||x==='invalid_statistics_json')?'error':issues.length?'review':'ok';
 return {fixtureId:row.fixture_id??null,status,priority,issues,requiresProviderCheck:issues.length>0};
}
export function summarizeFixtureHealth(rows,options={}){
 if(!Array.isArray(rows))throw new TypeError('Rows must be an array');
 const fixtures=rows.map(row=>classifyFixtureHealth(row,options));
 return {total:fixtures.length,ok:fixtures.filter(x=>x.priority==='ok').length,review:fixtures.filter(x=>x.priority==='review').length,error:fixtures.filter(x=>x.priority==='error').length,fixtures};
}
