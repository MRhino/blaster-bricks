// Pure game simulation: no DOM, no canvas, seeded RNG, fixed timestep.
// The renderer and the Node calibration bot (scripts/bot.ts) both drive this.

export const COLS = 7;
export const CELL = 100;
export const W = COLS * CELL; // logical field width
export const TOP = 40; // gap above row 0
export const ROWS = 11; // row 10 is the line: a brick landing there ends the level
export const LINE_ROW = ROWS - 1;
export const LINE_Y = TOP + LINE_ROW * CELL;
export const FLOOR_Y = LINE_Y + 80; // where balls launch from and land
export const H = FLOOR_Y + 30;
export const BALL_R = 11;
export const BALL_SPEED = 1500; // units per second
export const DT = 1 / 240;
export const BRICK_PAD = 4;
export const POWER_R = 28;
export const LAUNCH_GAP = 0.055; // seconds between balls in a volley
export const MAX_BALLS = 260; // cap on balls in flight (multiplier compounds)
const MIN_VY = 0.14; // minimum |vy| as a fraction of speed: no horizontal traps

export type PowerType = 'laserH' | 'laserV' | 'multi' | 'redirect' | 'extra' | 'prism';
export type CellKind = 'brick' | 'power' | 'steel' | 'crystal' | 'boss';
export const COLOR_HUES = [195, 325, 95]; // colour-ball modes: cyan, pink, lime

export interface Cell {
  id: number;
  kind: CellKind;
  hp: number;
  max: number;
  power?: PowerType;
  color?: number; // colour modes: only balls of this colour damage it (undefined = any)
  crackedTurn?: number; // crystals: the turn it last cracked (at most one crack per turn)
}

/** Optional mechanics. Normal levels use none; challenges switch them on. */
export interface Rules {
  colors?: number; // number of ball colours (2–3); player picks one per volley
  rush?: { speed: number; ramp: number }; // continuous descent in rows/sec, + ramp per minute
  boss?: { hp: number; crystalEvery: number };
  rushHp?: number; // base brick hp for rush rows
}

export interface Ball {
  x: number; y: number; vx: number; vy: number;
  clone: boolean; // spawned by a multiplier; does not return to the pool
  lastPower: number; // id of the last power block touched, so one pass = one trigger
  done: boolean;
  color?: number;
}

export type SimEvent =
  | { t: 'hit'; id: number; x: number; y: number; hp: number }
  | { t: 'break'; id: number; x: number; y: number; max: number }
  | { t: 'laser'; dir: 'h' | 'v'; row: number; col: number }
  | { t: 'power'; power: PowerType; x: number; y: number; amount?: number }
  | { t: 'wall'; x: number; y: number }
  | { t: 'land'; x: number }
  | { t: 'block'; id: number; x: number; y: number } // wrong colour: bounced, no damage
  | { t: 'clang'; x: number; y: number }
  | { t: 'crack'; id: number; x: number; y: number; hp: number }
  | { t: 'shatter'; x: number; y: number }
  | { t: 'saved'; x: number; y: number }
  | { t: 'boss'; x: number; y: number; hp: number; dead: boolean };

export interface LevelSpec {
  level: number;
  seed: number;
  pressure: number;
  balls: number;
  queue: (Cell | null)[][]; // rows waiting to drop in, next first
  initialRows: number;
  par: number; // turns a strong player needs
  totalHp: number;
  rules?: Rules;
  crystals?: number; // total crystals in the level
}

export interface LevelResult {
  cleared: boolean;
  turns: number;
  par: number;
  closestGap: number; // fewest rows ever left between the lowest brick and the line
  destroyedHp: number;
  totalHp: number;
  ballsFired: number;
  hits: number;
}

export interface BossState { hp: number; max: number; color?: number }

export interface GameSnapshot {
  v: 1;
  spec: LevelSpec;
  board: (Cell | null)[][];
  queue: (Cell | null)[][];
  pool: number; launchX: number; turns: number; hits: number;
  ballsFired: number; destroyedHp: number; closestGap: number;
}

