// Daily / weekly / monthly challenges. Pure (no DOM): the app and the Node
// calibration script (scripts/challenges.ts) both use it.
//
// Everyone gets the same board: the seed is the date key + CHALLENGE_GEN.
// Bump CHALLENGE_GEN only between periods if a change would alter live boards.
import {
  COLS, mulberry32, type Cell, type LevelSpec, type PowerType, type Rules, type Game,
} from './sim.ts';

export const CHALLENGE_GEN = 1;
const EPOCH = Date.UTC(2026, 10, 1); // 1 Nov 2026 = Daily #1

export type ChallengeKind = 'daily' | 'weekly' | 'monthly';
export type Mechanic = 'crystal' | 'steel' | 'colour' | 'rush' | 'boss';

export interface Challenge {
  kind: ChallengeKind;
  key: string; // 'd:2026-11-04' | 'w:2026-W45' | 'm:2026-11'
  num: number; // Daily #4, Week 1, Month 1
  mechanic: Mechanic;
  twist?: 'steel' | 'colour'; // weekly rush flavour
  title: string;
  blurb: string;
  goals: [string, string, string]; // what each star needs
  spec: LevelSpec;
  par: number;
  ends: number; // ms timestamp when it rotates
}

export interface ChallengeResult {
  stars: number;
  score: number;
  rank: number; // single comparable number, higher is better (used for "best" and cloud merge)
  label: string; // "Saved 4/6 crystals"
}

// ---------- dates (local calendar) ----------
const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayIndex = (d: Date) => Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - EPOCH) / 864e5);
export const daysBetween = (a: string, b: string) => {
  const p = (k: string) => { const [y, m, d] = k.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((p(b) - p(a)) / 864e5);
};
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - y0.getTime()) / 864e5 + 1) / 7) };
}
export const weekKeyOf = (d: Date) => { const w = isoWeek(d); return `${w.year}-W${pad(w.week)}`; };
const hash = (s: string) => { let h = 2166136261; for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return h >>> 0; };

// ---------- board generation ----------
interface GenOpts {
  seed: number; balls: number; pressure: number; rows: number; initial: number;
  density: number; powerChance: number;
  crystals?: number; // chance per row of a crystal
  steel?: number; // expected steel blocks per row
  colors?: number;
  rules?: Rules;
}

function genBoard(o: GenOpts): LevelSpec {
  const rng = mulberry32(o.seed);
  let id = 1;
  const queue: (Cell | null)[][] = [];
  let totalHp = 0, crystals = 0;
  const powers: PowerType[] = o.colors ? ['extra', 'laserH', 'laserV', 'prism', 'prism', 'multi'] : ['extra', 'laserH', 'laserV', 'redirect', 'multi'];
  for (let i = 0; i < o.rows; i++) {
    const rowFactor = 0.8 + 0.45 * (i / Math.max(1, o.rows - 1));
    const row: (Cell | null)[] = new Array(COLS).fill(null);
    const mirror = rng() < 0.4;
    const half = Math.ceil(COLS / 2);
    for (let c = 0; c < (mirror ? half : COLS); c++) {
      if (rng() >= o.density) continue;
      for (const k of mirror ? [c, COLS - 1 - c] : [c]) {
        const hp = Math.max(1, Math.round(o.balls * o.pressure * rowFactor * (0.45 + rng() * 0.85)));
        const color = o.colors && rng() < 0.85 ? Math.floor(rng() * o.colors) : undefined;
        row[k] = { id: id++, kind: 'brick', hp, max: hp, color };
      }
    }
    if (!row.some(Boolean)) { const hp = Math.max(1, Math.round(o.balls * o.pressure)); row[Math.floor(rng() * COLS)] = { id: id++, kind: 'brick', hp, max: hp }; }
    if (row.every(Boolean)) row[Math.floor(rng() * COLS)] = null;
    // steel replaces some bricks
    if (o.steel) {
      let n = Math.floor(o.steel + rng());
      while (n-- > 0) { const c = Math.floor(rng() * COLS); row[c] = { id: id++, kind: 'steel', hp: 0, max: 0 }; }
    }
    const empties = () => row.map((x, c) => (x ? -1 : c)).filter(c => c >= 0);
    if (o.crystals && rng() < o.crystals) {
      const e = empties();
      if (e.length) { row[e[Math.floor(rng() * e.length)]] = { id: id++, kind: 'crystal', hp: 3, max: 3 }; crystals++; }
    }
    if (rng() < o.powerChance) {
      const e = empties();
      if (e.length) {
        const power = powers[Math.floor(rng() * powers.length)];
        row[e[Math.floor(rng() * e.length)]] = { id: id++, kind: 'power', hp: 0, max: 0, power, color: power === 'prism' ? Math.floor(rng() * (o.colors ?? 1)) : undefined };
      }
    }
    queue.push(row);
  }
  unsealSteel(queue);
  for (const row of queue) for (const c of row) if (c?.kind === 'brick') totalHp += c.hp;
  return {
    level: 0, seed: o.seed, pressure: o.pressure, balls: o.balls, queue, initialRows: o.initial,
    par: o.rows - o.initial + 3, totalHp, rules: o.rules, crystals,
  };
}

