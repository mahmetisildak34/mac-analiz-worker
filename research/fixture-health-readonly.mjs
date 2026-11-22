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
 // Reconcile stored ESPN rows with the immutable raw scoreboard snapshot when available.
 // This is a read-only consistency check, not independent cross-source validation.
 if(String(row.source??'').toLowerCase()==='espn'&&row.raw_json!=null&&String(row.raw_json).trim()!==''){
  let raw=null;
  try{
   raw=typeof row.raw_json==='string'?JSON.parse(row.raw_json):row.raw_json;
   if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('bad raw');
  }catch{issues.push('invalid_raw_json');}
  if(raw){
   const rawId=String(raw.id??'');
   const storedId=String(row.fixture_id??'');
   if(rawId&&storedId.startsWith('espn-')&&!storedId.endsWith('-'+rawId))issues.push('raw_fixture_id_mismatch');
   const originalTime=asTime(raw.date);
   if(kickoff!==null&&originalTime!==null&&Math.abs(kickoff-originalTime)>60000)issues.push('raw_kickoff_mismatch');
   const sides=raw.competitions?.[0]?.competitors;
   if(Array.isArray(sides)){
    const home=sides.find(x=>x?.homeAway==='home'),away=sides.find(x=>x?.homeAway==='away');
    const score=x=>x?.score===null||x?.score===undefined||x?.score===''?null:Number(x.score);
    const h=score(home),a=score(away);
    if(home&&away&&Number.isSafeInteger(h)&&h>=0&&Number.isSafeInteger(a)&&a>=0&&
      Number.isSafeInteger(row.home_goals)&&Number.isSafeInteger(row.away_goals)&&
      (row.home_goals!==h||row.away_goals!==a))issues.push('raw_score_mismatch');
   }
  }
 }
 if(FINAL.has(status)&&!stats)issues.push('final_statistics_missing_or_unverified');
 if(stats&&stats.independentCrossSourceVerification!==true)issues.push('not_independently_verified');
 const priority=issues.some(x=>x==='missing_identity'||x==='invalid_kickoff'||x==='final_score_missing_or_invalid'||x==='invalid_statistics_json'||x==='invalid_raw_json'||x==='raw_fixture_id_mismatch'||x==='raw_kickoff_mismatch'||x==='raw_score_mismatch')?'error':issues.length?'review':'ok';
 return {fixtureId:row.fixture_id??null,status,priority,issues,requiresProviderCheck:issues.length>0};
}
export function summarizeFixtureHealth(rows,options={}){
 if(!Array.isArray(rows))throw new TypeError('Rows must be an array');
 const fixtures=rows.map(row=>classifyFixtureHealth(row,options));
 // Report potential cross-source doubles, never delete or automatically merge rows.
 // Exact league + team identities and nearby kickoff are required.
 const normalize=value=>String(value??'').toLocaleLowerCase('tr-TR').normalize('NFD')
  .replace(/\p{M}/gu,'').replace(/ı/g,'i').replace(/[^a-z0-9]/g,'');
 const seen=new Map();
 rows.forEach((row,index)=>{
  const league=String(row?.league_id??''),home=normalize(row?.home_team),away=normalize(row?.away_team);
  const kickoff=asTime(row?.kickoff);
  if(!league||home.length<4||away.length<4||kickoff===null)return;
  const key=JSON.stringify([league,home,away]);
  const previous=seen.get(key)||[];
  const duplicates=previous.filter(item=>Math.abs(kickoff-item.kickoff)<=10*60*1000);
  if(duplicates.length){
   // Separate mismatched provider snapshots from mere repeated identities.
   // Never interpret a scheduled 0-0 placeholder as an independently verified score.
   const note=(item,issue)=>{
    const health=fixtures[item];
    if(!health.issues.includes(issue))health.issues.push(issue);
    if(health.priority==='ok')health.priority='review';
    health.requiresProviderCheck=true;
   };
   for(const previousRow of duplicates){
    const other=rows[previousRow.index];
    if(String(other.source??'').toLowerCase()===String(row.source??'').toLowerCase())continue;
    const oldStatus=String(other.status??'').toUpperCase(),newStatus=String(row.status??'').toUpperCase();
    if(oldStatus&&newStatus&&oldStatus!==newStatus){
     note(previousRow.index,'cross_source_status_disagreement');
     note(index,'cross_source_status_disagreement');
    }
    const scores=[other.home_goals,other.away_goals,row.home_goals,row.away_goals];
    if(scores.every(x=>Number.isSafeInteger(x)&&x>=0)&&
      (other.home_goals!==row.home_goals||other.away_goals!==row.away_goals)){
     note(previousRow.index,'cross_source_score_disagreement');
     note(index,'cross_source_score_disagreement');
    }
   }
   for(const matched of [...duplicates,{index}]){
    const fixture=fixtures[matched.index];
    if(!fixture.issues.includes('potential_cross_source_duplicate')){
     fixture.issues.push('potential_cross_source_duplicate');
     if(fixture.priority==='ok')fixture.priority='review';
     fixture.requiresProviderCheck=true;
    }
   }
  }
  previous.push({index,kickoff});
  seen.set(key,previous);
 });
 return {total:fixtures.length,ok:fixtures.filter(x=>x.priority==='ok').length,review:fixtures.filter(x=>x.priority==='review').length,error:fixtures.filter(x=>x.priority==='error').length,fixtures};
}