// ---------- RNG ----------
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Difficulty ----------
// One scalar drives the whole level. 1.0 = "fair for an average player at this level".
// Level adds slow, capped growth; skill (running average) and the last level nudge it.
export function pressureFor(level: number, lastEff: number | null, skill: number | null): number {
  const base = 0.78 + 0.22 * (1 - Math.exp(-(level - 1) / 18));
  const s = skill ?? 0.6;
  const l = lastEff ?? s;
  const p = base + (s - 0.6) * 0.7 + (l - 0.6) * 0.35;
  return Math.min(1.6, Math.max(0.55, p));
}

export function ballsFor(level: number): number {
  return Math.min(60, 3 + Math.floor(level * 0.8));
}

export function generateLevel(level: number, pressure: number, attempt = 0): LevelSpec {
  const seed = (level * 7919 + attempt * 104729 + 17) >>> 0;
  const rng = mulberry32(seed);
  const balls = ballsFor(level);
  const totalRows = Math.min(22, 6 + Math.floor(level * 0.45));
  const initialRows = Math.min(totalRows, 4);
  let id = 1;
  const queue: (Cell | null)[][] = [];
  const density = Math.min(0.82, Math.max(0.3, 0.3 + 0.24 * pressure));
  const powerChance = Math.min(0.7, Math.max(0.2, 0.42 + (1 - pressure) * 0.4));
  let totalHp = 0;

  const pickPower = (): PowerType => {
    const r = rng();
    if (r < 0.28) return 'extra';
    if (r < 0.46) return 'laserH';
    if (r < 0.64) return 'laserV';
    if (r < 0.82) return 'redirect';
    return 'multi';
  };

  for (let i = 0; i < totalRows; i++) {
    const progress = totalRows > 1 ? i / (totalRows - 1) : 0;
    const rowFactor = 0.75 + 0.5 * progress; // later rows hit harder
    const mirror = rng() < 0.45;
    const filled: boolean[] = new Array(COLS).fill(false);
    const half = Math.ceil(COLS / 2);
    for (let c = 0; c < (mirror ? half : COLS); c++) {
      const on = rng() < density;
      filled[c] = on;
      if (mirror) filled[COLS - 1 - c] = on;
    }
    let count = filled.filter(Boolean).length;
    if (count === 0) { filled[Math.floor(rng() * COLS)] = true; count = 1; }
    if (count === COLS) { filled[Math.floor(rng() * COLS)] = false; }

    const row: (Cell | null)[] = new Array(COLS).fill(null);
    const heavy = rng() < 0.05 + 0.08 * pressure; // one standout brick
    for (let c = 0; c < COLS; c++) {
      if (!filled[c]) continue;
      let hp = Math.round(balls * pressure * rowFactor * (0.45 + rng() * 0.85));
      hp = Math.max(1, hp);
      row[c] = { id: id++, kind: 'brick', hp, max: hp };
    }
    if (heavy) {
      const bricks = row.filter((x): x is Cell => !!x);
      const b = bricks[Math.floor(rng() * bricks.length)];
      b.hp = b.max = Math.round(b.hp * 2);
    }
    for (const b of row) if (b) totalHp += b.hp;
    if (rng() < powerChance) {
      const empties = row.map((x, c) => (x ? -1 : c)).filter(c => c >= 0);
      if (empties.length) {
        const c = empties[Math.floor(rng() * empties.length)];
        row[c] = { id: id++, kind: 'power', hp: 0, max: 0, power: pickPower() };
      }
    }
    queue.push(row);
  }
  // The par the effectiveness score measures against (calibrated with scripts/bot.ts).
  const par = totalRows - initialRows + 3;
  return { level, seed, pressure, balls, queue, initialRows, par, totalHp };
}

// ---------- Effectiveness ----------
export interface Effectiveness { score: number; speed: number; safety: number; accuracy: number }

