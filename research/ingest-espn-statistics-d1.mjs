import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const ACCOUNT='640bfb6a538ee57864281941b14dbc55',DATABASE='fb9b42cc-8d96-4911-b193-0983527ee593';
const sha=s=>createHash('sha256').update(s).digest('hex');
const num=v=>typeof v==='number'&&Number.isFinite(v);
export function validateEvidenceRow(row){
 if(row?.source!=='ESPN'||typeof row.fixture_id!=='string'||!row.fixture_id.startsWith('espn-')||!Number.isSafeInteger(row.home_team_id)||!Number.isSafeInteger(row.away_team_id)||row.home_team_id===row.away_team_id||row.status!=='FT')throw new Error('Invalid fixture identity or final status');
 const raw=JSON.parse(row.raw_json),stats=JSON.parse(row.statistics_json);
 if(sha(row.raw_json)!==row.raw_sha256||stats.rawSha256!==row.raw_sha256||stats.provider!=='ESPN'||stats.validation!=='completed_scoreboard_payload_structural_validation'||stats.independentCrossSourceVerification!==false)throw new Error('Raw evidence hash or validation provenance mismatch');
 if(row.fixture_id!=='espn-'+row.fixture_id.split('-')[1]+'-'+raw.id||raw.date!==row.kickoff)throw new Error('Fixture ID or kickoff does not match raw ESPN evidence');
 const comp=raw.competitions?.[0],teams=comp?.competitors,home=teams?.find(x=>x.homeAway==='home'),away=teams?.find(x=>x.homeAway==='away');
 if(!Array.isArray(teams)||teams.length!==2||!Array.isArray(comp?.details))throw new Error('Missing or ambiguous competitor/card evidence');
 if(raw.status?.type?.state!=='post'||raw.status?.type?.completed!==true||!home||!away||Number(home.team.id)!==row.home_team_id||Number(away.team.id)!==row.away_team_id||home.team.displayName!==row.home_team||away.team.displayName!==row.away_team||Number(home.score)!==row.home_goals||Number(away.score)!==row.away_goals)throw new Error('Provider identity or score mismatch');
 for(const [side,team] of [['home',home],['away',away]]){
  if(!Array.isArray(team.statistics)||new Set(team.statistics.map(x=>x.name)).size!==team.statistics.length)throw new Error('Missing or duplicate raw statistics: '+side);
  const actual=Object.fromEntries(team.statistics.map(x=>[x.name,x.displayValue])),got=stats[side];
  for(const k of ['totalShots','shotsOnTarget','wonCorners','foulsCommitted'])if(Number(actual[k])!==got[k]||!Number.isSafeInteger(got[k])||got[k]<0)throw new Error('Statistic mismatch: '+side+'.'+k);
  if(Number(actual.possessionPct)!==got.possessionPct||!num(got.possessionPct)||got.possessionPct<0||got.possessionPct>100||got.shotsOnTarget>got.totalShots||Number(actual.totalGoals)!==Number(team.score))throw new Error('Statistic consistency mismatch: '+side);
 }
 if(Math.abs(stats.home.possessionPct+stats.away.possessionPct-100)>0.25)throw new Error('Possession total mismatch');
 const cards={home:{yellow:0,red:0},away:{yellow:0,red:0}};
 for(const d of comp.details??[]){const t=String(d.type?.text??'').toLowerCase(),y=d.yellowCard===true||t.includes('yellow card'),r=d.redCard===true||t.includes('red card');if(!y&&!r)continue;const id=String(d.team?.id??'');const side=id===String(home.team.id)?'home':id===String(away.team.id)?'away':null;if(!side)throw new Error('Card event team unresolved');if(y)cards[side].yellow++;if(r)cards[side].red++;}
 if(JSON.stringify(cards.home)!==JSON.stringify(stats.home.cards)||JSON.stringify(cards.away)!==JSON.stringify(stats.away.cards))throw new Error('Card totals do not match ESPN event details');
 return {fixtureId:row.fixture_id,rawSha256:row.raw_sha256,leagueId:row.fixture_id.split('-')[1]};
}
export async function ingestRows(rows,{token,fetcher=fetch,apply=false}={}){
 if(!Array.isArray(rows)||!rows.length)throw new Error('No ESPN evidence rows to ingest');
 const validated=rows.map(validateEvidenceRow),unique=new Set(validated.map(x=>x.fixtureId));if(unique.size!==rows.length)throw new Error('Duplicate fixture IDs in artifact');
 if(!apply)return {mode:'dry-run',validated:validated.length,leagues:[...new Set(validated.map(x=>x.leagueId))]};
 if(!token)throw new Error('Dedicated isolated D1 token is required');
 const url='https://api.cloudflare.com/client/v4/accounts/'+ACCOUNT+'/d1/database/'+DATABASE+'/query';
 const query=async(sql,params=[])=>{const response=await fetcher(url,{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sql,params})});const body=await response.json();if(!response.ok||!body.success)throw new Error('Isolated D1 query failed: HTTP '+response.status+' '+JSON.stringify(body.errors??[]));return body.result?.[0]?.results??[];};
 const existing=await query("SELECT name FROM sqlite_master WHERE type='table' AND name='matches'");if(existing.length!==1)throw new Error('Expected isolated matches table is missing');
 let inserted=0,unchanged=0;
 for(const row of rows){
  const prior=await query('SELECT raw_json,statistics_json FROM matches WHERE source=? AND fixture_id=?',['ESPN',row.fixture_id]);
  if(prior.length){if(prior.length!==1||prior[0].raw_json!==row.raw_json||prior[0].statistics_json!==row.statistics_json)throw new Error('Conflicting immutable evidence already exists: '+row.fixture_id);unchanged++;continue;}
  await query('INSERT INTO matches (source,fixture_id,kickoff,status,home_team_id,away_team_id,home_team,away_team,home_goals,away_goals,statistics_json,raw_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',['ESPN',row.fixture_id,row.kickoff,'FT',String(row.home_team_id),String(row.away_team_id),row.home_team,row.away_team,String(row.home_goals),String(row.away_goals),row.statistics_json,row.raw_json]);
  inserted++;
 }
 for(const row of rows){const got=await query('SELECT raw_json,statistics_json,home_goals,away_goals FROM matches WHERE source=? AND fixture_id=?',['ESPN',row.fixture_id]);if(got.length!==1||got[0].raw_json!==row.raw_json||got[0].statistics_json!==row.statistics_json||Number(got[0].home_goals)!==row.home_goals||Number(got[0].away_goals)!==row.away_goals)throw new Error('D1 read-after-write verification failed: '+row.fixture_id);}
 return {mode:'isolated-d1',inserted,unchanged,verified:rows.length,database:'mam-statistics-isolated-test'};
}
if(import.meta.url===new URL('file://'+process.argv[1]).href){const file=process.argv[2];if(!file)throw new Error('Evidence JSON path required');const rows=JSON.parse(await readFile(file,'utf8'));const apply=process.argv.includes('--apply');const result=await ingestRows(rows,{token:process.env.CLOUDFLARE_ISOLATED_D1_TOKEN,apply});console.log(JSON.stringify(result,null,2));}
