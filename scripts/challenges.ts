// Challenge calibration: bots play upcoming dailies / weeklies / monthlies and
// report star rates, so "much tougher" and the star targets are checked, not guessed.
//   npm run challenges            (default: 9 days, 4 weeks, 3 months)
import { Game, mulberry32, DT } from '../src/sim.ts';
import { dailyFor, weeklyFor, monthlyFor, scoreRun, type Challenge } from '../src/challenges.ts';

function value(g: Game, start: Game) {
  return (g.destroyedHp - start.destroyedHp) - (g.crystalsLost - start.crystalsLost) * 150
    + (g.crystalsSaved - start.crystalsSaved) * 20
    + (g.phase === 'won' ? 1e5 : 0) + (g.phase === 'lost' ? -1e6 : 0);
}

export function botPlay(ch: Challenge, tries: number, rng: () => number) {
  const g = new Game(ch.spec);
  let guard = 0;
  while (g.phase !== 'won' && g.phase !== 'lost' && guard++ < 2e6) {
    if (g.phase === 'aim') {
      let best = { v: -Infinity, ang: -Math.PI / 2, color: 0 };
      for (let i = 0; i < tries; i++) {
        const ang = -Math.PI * (0.08 + rng() * 0.84);
        const color = g.rules.colors ? Math.floor(rng() * g.rules.colors) : 0;
        if (tries === 1) { best = { v: 0, ang, color }; break; }
        const sim = g.clone();
        sim.launch(Math.cos(ang), Math.sin(ang), color);
        let n = 0;
        while ((sim.phase as string) === 'fly' && n++ < 40 / DT) sim.step();
        const v = value(sim, g);
        if (v > best.v) best = { v, ang, color };
      }
      g.launch(Math.cos(best.ang), Math.sin(best.ang), best.color);
    }
    g.step();
  }
  return scoreRun(ch, g);
}

const days = Number(process.argv[2] ?? 9), weeks = Number(process.argv[3] ?? 4), months = Number(process.argv[4] ?? 3);
const runs = Number(process.argv[5] ?? 4);
const start = new Date(2026, 10, 4);
const list: Challenge[] = [];
for (let i = 0; i < days; i++) list.push(dailyFor(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
for (let i = 0; i < weeks; i++) list.push(weeklyFor(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i * 7)));
for (let i = 0; i < months; i++) list.push(monthlyFor(new Date(start.getFullYear(), start.getMonth() + i, 5)));

for (const ch of list) {
  const line: string[] = [];
  for (const [name, tries] of [['decent', 4], ['sharp', 12]] as const) {
    const rng = mulberry32(7);
    const res = Array.from({ length: runs }, () => botPlay(ch, tries, rng));
    const stars = res.map(r => r.stars).join('');
    const avg = res.reduce((a, r) => a + r.score, 0) / runs;
    line.push(`${name} ★${stars} avg ${avg.toFixed(0)}`);
  }
  console.log(`${ch.key.padEnd(14)} ${ch.title.padEnd(16)} par ${String(ch.par).padStart(2)} | ${line.join(' | ')}`);
}
