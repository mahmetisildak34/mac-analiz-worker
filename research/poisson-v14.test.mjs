import test from 'node:test';
import assert from 'node:assert/strict';
import {scoreGrid} from './poisson-v14.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-10);
test('normalization and range',()=>{for(const h of [.1,.5,1,2,4,20])for(const a of [.1,.5,1,2,4,20])for(const r of [0,-.04,.002]){const p=scoreGrid(h,a,r);near(p.home+p.draw+p.away,1);for(const x of Object.values(p))assert.ok(x>=0&&x<=1+1e-12);}});
test('symmetry',()=>{const p=scoreGrid(1.7,.8,-.1),q=scoreGrid(.8,1.7,-.1);near(p.home,q.away);near(p.draw,q.draw);});
test('independent Poisson markets',()=>{const h=1.7,a=.8,p=scoreGrid(h,a);near(p.btts,(1-Math.exp(-h))*(1-Math.exp(-a)));near(p.over25,1-Math.exp(-h-a)*(1+h+a+(h+a)**2/2));});
test('Dixon Coles exact correction',()=>{const h=1.7,a=.8,r=-.1,p=scoreGrid(h,a),q=scoreGrid(h,a,r),d=h*a*r*Math.exp(-h-a);near(q.draw-p.draw,-2*d);near(q.home-p.home,d);near(q.away-p.away,d);near(q.btts-p.btts,-d);near(q.over25,p.over25);});
test('invalid inputs',()=>{for(const args of [[0,1],[1,-1],[NaN,1],[1,Infinity],[1,1,NaN],[2,2,.3],[2,2,-.6],[21,1]])assert.throws(()=>scoreGrid(...args),RangeError);});