export function effectiveness(r: LevelResult): Effectiveness {
  const accuracy = Math.min(1, r.ballsFired ? r.hits / r.ballsFired / 4 : 0); // 4 hits/ball = full marks
  if (!r.cleared) {
    const progress = r.totalHp ? r.destroyedHp / r.totalHp : 0;
    return { score: 0.35 * progress, speed: 0, safety: 0, accuracy };
  }
  const speed = Math.min(1, r.par / Math.max(1, r.turns));
  const safety = Math.min(1, Math.max(0, (r.closestGap - 1) / 4));
  const score = 0.55 * speed + 0.3 * safety + 0.15 * accuracy;
  return { score, speed, safety, accuracy };
}

// ---------- Game ----------
export type Phase = 'aim' | 'fly' | 'won' | 'lost';

export class Game {
  spec: LevelSpec;
  board: (Cell | null)[][];
  queue: (Cell | null)[][];
  balls: Ball[] = [];
  pool: number;
  launchX = W / 2;
  nextLaunchX: number | null = null;
  phase: Phase = 'aim';
  toLaunch = 0;
  launchTimer = 0;
  aim = { x: 0, y: -1 };
  turnTime = 0;
  turns = 0;
  hits = 0;
  ballsFired = 0;
  destroyedHp = 0;
  closestGap = LINE_ROW;
  events: SimEvent[] = [];
  rng: () => number;
  rules: Rules;
  color = 0; // selected volley colour (colour modes)
  drift = 0; // rush: fraction of a row the board has slid down
  time = 0; // rush: seconds survived
  rushRows = 0;
  rushRng: () => number;
  crystalsSaved = 0;
  crystalsLost = 0;
  boss: BossState | null = null;
  bossDamage = 0;
  private nextId = 100000;

  constructor(spec: LevelSpec) {
    this.spec = spec;
    this.rules = spec.rules ?? {};
    this.pool = spec.balls;
    this.rng = mulberry32(spec.seed ^ 0x9e3779b9);
    this.rushRng = mulberry32(spec.seed ^ 0x51ed270b);
    if (this.rules.boss) this.boss = { hp: this.rules.boss.hp, max: this.rules.boss.hp, color: this.rules.colors ? 0 : undefined };
    this.queue = spec.queue.map(r => r.map(c => (c ? { ...c } : null)));
    this.board = Array.from({ length: ROWS }, () => new Array<Cell | null>(COLS).fill(null));
    // Initial rows: the first queued row sits lowest.
    for (let i = 0; i < spec.initialRows; i++) {
      const row = this.queue.shift()!;
      this.board[spec.initialRows - 1 - i] = row;
    }
    this.updateGap();
  }

  /** Plain-JSON state between turns, for resuming a level after the app is closed. */
  snapshot(): GameSnapshot {
    return {
      v: 1, spec: this.spec, board: this.board, queue: this.queue, pool: this.pool,
      launchX: this.launchX, turns: this.turns, hits: this.hits, ballsFired: this.ballsFired,
      destroyedHp: this.destroyedHp, closestGap: this.closestGap,
    };
  }

  static restore(s: GameSnapshot): Game {
    const g = new Game(s.spec);
    g.board = s.board.map(r => r.map(c => (c ? { ...c } : null)));
    g.queue = s.queue.map(r => r.map(c => (c ? { ...c } : null)));
    g.pool = s.pool; g.launchX = s.launchX; g.turns = s.turns; g.hits = s.hits;
    g.ballsFired = s.ballsFired; g.destroyedHp = s.destroyedHp; g.closestGap = s.closestGap;
    g.rng = mulberry32((s.spec.seed ^ 0x9e3779b9) + s.turns * 7919);
    return g;
  }

