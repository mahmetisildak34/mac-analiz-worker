// Read-only audit safety and classification contract.
// Run: node --test research/statistics-gap-readonly-audit.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('./statistics-gap-readonly-audit.sql', import.meta.url), 'utf8');
const executable = sql.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');

test('audit only selects from existing match records', () => {
  assert.match(executable, /^\s*WITH\s+rows\s+AS\s*\(/i);
  assert.match(executable, /\bSELECT\s+league_name\s*,\s*source\s*,\s*status/i);
  assert.match(executable, /\bFROM\s+matches\b/i);
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|VACUUM)\b/i);
});

test('empty statistics are classified without fabricating measurements', () => {
  assert.match(executable, /statistics_json\s+IS\s+NULL/i);
  assert.match(executable, /length\s*\(\s*trim\s*\(statistics_json\)\s*\)\s*<=\s*2/i);
  assert.match(executable, /WHERE\s+missing_stats\s*=\s*1/i);
  assert.doesNotMatch(executable, /\b(?:shots|corners|possession)\s*=/i);
});

test('scheduled and stale statuses require provider verification', () => {
  assert.match(executable, /status\s+IN\s*\('NS','TBD'\)/i);
  assert.match(executable, /scheduled_or_stale_status_verify_provider/);
});

test('final matches lacking statistics are not called verified', () => {
  assert.match(executable, /final_no_statistics_in_raw_verify_source/);
  assert.match(executable, /final_invalid_raw_verify_source/);
  assert.match(executable, /final_raw_payload_requires_schema_review/);
  assert.match(executable, /json_valid\s*\(raw_json\)/i);
  assert.match(executable, /json_type\s*\(raw_json,\s*'\$\.statistics'\)/i);
});