/** Steel must never wall a brick in: flood-fill from the open top and bottom
 *  through anything that isn't steel, and knock out steel next to any brick it can't reach. */
function unsealSteel(queue: (Cell | null)[][]) {
  const rows = queue.length;
  // display order: queue[0] drops first, so it is the lowest row
  const at = (r: number, c: number) => queue[rows - 1 - r][c];
  for (let pass = 0; pass < 20; pass++) {
    const seen = Array.from({ length: rows }, () => new Array(COLS).fill(false));
    const stack: [number, number][] = [];
    for (let c = 0; c < COLS; c++) { stack.push([0, c], [rows - 1, c]); }
    while (stack.length) {
      const [r, c] = stack.pop()!;
      if (r < 0 || r >= rows || c < 0 || c >= COLS || seen[r][c] || at(r, c)?.kind === 'steel') continue;
      seen[r][c] = true;
      stack.push([r + 1, c], [r - 1, c], [r, c + 1], [r, c - 1]);
    }
    let fixed = false;
    for (let r = 0; r < rows && !fixed; r++) for (let c = 0; c < COLS && !fixed; c++) {
      if (seen[r][c] || at(r, c)?.kind === 'steel') continue;
      for (const [dr, dc] of [[1, 0], [0, 1], [0, -1], [-1, 0]]) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < rows && cc >= 0 && cc < COLS && at(rr, cc)?.kind === 'steel') { queue[rows - 1 - rr][cc] = null; fixed = true; break; }
      }
    }
    if (!fixed) return;
  }
}

// ---------- the three tiers ----------
const DAILY_ROTATION: Mechanic[] = ['crystal', 'steel', 'colour'];
const BALLS = 22; // challenges use a fixed pool, the same for everyone

export function dailyFor(d: Date): Challenge {
  const key = `d:${dayKey(d)}`;
  const num = dayIndex(d) + 1;
  const mechanic = DAILY_ROTATION[((num - 1) % 3 + 3) % 3];
  const seed = hash(key + CHALLENGE_GEN);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const base = { seed, balls: BALLS, rows: 13, initial: 5, powerChance: 0.35 };
  if (mechanic === 'crystal') {
    const spec = genBoard({ ...base, pressure: 0.95, density: 0.45, crystals: 0.45 });
    const half = Math.ceil((spec.crystals ?? 0) / 2);
    return {
      kind: 'daily', key, num, mechanic, title: 'Crystal Escort', ends: end, spec, par: spec.par,
      blurb: 'Clear the bricks but protect the crystals: they score when they reach the line or survive the clear. Each turn you touch one it cracks; 3 cracks shatter it.',
      goals: ['Clear the board', `Save ${half}+ crystals`, `Save all ${spec.crystals} crystals`],
    };
  }
  if (mechanic === 'steel') {
    const spec = genBoard({ ...base, pressure: 1.15, density: 0.45, steel: 1.2 });
    const par = spec.par - 2;
    return {
      kind: 'daily', key, num, mechanic, title: 'Steel Maze', ends: end, spec, par,
      blurb: 'Steel blocks can\'t be broken. Bank your shots around them and clear the board.',
      goals: ['Clear the board', `Clear in ${par + 3} turns or fewer`, `Clear in ${par} turns or fewer`],
    };
  }
  const spec = genBoard({ ...base, pressure: 1.0, density: 0.5, colors: 2, rules: { colors: 2 } });
  const par = spec.par - 1;
  return {
    kind: 'daily', key, num, mechanic: 'colour', title: 'Colour Clash', ends: end, spec, par,
    blurb: 'Balls only damage bricks of their own colour. Pick a colour each turn. Prisms recolour balls mid-flight.',
    goals: ['Clear the board', `Clear in ${par + 3} turns or fewer`, `Clear in ${par} turns or fewer`],
  };
}

export const RUSH_STARS: [number, number, number] = [600, 1400, 2600];

export function weeklyFor(d: Date): Challenge {
  const wk = weekKeyOf(d);
  const key = `w:${wk}`;
  const num = Math.floor((dayIndex(d) + 6) / 7) + 1;
  const twist = hash(wk) % 2 ? 'colour' as const : 'steel' as const;
  const seed = hash(key + CHALLENGE_GEN);
  const daysToMonday = ((8 - (d.getDay() || 7)) % 7) || 7;
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysToMonday).getTime();
  const colors = twist === 'colour' ? 2 : undefined;
  const rules: Rules = { rush: { speed: 0.16, ramp: 0.12 }, colors, rushHp: 9 };
  const spec = genBoard({ seed, balls: 14, pressure: 0.55, rows: 4, initial: 4, density: 0.45, powerChance: 0.3, colors, steel: twist === 'steel' ? 0.6 : 0, rules });
  return {
    kind: 'weekly', key, num, mechanic: 'rush', twist, title: twist === 'colour' ? 'Colour Rush' : 'Steel Rush', ends: end, spec, par: 0,
    blurb: 'No turns. The bricks never stop sliding down. Fire as soon as your balls are home. Score = bricks broken + time survived.',
    goals: RUSH_STARS.map(s => `Score ${s.toLocaleString()}`) as [string, string, string],
  };
}

