import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {reserveApiBackfillCall} from '../statistics-api-backfill.js';

const schema=readFileSync(new URL('../research/isolated-statistics-acceptance-schema.sql',import.meta.url),'utf8');
const config={STATISTICS_API_BACKFILL_ENABLED:'true',API_FOOTBALL_QUOTA_VERIFIED:'true',API_FOOTBALL_DAILY_LIMIT:'100',API_FOOTBALL_VERIFIED_LIMIT:'100'};
function setup(now) {
  const raw=new DatabaseSync(':memory:');
  raw.exec(schema);
  raw.prepare('INSERT INTO mam_api_quota_guard(day,used,minute_last_ms) VALUES(?,?,?)').run(new Date(now).toISOString().slice(0,10),0,0);
  const db={prepare(sql){const statement=raw.prepare(sql);let params=[];return {bind(...args){params=args;return this;},async first(){return statement.get(...params)??null;}};}};
  return {raw,db};
}
test('isolated SQLite quota reservation enforces eight-second spacing atomically',async()=>{
  const now=Date.parse('2026-11-22T12:00:00Z'),{raw,db}=setup(now);
  assert.equal((await reserveApiBackfillCall(db,config,now)).allowed,true);
  assert.equal((await reserveApiBackfillCall(db,config,now+1000)).allowed,false);
  assert.equal((await reserveApiBackfillCall(db,config,now+8000)).allowed,true);
  assert.equal(raw.prepare('SELECT used FROM mam_api_quota_guard').get().used,2);
  raw.close();
});
test('isolated SQLite quota refuses missing daily ledger without creating it',async()=>{
  const now=Date.parse('2026-11-22T12:00:00Z'),{raw,db}=setup(now);
  raw.exec('DELETE FROM mam_api_quota_guard');
  const result=await reserveApiBackfillCall(db,config,now);
  assert.equal(result.allowed,false);
  assert.equal(result.reason,'missing-shared-quota-state');
  assert.equal(raw.prepare('SELECT count(*) AS n FROM mam_api_quota_guard').get().n,0);
  raw.close();
});
test('isolated SQLite quota never exceeds safety reserve',async()=>{
  const now=Date.parse('2026-11-22T12:00:00Z'),{raw,db}=setup(now);
  raw.exec('UPDATE mam_api_quota_guard SET used=80');
  assert.equal((await reserveApiBackfillCall(db,config,now)).allowed,false);
  assert.equal(raw.prepare('SELECT used FROM mam_api_quota_guard').get().used,80);
  raw.close();
});
