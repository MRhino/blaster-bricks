// Mechanic tests: colour matching, steel, crystals, rush, boss.
import assert from 'node:assert/strict';
import { Game, COLS, ROWS, LINE_ROW, type LevelSpec, type Cell } from '../src/sim.ts';

const empty = () => Array.from({ length: ROWS }, () => new Array<Cell | null>(COLS).fill(null));
function make(rules: LevelSpec['rules'] = {}, balls = 10): Game {
  const g = new Game({ level: 0, seed: 1, pressure: 1, balls, queue: [], initialRows: 0, par: 5, totalHp: 0, rules });
  g.board = empty();
  return g;
}
const run = (g: Game) => { let n = 0; while (g.phase === 'fly' && n++ < 1e6) g.step(); };
const up = (g: Game, color?: number) => { g.launchX = 350; g.launch(0.0001, -1, color); run(g); };

// colour: wrong colour never damages, right colour does
{
  const g = make({ colors: 2 });
  g.board[2][3] = { id: 1, kind: 'brick', hp: 50, max: 50, color: 1 };
  g.board[0][0] = { id: 99, kind: 'brick', hp: 999, max: 999 }; // keep the level alive
  up(g, 0);
  assert.equal(g.board[3][3]?.hp, 50, 'cyan balls bounce off pink bricks'); // rows move down one per turn
  up(g, 1);
  assert.ok((g.board[4][3]?.hp ?? 0) < 50, 'pink balls damage pink bricks');
}
// steel never breaks and never counts as a brick
{
  const g = make();
  g.board[2][3] = { id: 1, kind: 'steel', hp: 0, max: 0 };
  g.board[0][0] = { id: 99, kind: 'brick', hp: 999, max: 999 };
  up(g);
  assert.equal(g.board[3][3]?.kind, 'steel');
  assert.equal(g.bricksLeft(), 1);
}
// crystals crack at most once per turn; reaching the line scores
{
  const g = make();
  g.board[2][3] = { id: 1, kind: 'crystal', hp: 3, max: 3 };
  g.board[0][0] = { id: 99, kind: 'brick', hp: 999, max: 999 };
  up(g);
  assert.equal(g.board[3][3]?.hp, 2, 'a whole volley = one crack');
  const h = make();
  h.board[LINE_ROW - 1][0] = { id: 5, kind: 'crystal', hp: 3, max: 3 };
  h.board[0][6] = { id: 99, kind: 'brick', hp: 999, max: 999 };
  h.launchX = 650; h.launch(0.0001, -1); run(h);
  assert.equal(h.crystalsSaved, 1, 'crystal reaching the line is saved');
  assert.equal(h.phase, 'aim', 'and does not end the run');
}
// rush: board slides on its own, rows keep coming, and an untouched board overruns
{
  const g = make({ rush: { speed: 2, ramp: 0 } }, 5);
  g.board[0][0] = { id: 99, kind: 'brick', hp: 999, max: 999 };
  let steps = 0;
  while (g.phase === 'aim' && steps++ < 240 * 30) g.step();
  assert.equal(g.phase, 'lost');
  assert.ok(g.time > 4 && g.time < 7, `overran after ${g.time.toFixed(1)}s at 2 rows/s`);
  assert.ok(g.rushRows >= 9, 'new rows generated');
}
// boss: shared hp, needs matching colour, colour cycles each turn, drops crystals, dies → won
{
  const g = make({ colors: 2, boss: { hp: 30, crystalEvery: 1 } });
  for (const r of [0, 1]) for (const c of [2, 3, 4]) g.board[r][c] = { id: 900 + r * 10 + c, kind: 'boss', hp: 0, max: 0 };
  assert.equal(g.boss!.color, 0);
  up(g, 1);
  assert.equal(g.boss!.hp, 30, 'wrong colour: no damage');
  assert.equal(g.boss!.color, 1, 'colour cycled');
  assert.ok(g.board.some(r => r.some(c => c?.kind === 'crystal')), 'boss dropped a crystal');
  g.boss!.hp = 3;
  up(g, 1);
  assert.equal(g.phase, 'won');
  assert.ok(!g.board.some(r => r.some(c => c?.kind === 'boss')), 'boss cells cleared');
}
console.log('all sim tests passed');