export const BOSS_HP = 520;

export function monthlyFor(d: Date): Challenge {
  const mk = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  const key = `m:${mk}`;
  const num = (d.getFullYear() - 2026) * 12 + d.getMonth() - 9;
  const seed = hash(key + CHALLENGE_GEN);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const rules: Rules = { colors: 2, boss: { hp: BOSS_HP, crystalEvery: 3 } };
  // Minion rows behind the boss keep coming.
  const spec = genBoard({ seed, balls: BALLS, pressure: 0.45, rows: 24, initial: 0, density: 0.32, powerChance: 0.4, colors: 2, rules });
  // Boss: 3×2 block, top centre, with steel armour plates on its flanks.
  const top: (Cell | null)[][] = [new Array(COLS).fill(null), new Array(COLS).fill(null)];
  for (const r of [0, 1]) for (const c of [2, 3, 4]) top[r][c] = { id: 9000 + r * 10 + c, kind: 'boss', hp: 0, max: 0 };
  top[0][1] = { id: 9101, kind: 'steel', hp: 0, max: 0 };
  top[0][5] = { id: 9105, kind: 'steel', hp: 0, max: 0 };
  // The boss occupies the first two rows the board shows; minions queue behind it.
  spec.queue = [top[1], top[0], ...spec.queue];
  spec.initialRows = 2;
  spec.totalHp = BOSS_HP;
  const par = 5;
  return {
    kind: 'monthly', key, num, mechanic: 'boss', title: 'The Prism Warden', ends: end, spec, par,
    blurb: 'A giant boss shifts colour every turn. Match it to do damage, protect the crystals it drops, and destroy it before it reaches the line.',
    goals: ['Deal 50% damage', 'Destroy the boss', `Destroy it in ${par} turns or fewer`],
  };
}

export function challengesFor(d: Date): Challenge[] { return [dailyFor(d), weeklyFor(d), monthlyFor(d)]; }

/** Score a finished (won or lost) challenge run. */
export function scoreRun(ch: Challenge, g: Game): ChallengeResult {
  const won = g.phase === 'won';
  switch (ch.mechanic) {
    case 'crystal': {
      const total = ch.spec.crystals ?? 0;
      const saved = g.crystalsSaved;
      const stars = !won ? 0 : saved >= total ? 3 : saved >= Math.ceil(total / 2) ? 2 : 1;
      return { stars, score: saved, rank: stars * 1e6 + saved * 1e3 + (won ? 500 - g.turns : 0), label: `${won ? 'Cleared' : 'Overrun'} · saved ${saved}/${total} crystals` };
    }
    case 'steel': case 'colour': {
      const stars = !won ? 0 : g.turns <= ch.par ? 3 : g.turns <= ch.par + 3 ? 2 : 1;
      const pct = Math.round((g.destroyedHp / Math.max(1, ch.spec.totalHp)) * 100);
      return won
        ? { stars, score: g.turns, rank: stars * 1e6 + (1000 - g.turns), label: `Cleared in ${g.turns} turn${g.turns === 1 ? '' : 's'} (par ${ch.par})` }
        : { stars: 0, score: pct, rank: pct, label: `Overrun at ${pct}% cleared` };
    }
    case 'rush': {
      const score = Math.floor(g.destroyedHp + g.time * 5);
      const stars = RUSH_STARS.filter(s => score >= s).length;
      return { stars, score, rank: stars * 1e6 + score, label: `${score.toLocaleString()} points · survived ${Math.floor(g.time)}s` };
    }
    case 'boss': {
      const pct = Math.round((g.bossDamage / BOSS_HP) * 100);
      const stars = won ? (g.turns <= ch.par ? 3 : 2) : pct >= 50 ? 1 : 0;
      return won
        ? { stars, score: g.turns, rank: stars * 1e6 + (1000 - g.turns), label: `Boss destroyed in ${g.turns} turn${g.turns === 1 ? '' : 's'}` }
        : { stars, score: pct, rank: stars * 1e6 + pct, label: `Boss at ${100 - pct}% health` };
    }
  }
}

/** Shareable one-liner, Wordle style. */
export function shareText(ch: Challenge, r: ChallengeResult): string {
  const name = ch.kind === 'daily' ? `Daily #${ch.num}` : ch.kind === 'weekly' ? `Weekly #${ch.num}` : `Monthly #${ch.num}`;
  const stars = '⭐'.repeat(r.stars) + '☆'.repeat(3 - r.stars);
  return `Blaster Bricks ${name} · ${ch.title}\n${stars} ${r.label}`;
}
