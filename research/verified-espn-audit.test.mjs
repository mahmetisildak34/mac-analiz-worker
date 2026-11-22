// Research-only audit contract checks: no database access.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('./verified-espn-audit.sql',import.meta.url),'utf8');
test('audit query is read only',()=>{
 const executable=sql.split('\n').filter(line=>!line.trim().startsWith('--')).join('\n');
 assert.match(executable,/^\s*SELECT\b/i);
 assert.doesNotMatch(executable,/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|PRAGMA)\b/i);
});
test('audit requires provider evidence and home away identity',()=>{
 for(const fragment of ['completed',"'post'",'fixture_id','home_team_id','away_team_id','home_goals','away_goals',"homeAway"])
  assert.ok(sql.includes(fragment),'Missing audit evidence: '+fragment);
});
test('audit rejects scheduled fixtures and invalid scores',()=>{
 assert.match(sql,/julianday\(kickoff\)\s*<=\s*julianday\('now'\)/);
 assert.match(sql,/NOT GLOB '\*\[\^0-9\]\*'/);
 assert.match(sql,/length\(trim\(/);
});