  /** Deep copy for lookahead (the bot). The copy gets its own RNG stream. */
  clone(): Game {
    // Built via the constructor so V8 keeps the fast object shape (Object.create +
    // assign of this many fields falls back to slow dictionary mode).
    const g = new Game(this.spec);
    Object.assign(g, this);
    g.board = this.board.map(r => r.map(c => (c ? { ...c } : null)));
    g.queue = this.queue.map(r => r.map(c => (c ? { ...c } : null)));
    g.balls = this.balls.map(b => ({ ...b }));
    g.boss = this.boss ? { ...this.boss } : null;
    g.rushRng = mulberry32((this.rushRows * 2246822519) ^ this.spec.seed);
    g.events = [];
    g.rng = mulberry32((this.turns * 2654435761) ^ this.spec.seed);
    return g;
  }

  static cellRect(r: number, c: number) {
    const x = c * CELL + BRICK_PAD, y = TOP + r * CELL + BRICK_PAD;
    return { x, y, w: CELL - 2 * BRICK_PAD, h: CELL - 2 * BRICK_PAD };
  }
  static cellCenter(r: number, c: number) {
    return { x: c * CELL + CELL / 2, y: TOP + r * CELL + CELL / 2 };
  }

  get isRush() { return !!this.rules.rush; }
  /** Rush: how far (field units) the whole board has slid below its grid rows. Kept in sync with drift. */
  yOff = 0;

