import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateRates, scoreGrid} from './poisson-v14.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10);
test('normalization and range',()=>{for(const h of [.1,.5,1,2,4,20])for(const a of [.1,.5,1,2,4,20])for(const r of [0,-.04,.002]){const p=scoreGrid(h,a,r);near(p.home+p.draw+p.away,1);for(const x of Object.values(p))assert.ok(x>=0&&x<=1+1e-12);}});
test('symmetry',()=>{const p=scoreGrid(1.7,.8,-.1),q=scoreGrid(.8,1.7,-.1);near(p.home,q.away);near(p.draw,q.draw);});
test('independent Poisson markets',()=>{const h=1.7,a=.8,p=scoreGrid(h,a);near(p.btts,(1-Math.exp(-h))*(1-Math.exp(-a)));near(p.over25,1-Math.exp(-h-a)*(1+h+a+(h+a)**2/2));});
test('Dixon Coles exact correction',()=>{const h=1.7,a=.8,r=-.1,p=scoreGrid(h,a),q=scoreGrid(h,a,r),d=h*a*r*Math.exp(-h-a);near(q.draw-p.draw,-2*d);near(q.home-p.home,d);near(q.away-p.away,d);near(q.btts-p.btts,-d);near(q.over25,p.over25);});
test('invalid inputs',()=>{for(const args of [[0,1],[1,-1],[NaN,1],[1,Infinity],[1,1,NaN],[2,2,.3],[2,2,-.6],[21,1]])assert.throws(()=>scoreGrid(...args),RangeError);});

const archive = Array.from({ length: 24 }, (_, i) => ({
  kickoff: new Date(Date.UTC(2025, 0, i + 1)).toISOString(),
  home_team: i % 2 === 0 ? 'A' : 'B',
  away_team: i % 2 === 0 ? 'B' : 'A',
  home_goals: 2, away_goals: 1, ht_home: 1, ht_away: 0,
  status: 'FT', identity_verified: true, score_verified: true, completed: true
}));
const target = { kickoff: '2025-02-01T00:00:00Z', home_team: 'A', away_team: 'B' };

test('venue rates use league averages and enforce the requested sample window', () => {
  for (const window of [5, 10, 20]) {
    const result = estimateRates(archive, target, { window });
    near(result.home, 2);
    near(result.away, 1);
    assert.equal(result.homeSample, Math.min(window, 12));
  }
});

test('same-time results and contradictory duplicates cannot enter the sample', () => {
  const future = { ...archive[0], kickoff: target.kickoff, home_goals: 12 };
  assert.deepEqual(estimateRates([...archive, future, archive[0]], target), estimateRates(archive, target));
  assert.equal(estimateRates([...archive, { ...archive[0], home_goals: 9 }], target).excludedConflicts, 1);
});

test('weak and missing period evidence returns no prediction', () => {
  assert.equal(estimateRates(archive.slice(0, 10), target), null);
  assert.equal(estimateRates(archive, { ...target, away_team: 'C' }), null);
  assert.equal(estimateRates(archive, target, { period: 'half' }), null);
  const half = archive.map(row => ({ ...row, ht_away: 1 }));
  near(estimateRates(half, target, { period: 'half' }).home, 1);
});

test('goal total markets are nested', () => {
  const p = scoreGrid(1.7, 0.8, -0.1);
  assert.ok(p.over15 > p.over25 && p.over25 > p.over35);
});
