// Calibration bot: plays generated levels headlessly and reports how the
// difficulty loop behaves. `npm run bot` (optionally: npm run bot -- 30 40)
// Bot skill = how many aim angles it tries per turn (1 = sloppy, 12 = sharp).
import { Game, generateLevel, pressureFor, effectiveness, mulberry32, type LevelResult } from '../src/sim.ts';

function playLevel(g: Game, tries: number, rng: () => number): LevelResult {
  while (g.phase === 'aim') {
    let best = { score: -Infinity, ang: -Math.PI / 2 };
    for (let i = 0; i < tries; i++) {
      const ang = -Math.PI * (0.08 + rng() * 0.84);
      if (tries === 1) { best.ang = ang; break; }
      const sim = g.clone();
      const before = sim.destroyedHp;
      sim.launch(Math.cos(ang), Math.sin(ang));
      while ((sim.phase as string) === 'fly') sim.step();
      const score = sim.destroyedHp - before + (sim.phase === 'lost' ? -1e6 : 0) + (sim.phase === 'won' ? 1e5 : 0);
      if (score > best.score) best = { score, ang };
    }
    g.launch(Math.cos(best.ang), Math.sin(best.ang));
    while ((g.phase as string) === 'fly') g.step();
  }
  return g.result();
}

const levels = Number(process.argv[2] ?? 20);
const profiles = [{ name: 'casual', tries: 1 }, { name: 'decent', tries: 4 }, { name: 'sharp', tries: 12 }];

for (const p of profiles) {
  const rng = mulberry32(42);
  const history: number[] = [];
  let level = 1, attempts = 0, lastEff: number | null = null;
  const rows: string[] = [];
  let fails = 0;
  const t0 = Date.now();
  while (level <= levels && attempts < levels * 4) {
    const skill = history.length ? history.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, history.length) : null;
    const pressure = pressureFor(level, lastEff, skill);
    const spec = generateLevel(level, pressure, attempts);
    const r = playLevel(new Game(spec), p.tries, rng);
    const e = effectiveness(r);
    history.push(e.score); lastEff = e.score; attempts++;
    rows.push(`L${String(level).padStart(2)} P=${pressure.toFixed(2)} ${r.cleared ? 'WIN ' : 'FAIL'} turns ${r.turns}/${r.par} gap ${r.closestGap} eff ${(e.score * 100).toFixed(0)}%`);
    if (r.cleared) level++; else fails++;
  }
  const avg = history.reduce((a, b) => a + b, 0) / history.length;
  console.log(`\n== ${p.name} (tries=${p.tries}) reached L${level - 1}, fails ${fails}, avg eff ${(avg * 100).toFixed(0)}%, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (process.argv.includes('-v')) console.log(rows.join('\n'));
  else console.log(rows.slice(-6).join('\n'));
}
