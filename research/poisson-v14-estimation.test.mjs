import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateRates,exactScoreProbability,fitRho,scoreGrid} from './poisson-v14.mjs';

test('exact score probability equals independent Poisson at rho zero',()=>{
 const h=1.7,a=.8;
 const p=exactScoreProbability(h,a,0,2,1);
 const expected=Math.exp(-h)*h*h/2*Math.exp(-a)*a;
 assert.ok(Math.abs(p-expected)<1e-12);
});

test('rate estimation is venue-specific, time-decayed and excludes future matches',()=>{
 const history=[];
 for(let i=0;i<10;i++){
  const day=String(i+1).padStart(2,'0');
  history.push({fixture_id:'h'+i,kickoff:'2025-01-'+day+'T12:00:00Z',home_team:'A',away_team:'X'+i,home_goals:2,away_goals:1,status:"FT",identity_verified:true,score_verified:true,completed:true});
  history.push({fixture_id:'a'+i,kickoff:'2025-01-'+day+'T12:00:00Z',home_team:'Y'+i,away_team:'B',home_goals:1,away_goals:2,status:"FT",identity_verified:true,score_verified:true,completed:true});
  history.push({fixture_id:'l'+i,kickoff:'2025-01-'+day+'T12:00:00Z',home_team:'L'+i,away_team:'M'+i,home_goals:2,away_goals:1,completed:true});
 }
 history.push({fixture_id:'future',kickoff:'2025-02-02T12:00:00Z',home_team:'A',away_team:'B',home_goals:10,away_goals:0,completed:true});
 const target={kickoff:'2025-02-01T12:00:00Z',home_team:'A',away_team:'B'};
 const rates=estimateRates(history,target,{window:5,halfLifeDays:90});
 assert.ok(rates);
 assert.equal(rates.homeSample,5);
 assert.equal(rates.awaySample,5);
 assert.ok(rates.home>0&&rates.away>0);
 assert.deepEqual(estimateRates(history,{...target,kickoff:'2024-01-01T00:00:00Z'}),null);
});

test('rho fitting uses a unique chronological sample and stays within positivity bounds',()=>{
 const rows=Array.from({length:60},(_,i)=>({
  fixtureId:'fixture-'+i,
  kickoff:new Date(Date.UTC(2025,0,1+i)).toISOString(),
  home:1.2+(i%5)*.2,away:.9+(i%4)*.15,
  homeGoals:i%7===0?0:i%3,awayGoals:i%5===0?0:i%2
 }));
 const rho=fitRho(rows,'2026-01-01T00:00:00Z');
 assert.ok(Number.isFinite(rho));
 assert.ok(rho>-.15&&rho<.15);
 assert.equal(fitRho(rows.slice(0,10),'2026-01-01T00:00:00Z'),null);
 assert.equal(fitRho(rows,'2024-01-01T00:00:00Z'),null);
});

test('invalid rate and exact-score inputs fail closed',()=>{
 for(const args of [[0,1,0,0,0],[1,1,0,-1,0],[1,1,0,0,1.5]])assert.throws(()=>exactScoreProbability(...args),RangeError);
 assert.throws(()=>scoreGrid(1,1,NaN),RangeError);
});

test('exact score preserves missing evidence and rejects malformed counts in either slot', () => {
  assert.equal(exactScoreProbability(1, 1, 0, undefined, 0), null);
  assert.equal(exactScoreProbability(1, 1, 0, 0, null), null);
  for (const invalid of [NaN, Infinity, '0', false, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => exactScoreProbability(1, 1, 0, invalid, 0), /Invalid score/);
    assert.throws(() => exactScoreProbability(1, 1, 0, null, invalid), /Invalid score/);
  }
  assert.equal(exactScoreProbability(1, 1, 0, 0, Number.MAX_SAFE_INTEGER), 0);
});

test('half-time rates and probabilities use complete half-time evidence only', () => {
  const history = Array.from({ length: 24 }, (_, i) => ({
    kickoff: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
    home_team: 'A', away_team: 'B',
    home_goals: 3, away_goals: 2, ht_home: 1, ht_away: 1,
    status: 'FT', identity_verified: true, score_verified: true, completed: true
  }));
  const target = { kickoff: '2025-02-01', home_team: 'A', away_team: 'B' };
  const half = estimateRates(history, target, { period: 'half' });
  const full = estimateRates(history, target);
  const h = scoreGrid(half.home, half.away);
  const f = scoreGrid(full.home, full.away);
  assert.ok(Math.abs(h.home + h.draw + h.away - 1) < 1e-12);
  assert.ok(Math.abs(f.home + f.draw + f.away - 1) < 1e-12);
  assert.ok(h.over25 < f.over25 && h.btts < f.btts);
  assert.equal(estimateRates(history.map(row => ({ ...row, ht_home: -1 })), target, { period: 'half' }), null);
  assert.equal(estimateRates(history.map(({ ht_away, ...row }) => row), target, { period: 'half' }), null);
});

test('very small and high rates remain finite within supported market bounds', () => {
  for (const [home, away] of [[1e-12, 2e-12], [20, 20]]) {
    const p = scoreGrid(home, away, -0.04);
    assert.ok(Object.values(p).every(value => Number.isFinite(value) && value >= 0 && value <= 1));
    assert.ok(Math.abs(p.home + p.draw + p.away - 1) < 1e-12);
    assert.ok(p.over15 >= p.over25 && p.over25 >= p.over35 && p.over35 > 0);
  }
});