  /** Bricks (and a live boss) still to destroy. Steel and crystals don't count. */
  bricksLeft(): number {
    let n = 0;
    for (const row of this.board) for (const c of row) if (c?.kind === 'brick') n++;
    if (this.boss && this.boss.hp > 0) n++;
    return n;
  }
  crystalsLeft(): number {
    let n = 0;
    for (const row of this.board) for (const c of row) if (c?.kind === 'crystal') n++;
    for (const row of this.queue) for (const c of row) if (c?.kind === 'crystal') n++;
    return n;
  }
  /** The boss's cells as a rectangle (rows/cols), or null. */
  bossBox(): { r0: number; r1: number; c0: number; c1: number } | null {
    let r0 = 99, r1 = -1, c0 = 99, c1 = -1;
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (this.board[r][c]?.kind === 'boss') {
      r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c);
    }
    return r1 < 0 ? null : { r0, r1, c0, c1 };
  }
  rowsLeft(): number { return this.queue.length; }

  /** Fire the volley in direction (dx, dy). dy must point up (negative). */
  launch(dx: number, dy: number, color = this.color): boolean {
    if (this.phase !== 'aim') return false;
    this.color = this.rules.colors ? ((color % this.rules.colors) + this.rules.colors) % this.rules.colors : 0;
    const len = Math.hypot(dx, dy);
    if (!len || dy >= 0) return false;
    let nx = dx / len, ny = dy / len;
    if (-ny < MIN_VY * 1.2) return false;
    this.aim = { x: nx, y: ny };
    this.phase = 'fly';
    this.toLaunch = this.pool;
    this.launchTimer = 0;
    this.turnTime = 0;
    this.nextLaunchX = null;
    return true;
  }

  /** End the volley now: in-flight balls drop home. */
  recall() {
    if (this.phase !== 'fly') return;
    this.toLaunch = 0;
    for (const b of this.balls) b.done = true;
    this.balls = [];
    this.endTurn();
  }

  step(dt = DT) {
    this.events.length = 0;
    if (this.phase === 'won' || this.phase === 'lost') return;
    if (this.isRush) {
      this.time += dt;
      const r = this.rules.rush!;
      this.drift += (r.speed + r.ramp * this.time / 60) * dt;
      while (this.drift >= 1) {
        this.drift -= 1;
        this.advance();
        if (this.lost()) { this.phase = 'lost'; this.balls = []; this.toLaunch = 0; return; }
      }
      this.yOff = this.drift * CELL;
    }
    if (this.phase !== 'fly') return;
    this.turnTime += dt;
    if (this.toLaunch > 0) {
      this.launchTimer -= dt;
      while (this.launchTimer <= 0 && this.toLaunch > 0) {
        this.balls.push({
          x: this.launchX, y: FLOOR_Y - BALL_R,
          vx: this.aim.x * BALL_SPEED, vy: this.aim.y * BALL_SPEED,
          clone: false, lastPower: 0, done: false, color: this.rules.colors ? this.color : undefined,
        });
        this.toLaunch--; this.ballsFired++;
        this.launchTimer += LAUNCH_GAP;
      }
    }
    for (const b of this.balls) {
      if (!b.done) this.moveBall(b, dt);
      if (this.phase !== 'fly') return; // level ended mid-volley
    }
    if (this.balls.some(b => b.done)) this.balls = this.balls.filter(b => !b.done);
    if (this.toLaunch === 0 && this.balls.length === 0) this.endTurn();
    // Safety valve: nothing should take this long.
    else if (this.turnTime > 40) this.recall();
  }

  private moveBall(b: Ball, dt: number) {
    b.x += b.vx * dt; b.y += b.vy * dt;
    // walls
    if (b.x < BALL_R) { b.x = BALL_R; b.vx = Math.abs(b.vx); this.events.push({ t: 'wall', x: b.x, y: b.y }); }
    else if (b.x > W - BALL_R) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); this.events.push({ t: 'wall', x: b.x, y: b.y }); }
    if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); this.events.push({ t: 'wall', x: b.x, y: b.y }); }
    if (b.y >= FLOOR_Y - BALL_R && b.vy > 0) {
      b.done = true;
      if (!b.clone && this.nextLaunchX === null) {
        this.nextLaunchX = Math.min(W - BALL_R, Math.max(BALL_R, b.x));
        this.events.push({ t: 'land', x: this.nextLaunchX });
      }
      return;
    }
    // cells overlapping the ball's box
    const c0 = Math.max(0, Math.floor((b.x - BALL_R) / CELL));
    const c1 = Math.min(COLS - 1, Math.floor((b.x + BALL_R) / CELL));
    const off = this.yOff;
    const r0 = Math.max(0, Math.floor((b.y - BALL_R - TOP - off) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((b.y + BALL_R - TOP - off) / CELL));
    let bounced = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.board[r][c];
        if (!cell) continue;
        if (cell.kind === 'power') { this.touchPower(b, cell, r, c); continue; }
        const rc = Game.cellRect(r, c);
        rc.y += off;
        const px = Math.min(rc.x + rc.w, Math.max(rc.x, b.x));
        const py = Math.min(rc.y + rc.h, Math.max(rc.y, b.y));
        let dx = b.x - px, dy = b.y - py;
        let d2 = dx * dx + dy * dy;
        if (d2 >= BALL_R * BALL_R) continue;
        let nx: number, ny: number, d: number;
        if (d2 > 1e-6) {
          d = Math.sqrt(d2); nx = dx / d; ny = dy / d;
        } else {
          // centre inside the rect: push out against the incoming direction
          const sp = Math.hypot(b.vx, b.vy);
          nx = -b.vx / sp; ny = -b.vy / sp; d = 0;
          if (Math.abs(nx) > Math.abs(ny)) { nx = Math.sign(nx); ny = 0; } else { ny = Math.sign(ny); nx = 0; }
        }
        const vn = b.vx * nx + b.vy * ny;
        if (vn < 0) {
          b.vx -= 2 * vn * nx; b.vy -= 2 * vn * ny;
          bounced = true;
          this.hitCell(r, c, b);
          if (this.phase !== 'fly') return;
        }
        b.x = px + nx * BALL_R; b.y = py + ny * BALL_R;
      }
    }
    if (bounced) this.fixAngle(b);
  }

  private fixAngle(b: Ball) {
    const min = MIN_VY * BALL_SPEED;
    if (Math.abs(b.vy) < min) {
      b.vy = (b.vy === 0 ? (this.rng() < 0.5 ? -1 : 1) : Math.sign(b.vy)) * min;
      const s = BALL_SPEED / Math.hypot(b.vx, b.vy);
      b.vx *= s; b.vy *= s;
    }
  }

  /** A ball bounced off a solid cell. */
  private hitCell(r: number, c: number, b: Ball) {
    const cell = this.board[r][c]!;
    const cc = Game.cellCenter(r, c); cc.y += this.yOff;
    switch (cell.kind) {
      case 'steel': this.events.push({ t: 'clang', x: cc.x, y: cc.y }); return;
      case 'crystal': this.crack(r, c); return;
      case 'boss':
        if (this.boss?.color !== undefined && b.color !== undefined && this.boss.color !== b.color) { this.events.push({ t: 'block', id: cell.id, x: b.x, y: b.y }); return; }
        this.damage(r, c, 1); return;
      case 'brick':
        if (cell.color !== undefined && b.color !== undefined && cell.color !== b.color) { this.events.push({ t: 'block', id: cell.id, x: cc.x, y: cc.y }); return; }
        this.damage(r, c, 1);
    }
  }

  private crack(r: number, c: number) {
    const cell = this.board[r][c];
    if (!cell || cell.kind !== 'crystal' || cell.crackedTurn === this.turns) return;
    cell.crackedTurn = this.turns;
    cell.hp--;
    const cc = Game.cellCenter(r, c); cc.y += this.yOff;
    if (cell.hp <= 0) {
      this.board[r][c] = null; this.crystalsLost++;
      this.events.push({ t: 'shatter', x: cc.x, y: cc.y });
    } else this.events.push({ t: 'crack', id: cell.id, x: cc.x, y: cc.y, hp: cell.hp });
  }

  private touchPower(b: Ball, cell: Cell, r: number, c: number) {
    const cc = Game.cellCenter(r, c); cc.y += this.yOff;
    const dx = b.x - cc.x, dy = b.y - cc.y;
    if (dx * dx + dy * dy > (POWER_R + BALL_R) ** 2) return;
    if (b.lastPower === cell.id) return;
    b.lastPower = cell.id;
    switch (cell.power) {
      case 'laserH':
        this.events.push({ t: 'laser', dir: 'h', row: r, col: c });
        for (let k = 0; k < COLS; k++) { this.damage(r, k, 1); this.crack(r, k); }
        break;
      case 'laserV':
        this.events.push({ t: 'laser', dir: 'v', row: r, col: c });
        for (let k = 0; k < ROWS; k++) { this.damage(k, c, 1); this.crack(k, c); }
        break;
      case 'prism':
        b.color = cell.color;
        this.events.push({ t: 'power', power: 'prism', x: cc.x, y: cc.y });
        break;
      case 'redirect': {
        // steer toward a random live brick so balls reach hidden pockets
        const targets: { x: number; y: number }[] = [];
        for (let rr = 0; rr < ROWS; rr++) for (let k = 0; k < COLS; k++)
          if (this.board[rr][k]?.kind === 'brick' || this.board[rr][k]?.kind === 'boss') { const t = Game.cellCenter(rr, k); t.y += this.yOff; targets.push(t); }
        let ang: number;
        if (targets.length) {
          const t = targets[Math.floor(this.rng() * targets.length)];
          ang = Math.atan2(t.y - b.y, t.x - b.x) + (this.rng() - 0.5) * 0.25;
        } else ang = -Math.PI / 2 + (this.rng() - 0.5) * 1.6;
        b.vx = Math.cos(ang) * BALL_SPEED; b.vy = Math.sin(ang) * BALL_SPEED;
        this.fixAngle(b);
        this.events.push({ t: 'power', power: 'redirect', x: cc.x, y: cc.y });
        break;
      }
      case 'multi': {
        this.board[r][c] = null;
        const live = this.balls.filter(x => !x.done);
        const room = MAX_BALLS - live.length;
        let made = 0;
        for (const x of live) {
          if (made + 2 > room) break;
          for (const turn of [-0.22, 0.22]) {
            const cs = Math.cos(turn), sn = Math.sin(turn);
            const nb: Ball = { x: x.x, y: x.y, vx: x.vx * cs - x.vy * sn, vy: x.vx * sn + x.vy * cs, clone: true, lastPower: cell.id, done: false };
            this.fixAngle(nb);
            this.balls.push(nb);
            made++;
          }
        }
        this.events.push({ t: 'power', power: 'multi', x: cc.x, y: cc.y, amount: made });
        break;
      }
      case 'extra': {
        this.board[r][c] = null;
        const amount = Math.max(1, Math.round(this.spec.balls * 0.1));
        this.pool += amount;
        this.events.push({ t: 'power', power: 'extra', x: cc.x, y: cc.y, amount });
        break;
      }
    }
  }

  private damage(r: number, c: number, n: number) {
    const cell = this.board[r][c];
    if (cell?.kind === 'boss' && this.boss && this.boss.hp > 0) {
      const dealt = Math.min(n, this.boss.hp);
      this.boss.hp -= dealt; this.bossDamage += dealt; this.hits += dealt; this.destroyedHp += dealt;
      const box = this.bossBox()!;
      const x = ((box.c0 + box.c1 + 1) / 2) * CELL, y = TOP + ((box.r0 + box.r1 + 1) / 2) * CELL + this.yOff;
      const dead = this.boss.hp <= 0;
      this.events.push({ t: 'boss', x, y, hp: this.boss.hp, dead });
      if (dead) {
        for (const row of this.board) for (let k = 0; k < COLS; k++) if (row[k]?.kind === 'boss') row[k] = null;
        this.events.push({ t: 'break', id: -1, x, y, max: this.boss.max });
        if (this.phase === 'fly') { this.toLaunch = 0; this.balls = []; this.turns++; }
        this.win();
      }
      return;
    }
    if (!cell || cell.kind !== 'brick') return;
    const dealt = Math.min(n, cell.hp);
    cell.hp -= dealt;
    this.hits += dealt;
    this.destroyedHp += dealt;
    const cc = Game.cellCenter(r, c); cc.y += this.yOff;
    if (cell.hp <= 0) {
      this.board[r][c] = null;
      this.events.push({ t: 'break', id: cell.id, x: cc.x, y: cc.y, max: cell.max });
      // Last brick of the level: win now, don't make the player wait for balls to land.
      if (this.phase === 'fly' && !this.isRush && !this.boss && this.queue.length === 0 && this.bricksLeft() === 0) {
        this.toLaunch = 0; this.balls = []; this.turns++; this.win();
      }
    } else this.events.push({ t: 'hit', id: cell.id, x: cc.x, y: cc.y, hp: cell.hp });
  }

  /** Level cleared: crystals still on the board made it through. */
  private win() {
    for (const row of this.board) for (let k = 0; k < COLS; k++) if (row[k]?.kind === 'crystal') { row[k] = null; this.crystalsSaved++; }
    this.phase = 'won';
  }

  private endTurn() {
    this.turns++;
    if (this.nextLaunchX !== null) this.launchX = this.nextLaunchX;
    if (this.isRush) { this.phase = 'aim'; return; } // rush: the board moves on its own clock
    if (this.boss && this.rules.colors) this.boss.color = (this.boss.color! + 1) % this.rules.colors;
    this.advance();
    if (this.boss && this.rules.boss!.crystalEvery && this.turns % this.rules.boss!.crystalEvery === 0) this.bossDropsCrystal();
    // An empty board pulls the next rows straight in: no wasted turns.
    while (this.bricksLeft() === 0 && this.queue.length) this.advance();
    if (this.lost()) { this.phase = 'lost'; return; }
    if (!this.boss && this.bricksLeft() === 0 && this.queue.length === 0) { this.win(); return; }
    this.updateGap();
    this.phase = 'aim';
  }

  private bossDropsCrystal() {
    const box = this.bossBox();
    if (!box || box.r1 + 1 >= LINE_ROW - 1) return;
    const free: number[] = [];
    for (let c = box.c0; c <= box.c1; c++) if (!this.board[box.r1 + 1][c]) free.push(c);
    if (!free.length) return;
    const c = free[Math.floor(this.rng() * free.length)];
    this.board[box.r1 + 1][c] = { id: this.nextId++, kind: 'crystal', hp: 3, max: 3 };
  }

  private advance() {
    this.board.pop();
    let next: (Cell | null)[] = new Array(COLS).fill(null);
    if (this.isRush) next = this.rushRow();
    else if (this.queue.length) next = this.queue.shift()!;
    this.board.unshift(next);
    // Whatever reaches the line: crystals score, steel falls away harmlessly.
    const line = this.board[LINE_ROW];
    for (let k = 0; k < COLS; k++) {
      const cell = line[k];
      if (!cell || (cell.kind !== 'crystal' && cell.kind !== 'steel')) continue; // powers keep working below the line, as before
      if (cell.kind === 'crystal') {
        this.crystalsSaved++;
        const cc = Game.cellCenter(LINE_ROW, k);
        this.events.push({ t: 'saved', x: cc.x, y: cc.y });
      }
      line[k] = null;
    }
  }

  /** Rush: an endless supply of rows that toughen over time. */
  private rushRow(): (Cell | null)[] {
    const rng = this.rushRng;
    this.rushRows++;
    const row: (Cell | null)[] = new Array(COLS).fill(null);
    const t = this.time / 60;
    const density = Math.min(0.75, 0.38 + t * 0.12);
    const base = (this.rules.rushHp ?? this.spec.balls) * (0.6 + t * 0.55);
    let any = false;
    for (let c = 0; c < COLS; c++) {
      if (rng() > density) continue;
      any = true;
      const kindRoll = rng();
      if (kindRoll < (this.spec.rules?.colors ? 0 : 0.08) && this.rushRows > 3) { row[c] = { id: this.nextId++, kind: 'steel', hp: 0, max: 0 }; continue; }
      const hp = Math.max(1, Math.round(base * (0.5 + rng() * 0.9)));
      const color = this.rules.colors && rng() < 0.85 ? Math.floor(rng() * this.rules.colors) : undefined;
      row[c] = { id: this.nextId++, kind: 'brick', hp, max: hp, color };
    }
    if (!any) { const c = Math.floor(rng() * COLS); const hp = Math.max(1, Math.round(base)); row[c] = { id: this.nextId++, kind: 'brick', hp, max: hp }; }
    // a steady trickle of powers keeps rush lively
    if (rng() < 0.35) {
      const empties = row.map((x, c) => (x ? -1 : c)).filter(c => c >= 0);
      if (empties.length) {
        const c = empties[Math.floor(rng() * empties.length)];
        const pool: PowerType[] = this.rules.colors ? ['extra', 'laserH', 'laserV', 'prism', 'multi'] : ['extra', 'laserH', 'laserV', 'redirect', 'multi'];
        const power = pool[Math.floor(rng() * pool.length)];
        row[c] = { id: this.nextId++, kind: 'power', hp: 0, max: 0, power, color: power === 'prism' ? Math.floor(rng() * (this.rules.colors ?? 1)) : undefined };
      }
    }
    return row;
  }

  private lost(): boolean {
    return this.board[LINE_ROW].some(c => c?.kind === 'brick' || c?.kind === 'boss');
  }

  private updateGap() {
    for (let r = LINE_ROW - 1; r >= 0; r--) {
      if (this.board[r].some(c => c?.kind === 'brick' || c?.kind === 'boss')) {
        this.closestGap = Math.min(this.closestGap, LINE_ROW - r);
        return;
      }
    }
  }

  /** Lowest row (0-based) holding a brick, or -1. */
  lowestBrickRow(): number {
    for (let r = LINE_ROW; r >= 0; r--) if (this.board[r].some(c => c?.kind === 'brick' || c?.kind === 'boss')) return r;
    return -1;
  }

  result(): LevelResult {
    return {
      cleared: this.phase === 'won', turns: this.turns, par: this.spec.par,
      closestGap: this.closestGap, destroyedHp: this.destroyedHp, totalHp: this.spec.totalHp,
      ballsFired: this.ballsFired, hits: this.hits,
    };
  }
}
