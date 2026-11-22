// Offline league-level backtesting. No provider calls or production writes.
import {backtest} from './run-paired-backtest.mjs';
const LEAGUE_KEYS=['leagueId','leagueName'];
export function backtestByLeague(records,{minMatches=30}={}){
 if(!Array.isArray(records)||!Number.isInteger(minMatches)||minMatches<1)throw new RangeError('Invalid league input');
 const grouped=new Map();
 for(const row of records){
  const league=String(row?.leagueId??row?.leagueName??'').trim();
  if(!league)throw new RangeError('Missing league identity');
  if(!grouped.has(league))grouped.set(league,[]);
  grouped.get(league).push(row);
 }
 const leagues={};
 for(const [league,rows] of [...grouped].sort(([a],[b])=>a.localeCompare(b))){
  const result=backtest(rows);
  leagues[league]={...result,eligibleForRanking:result.verifiedPairedMatches>=minMatches};
 }
 return {leagueCount:grouped.size,minMatches,leagues};
}
