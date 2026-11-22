import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchAndRepairIsolatedApiSports} from '../isolated-provider-fetch.js';
const fixture={source:'api-football',fixture_id:'123',kickoff:'2026-11-21T13:00:00Z',status:'FT',home_team_id:10,away_team_id:20,home_team:'Home',away_team:'Away',home_goals:2,away_goals:1};
const stats=[['Total Shots',12],['Shots on Target',5],['Ball Possession','55%'],['Corner Kicks',4],['Fouls',10],['Yellow Cards',2],['Red Cards',0]];
const responses=[{response:[{fixture:{id:123,date:fixture.kickoff,status:{short:'FT'}},teams:{home:{id:10,name:'Home'},away:{id:20,name:'Away'}},goals:{home:2,away:1}}]},{response:[{team:{id:10,name:'Home'},statistics:stats.map(([type,value])=>({type,value}))},{team:{id:20,name:'Away'},statistics:stats.map(([type,value],i)=>({type,value:i===2?'45%':value}))}]}];
function mockDb(){let row={...fixture,statistics_json:null},quota=0;return {prepare(sql){let args=[];return {bind(...v){args=v;return this},async first(){if(sql.startsWith('SELECT used'))return {used:quota};if(sql.startsWith('UPDATE mam_api_quota_guard')){quota++;return {used:quota}}return {...row}},async run(){row.statistics_json=args[0];return {meta:{changes:1}}}}},getRow(){return row},getQuota(){return quota}}}
const env=db=>({ISOLATED_STATISTICS_REPAIR_ENABLED:'true',ISOLATED_PROVIDER_FETCH_ENABLED:'true',TEST_WRITE_DB:db,API_FOOTBALL_KEY:'mock-key',API_FOOTBALL_QUOTA_VERIFIED:'true',API_FOOTBALL_DAILY_LIMIT:'100',API_FOOTBALL_VERIFIED_LIMIT:'100'});
test('no requests without all isolation and quota gates',async()=>{let calls=0;const r=await fetchAndRepairIsolatedApiSports({},fixture,async()=>{calls++});assert.equal(r.state,'disabled');assert.equal(calls,0)});
test('mocked provider responses permit isolated write',async()=>{const db=mockDb(),urls=[];const r=await fetchAndRepairIsolatedApiSports(env(db),fixture,async url=>{urls.push(url);return {ok:true,url,json:async()=>responses[urls.length-1]}});assert.equal(r.state,'saved');assert.equal(urls.length,2);assert.ok(urls.every(x=>x.startsWith('https://v3.football.api-sports.io/')));assert.ok(db.getRow().statistics_json)});
test('provider fixture conflict blocks isolated write',async()=>{const db=mockDb();let n=0;const r=await fetchAndRepairIsolatedApiSports(env(db),fixture,async url=>({ok:true,url,json:async()=>{const body=structuredClone(responses[n++]);if(n===1)body.response[0].fixture.id=999;return body}}));assert.equal(r.state,'rejected');assert.equal(db.getRow().statistics_json,null)});
test('provider API error blocks isolated write',async()=>{const db=mockDb();const r=await fetchAndRepairIsolatedApiSports(env(db),fixture,async url=>({ok:true,url,json:async()=>({errors:{token:'quota exceeded'},response:[]})}));assert.equal(r.state,'provider_unusable');assert.equal(db.getRow().statistics_json,null)});
test('redirected provider URL blocks isolated write',async()=>{const db=mockDb();const r=await fetchAndRepairIsolatedApiSports(env(db),fixture,async()=>({ok:true,url:'https://example.com/redirect'}));assert.equal(r.state,'provider_unavailable');assert.equal(db.getRow().statistics_json,null)});

test('two provider calls each consume atomic shared quota reservation',async()=>{const db=mockDb();let n=0;const r=await fetchAndRepairIsolatedApiSports(env(db),fixture,async url=>({ok:true,url,json:async()=>structuredClone(responses[n++])}));assert.equal(r.state,'saved');assert.equal(db.getQuota(),2)});
test('quota reservation failure makes zero provider requests',async()=>{let calls=0;const db={prepare(){throw Error('quota table unavailable')}};const r=await fetchAndRepairIsolatedApiSports(env(db),fixture,async()=>{calls++});assert.equal(r.state,'quota_unavailable');assert.equal(calls,0)});

test('second reservation waits for rate slot without extra provider calls',async()=>{
 const db=mockDb(),original=db.prepare.bind(db);let reservations=0,waits=0,calls=0;
 db.prepare=sql=>{const stmt=original(sql);if(sql.startsWith('UPDATE mam_api_quota_guard')){const first=stmt.first.bind(stmt);stmt.first=async()=>{reservations++;if(reservations===2)return null;return first()};}return stmt};
 const result=await fetchAndRepairIsolatedApiSports(env(db),fixture,async url=>({ok:true,url,json:async()=>structuredClone(responses[calls++])}),async ms=>{assert.equal(ms,8100);waits++});
 assert.equal(result.state,'saved');assert.equal(waits,1);assert.equal(calls,2);assert.equal(reservations,3);
});
test('lookalike provider hostname is rejected',async()=>{
 const db=mockDb();
 const result=await fetchAndRepairIsolatedApiSports(env(db),fixture,async()=>({ok:true,url:'https://v3.football.api-sports.io.evil.example/fixtures?id=123'}));
 assert.equal(result.state,'provider_unavailable');assert.equal(db.getRow().statistics_json,null);
});
