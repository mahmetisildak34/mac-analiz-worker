const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const factorial = n => { let result = 1; for (let i = 2; i <= n; i++) result *= i; return result; };
const poisson = (lambda, goals) => Math.exp(-lambda) * Math.pow(lambda, goals) / factorial(goals);

export function calculateLiveV1({ home, away, minute, homeScore, awayScore }) {
  if (!home || !away || !Number.isFinite(Number(minute)) || Number(minute) <= 0) throw new TypeError("Invalid live-analysis input");
  const normalized = side => ({
    sot: Number(side.sot || 0), shots: Number(side.shots || 0),
    possession: Number(side.possession ?? 50), corners: Number(side.corners || 0),
    redCards: Number(side.redCards || 0), xg: Number(side.xg)
  });
  const h = normalized(home), a = normalized(away);
  const elapsed = Math.min(120, Number(minute));
  const remaining = Math.max(0, 90 - elapsed);
  const baseRate = x => {
    const shotSignal = x.sot * .115 + Math.max(0, x.shots - x.sot) * .018 + Math.min(x.corners, 12) * .006;
    const possession = Number.isFinite(x.possession) ? x.possession : 50;
    const posFactor = 1 + (Math.max(0, Math.min(100, possession)) - 50) / 350;
    const shotRate = .10 + shotSignal / Math.max(12, elapsed) * 45;
    const xgRate = Number.isFinite(x.xg) && x.xg > 0 ? Math.max(.04, Math.min(1.35, x.xg / Math.max(12, elapsed) * 45)) : shotRate;
    return Math.max(.04, Math.min(1.35, (Number.isFinite(x.xg) && x.xg > 0 ? xgRate * .65 + shotRate * .35 : shotRate) * posFactor));
  };
  const redBoost = (attacking, opponent) => Math.max(.68, Math.min(1.35, 1 + Math.min(2, opponent.redCards) * .18 - Math.min(2, attacking.redCards) * .18));
  const lambdaHome = remaining / 45 * baseRate(h) * redBoost(h, a);
  const lambdaAway = remaining / 45 * baseRate(a) * redBoost(a, h);
  const hs = Number(homeScore || 0), as = Number(awayScore || 0);
  let homeWin = 0, draw = 0, awayWin = 0, over15 = 0, over25 = 0, over35 = 0, btts = 0;
  for (let x = 0; x <= 8; x++) for (let y = 0; y <= 8; y++) {
    const p = poisson(lambdaHome, x) * poisson(lambdaAway, y), finalHome = hs + x, finalAway = as + y;
    if (finalHome > finalAway) homeWin += p; else if (finalHome === finalAway) draw += p; else awayWin += p;
    if (finalHome + finalAway >= 2) over15 += p;
    if (finalHome + finalAway >= 3) over25 += p;
    if (finalHome + finalAway >= 4) over35 += p;
    if (finalHome > 0 && finalAway > 0) btts += p;
  }
  const nextGoal = 1 - Math.exp(-(lambdaHome + lambdaAway));
  const nextHome = lambdaHome + lambdaAway ? nextGoal * lambdaHome / (lambdaHome + lambdaAway) : 0;
  const nextAway = lambdaHome + lambdaAway ? nextGoal * lambdaAway / (lambdaHome + lambdaAway) : 0;
  return { model: "live-v1", minute: elapsed, remaining, homeScore: hs, awayScore: as, lambdaHome, lambdaAway, homeWin, draw, awayWin, over15, over25, over35, btts, nextHome, nextAway, noGoal: 1 - nextGoal };
}
