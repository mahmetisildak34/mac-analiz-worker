import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveVerifiedApiSportsEvidence,persistIsolatedVerifiedStatistics} from '../isolated-verified-statistics-repair.js';
const fixture={source:'api-football',fixture_id:'123',kickoff:'2026-11-21T13:00:00Z',status:'FT',home_team_id:10,away_team_id:20,home_team:'Home',away_team:'Away',home_goals:2,away_goals:1};
const stats=[['Total Shots',12],['Shots on Target',5],['Ball Possession','55%'],['Corner Kicks',4],['Fouls',10],['Yellow Cards',2],['Red Cards',0]];
const fixtureResponse={response:[{fixture:{id:123,date:fixture.kickoff,status:{short:'FT'}},teams:{home:{id:10,name:'Home'},away:{id:20,name:'Away'}},goals:{home:2,away:1}}]};
const statisticsResponse={response:[{team:{id:10,name:'Home'},statistics:stats.map(([type,value])=>({type,value}))},{team:{id:20,name:'Away'},statistics:stats.map(([type,value],i)=>({type,value:i===2?'45%':value}))}]};
const clone=x=>structuredClone(x);
test('accept independent fixture and complete statistics responses',()=>assert.equal(deriveVerifiedApiSportsEvidence(fixture,fixtureResponse,statisticsResponse).state,'verified'));
for(const [name,mutate] of [
 ['forged verification flags are insufficient',(f,p,s)=>{p.response=[];s.provider_verified=true;s.identity_verified=true}],
 ['provider fixture id conflict',(f,p)=>{p.response[0].fixture.id=999}],
 ['provider kickoff conflict',(f,p)=>{p.response[0].fixture.date='2026-11-20T13:00:00Z'}],
 ['provider score conflict',(f,p)=>{p.response[0].goals.home=3}],
 ['provider team identity conflict',(f,p)=>{p.response[0].teams.home.id=30}],
 ['statistics team identity conflict',(f,p,s)=>{s.response[0].team.id=30}],
 ['incomplete statistics',(f,p,s)=>{s.response[0].statistics.pop()}],
 ['contradictory possession',(f,p,s)=>{s.response[1].statistics[2].value='80%'}],
 ['nonfinal provider status',(f,p)=>{p.response[0].fixture.status.short='NS'}],
 ['unsupported source',(f)=>{f.source='ESPN'}]
]) test('reject '+name,()=>{const f=clone(fixture),p=clone(fixtureResponse),s=clone(statisticsResponse);mutate(f,p,s);assert.equal(deriveVerifiedApiSportsEvidence(f,p,s).state,'rejected')});
test('isolated repair is disabled without explicit test binding and flag',async()=>{assert.equal((await persistIsolatedVerifiedStatistics({},fixture,fixtureResponse,statisticsResponse)).state,'disabled');assert.equal((await persistIsolatedVerifiedStatistics({ISOLATED_STATISTICS_REPAIR_ENABLED:'true',TEST_WRITE_DB:{},DB:{}},fixture,fixtureResponse,statisticsResponse)).state,'disabled')});
test('isolated repair writes only matching empty row',async()=>{
 let row={...fixture,statistics_json:null},writes=0;
 const db={prepare(sql){let args=[];return {bind(...v){args=v;return this},async first(){return row && row.source===args[0] && row.fixture_id===args[1] ? {...row}:null},async run(){writes++;if(row.statistics_json!==null)return {meta:{changes:0}};row.statistics_json=args[0];return {meta:{changes:1}}}}}};
 const env={ISOLATED_STATISTICS_REPAIR_ENABLED:'true',TEST_WRITE_DB:db};
 assert.equal((await persistIsolatedVerifiedStatistics(env,fixture,fixtureResponse,statisticsResponse)).state,'saved');
 assert.equal(writes,1);
 assert.equal((await persistIsolatedVerifiedStatistics(env,fixture,fixtureResponse,statisticsResponse)).state,'already_populated');
 assert.equal(writes,1);
});
test('isolated repair refuses stale row before write',async()=>{
 let writes=0;const db={prepare(){return {bind(){return this},async first(){return {...fixture,home_goals:7,statistics_json:null}},async run(){writes++;return {meta:{changes:1}}}}}};
 assert.equal((await persistIsolatedVerifiedStatistics({ISOLATED_STATISTICS_REPAIR_ENABLED:'true',TEST_WRITE_DB:db},fixture,fixtureResponse,statisticsResponse)).state,'stale_or_conflicting');
 assert.equal(writes,0);
});
