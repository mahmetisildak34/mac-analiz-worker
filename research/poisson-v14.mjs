// Experimental only: no production integration.
export function scoreGrid(home, away, rho=0) {
 if (![home,away,rho].every(Number.isFinite)||home<=0||away<=0||home>20||away>20) throw new RangeError('Invalid rates');
 if (rho<Math.max(-1/home,-1/away)||rho>Math.min(1,1/(home*away))) throw new RangeError('Invalid rho');
 const pmf=l=>{const p=[Math.exp(-l)];for(let i=1;i<=100;i++)p.push(p[i-1]*l/i);return p};
 const h=pmf(home),a=pmf(away);
 let win=0,draw=0,loss=0,btts=0,over15=0,over25=0,over35=0,total=0;
 for(let i=0;i<h.length;i++)for(let j=0;j<a.length;j++){
 const tau=i===0&&j===0?1-home*away*rho:i===0&&j===1?1+home*rho:i===1&&j===0?1+away*rho:i===1&&j===1?1-rho:1;
 const p=h[i]*a[j]*tau;total+=p;
 if(i>j)win+=p;else if(i===j)draw+=p;else loss+=p;
 if(i&&j)btts+=p;
   if(i+j>=2)over15+=p;
   if(i+j>=3)over25+=p;
   if(i+j>=4)over35+=p;
 }
 return {home:win/total,draw:draw/total,away:loss/total,btts:btts/total,over15:over15/total,over25:over25/total,over35:over35/total};
}

// Input is a single league's verified archive in the trusted-goal model format.
export function estimateRates(rows, target, { window = 10, halfLifeDays = 90, period = 'full' } = {}) {
  const cutoff = Date.parse(target?.kickoff);
  if (!Number.isFinite(cutoff) || !target.home_team || !target.away_team ||
      target.home_team === target.away_team || !Array.isArray(rows) ||
      ![5, 10, 20].includes(window) || !Number.isFinite(halfLifeDays) ||
      halfLifeDays <= 0 || !['full', 'half'].includes(period)) return null;

  const valid = goals => Number.isInteger(goals) && goals >= 0;
  const fixtures = new Map();
  const conflicts = new Set();
  for (const row of rows) {
    const kickoff = Date.parse(row?.kickoff);
    if (!(kickoff < cutoff) || row.identity_verified !== true || row.score_verified !== true ||
        row.completed !== true || row.conflicting === true || row.status !== 'FT' ||
        !row.home_team || !row.away_team || row.home_team === row.away_team ||
        !valid(row.home_goals) || !valid(row.away_goals)) continue;

    const home = period === 'full' ? row.home_goals : row.ht_home;
    const away = period === 'full' ? row.away_goals : row.ht_away;
    if (!valid(home) || !valid(away) || home > row.home_goals || away > row.away_goals) continue;
    const key = JSON.stringify([kickoff, row.home_team, row.away_team]);
    const prior = fixtures.get(key);
    if (prior && (prior.home !== home || prior.away !== away ||
        prior.homeFinal !== row.home_goals || prior.awayFinal !== row.away_goals)) conflicts.add(key);
    fixtures.set(key, { ...row, kickoff, home, away, homeFinal: row.home_goals, awayFinal: row.away_goals });
  }
  for (const key of conflicts) fixtures.delete(key);
  const history = [...fixtures.values()].sort((a, b) => b.kickoff - a.kickoff);
  if (history.length < 20) return null;

  const average = side => history.reduce((sum, row) => sum + row[side], 0) / history.length;
  const homeAverage = average('home');
  const awayAverage = average('away');
  if (homeAverage <= 0 || awayAverage <= 0) return null;

  function strength(team, side, other, scoringAverage, concedingAverage) {
    const sample = history.filter(row => row[side + '_team'] === team).slice(0, window);
    if (sample.length < 3) return null;
    let weight = 0;
    let scored = 0;
    let conceded = 0;
    for (const row of sample) {
      const recency = 2 ** (-(cutoff - row.kickoff) / (86400000 * halfLifeDays));
      weight += recency;
      scored += recency * row[side];
      conceded += recency * row[other];
    }
    // Five league-average pseudo-matches shrink weak venue samples toward the baseline.
    return {
      count: sample.length,
      attack: (scored / scoringAverage + 5) / (weight + 5),
      defense: (conceded / concedingAverage + 5) / (weight + 5)
    };
  }

  const home = strength(target.home_team, 'home', 'away', homeAverage, awayAverage);
  const away = strength(target.away_team, 'away', 'home', awayAverage, homeAverage);
  if (!home || !away) return null;
  return {
    home: Math.min(20, homeAverage * home.attack * away.defense),
    away: Math.min(20, awayAverage * away.attack * home.defense),
    homeSample: home.count,
    awaySample: away.count,
    leagueSample: history.length,
    excludedConflicts: conflicts.size
  };
}
