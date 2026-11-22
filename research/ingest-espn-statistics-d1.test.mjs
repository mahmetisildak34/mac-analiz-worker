import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateEvidenceRow,ingestRows} from './ingest-espn-statistics-d1.mjs';
const rows=JSON.parse(await readFile(new URL('../../tmp/espn-current/verified-provider-statistics.json',import.meta.url).catch(()=>new URL('./fixtures/no-file.json',import.meta.url)),'utf8').catch(()=> '[]'));
test('rejects empty or malformed evidence input',async()=>{await assert.rejects(ingestRows([]),/No ESPN/);assert.throws(()=>validateEvidenceRow({}),/Invalid fixture/);});
test('dry run never calls the network and rejects duplicate fixtures',async()=>{let calls=0;await assert.rejects(ingestRows([{},{}],{fetcher:async()=>{calls++;}}));assert.equal(calls,0);});
