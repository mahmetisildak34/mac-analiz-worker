import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const code=fs.readFileSync(new URL("../worker.js",import.meta.url),"utf8");
const start=code.indexOf("          const sameDate = (x,y) =>");
const end=code.indexOf("          return {",start);
assert.ok(start>0&&end>start,"archive proof classifier must exist");
const norm=s=>String(s??"").normalize("NFKD").replace(/[\\u0300-\\u036f]/g,"").toLowerCase().replace(/[^a-z0-9]/g,"");
const classify=new Function("row","raw","normalizeTeamName",code.slice(start,end)+";return {identityVerified,scoreVerified,proofType};");
const row={source:"ESPN",fixture_id:"espn-eng.1-123",kickoff:"2026-11-01T15:00Z",home_team:"Home",away_team:"Away",home_goals:2,away_goals:1};
const raw={id:"123",date:"2026-11-01T15:00Z",competitions:[{status:{type:{completed:true}},competitors:[{homeAway:"home",team:{displayName:"Home"},score:"2"},{homeAway:"away",team:{displayName:"Away"},score:"1"}]}]};
test("original ESPN payload proves identity and score",()=>assert.deepEqual(classify(row,raw,norm),{identityVerified:true,scoreVerified:true,proofType:"archived_espn_provider_payload"}));
test("missing provider proof stays unknown",()=>assert.deepEqual(classify(row,null,norm),{identityVerified:false,scoreVerified:false,proofType:"unknown"}));
test("reconstructed wrapper never proves ESPN identity",()=>assert.equal(classify(row,{mamSource:"ESPN",fixture:{id:row.fixture_id},goals:{home:2,away:1}},norm).identityVerified,false));
test("different source with same numeric fixture id is not promoted",()=>assert.equal(classify({...row,source:"espn",fixture_id:"123"},raw,norm).identityVerified,false));
test("wrong team sides reject identity",()=>assert.equal(classify(row,{...raw,competitions:[{competitors:[raw.competitions[0].competitors[1],raw.competitions[0].competitors[0]]}]},norm).identityVerified,true));
test("contradictory score keeps identity but rejects score",()=>{const v=classify({...row,home_goals:3},raw,norm);assert.equal(v.identityVerified,true);assert.equal(v.scoreVerified,false)});
test("invalid score cannot verify",()=>assert.equal(classify({...row,home_goals:-1},raw,norm).scoreVerified,false));
test("wrong team rejects identity",()=>assert.equal(classify({...row,home_team:"Other"},raw,norm).identityVerified,false));
test("invalid date rejects identity",()=>assert.equal(classify({...row,kickoff:"bad"},raw,norm).identityVerified,false));
test("app provider original fixture payload proves matching record",()=>{const r={...row,source:"app",fixture_id:"99"};const p={fixture:{id:99,timestamp:1793535600,date:r.kickoff,status:{short:"FT"}},teams:{home:{name:"Home"},away:{name:"Away"}},goals:{home:2,away:1}};assert.equal(classify(r,p,norm).scoreVerified,true)});
test("synthetic app wrapper without timestamp remains unknown",()=>{const r={...row,source:"app",fixture_id:"99"};const p={fixture:{id:99,date:r.kickoff},teams:{home:{name:"Home"},away:{name:"Away"}},goals:{home:2,away:1}};assert.equal(classify(r,p,norm).identityVerified,false)});
test("archive response keeps both source spellings and proof fields",()=>{assert.match(code,/mamSource: row.source \\|\\| "app"/);assert.match(code,/identity_verified: identityVerified/);assert.match(code,/score_verified: scoreVerified/)});

test("ESPN suspended or scheduled fixture cannot verify a final score",()=>{const unfinished={...raw,competitions:[{...raw.competitions[0],status:{type:{completed:false}}}]};const v=classify(row,unfinished,norm);assert.equal(v.identityVerified,true);assert.equal(v.scoreVerified,false)});
test("API-Football non-finished fixture cannot verify a final score",()=>{const r={...row,source:"app",fixture_id:"99"};const p={fixture:{id:99,timestamp:1793535600,date:r.kickoff,status:{short:"NS"}},teams:{home:{name:"Home"},away:{name:"Away"}},goals:{home:0,away:0}};const v=classify(r,p,norm);assert.equal(v.identityVerified,true);assert.equal(v.scoreVerified,false)});

const halfStart=code.indexOf("          const readHalfScore = value =>");
const halfEnd=code.indexOf("          const halftime = extractArchivedHalfTime(raw);",halfStart);
assert.ok(halfStart>0&&halfEnd>halfStart,"archive half-time extractor must exist");
const extractHalf=new Function("provider",code.slice(halfStart,halfEnd)+";return extractArchivedHalfTime(provider);");
test("ESPN first-period linescores are exposed as verified half-time scores",()=>{
 const provider={competitions:[{competitors:[
  {homeAway:"home",linescores:[{value:1},{value:0}]},
  {homeAway:"away",linescores:[{value:0},{value:1}]}
 ]}]};
 assert.deepEqual(extractHalf(provider),{home:1,away:0});
});
test("API-Football direct half-time score remains supported",()=>{
 assert.deepEqual(extractHalf({score:{halftime:{home:2,away:1}}}),{home:2,away:1});
});
test("missing or invalid half-time scores are not inferred",()=>{
 assert.equal(extractHalf({competitions:[{competitors:[{homeAway:"home",linescores:[{value:31}]},{homeAway:"away",linescores:[{value:0}]}]}]}),null);
 assert.equal(extractHalf({id:"fixture",competitions:[]}),null);
});
