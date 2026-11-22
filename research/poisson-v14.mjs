// Experimental only: no production integration.
export function scoreGrid(home, away, rho=0) {
 if (![home,away,rho].every(Number.isFinite)||home<=0||away<=0||home>20||away>20) throw new RangeError('Invalid rates');
 if (rho<Math.max(-1/home,-1/away)||rho>Math.min(1,1/(home*away))) throw new RangeError('Invalid rho');
 const pmf=l=>{const p=[Math.exp(-l)];for(let i=1;i<=100;i++)p.push(p[i-1]*l/i);return p};
 const h=pmf(home),a=pmf(away);
 let win=0,draw=0,loss=0,btts=0,over25=0,total=0;
 for(let i=0;i<h.length;i++)for(let j=0;j<a.length;j++){
 const tau=i===0&&j===0?1-home*away*rho:i===0&&j===1?1+home*rho:i===1&&j===0?1+away*rho:i===1&&j===1?1-rho:1;
 const p=h[i]*a[j]*tau;total+=p;
 if(i>j)win+=p;else if(i===j)draw+=p;else loss+=p;
 if(i&&j)btts+=p;if(i+j>=3)over25+=p;
 }
 return {home:win/total,draw:draw/total,away:loss/total,btts:btts/total,over25:over25/total};
}
