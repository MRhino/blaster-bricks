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

export type PowerType = 'laserH' | 'laserV' | 'multi' | 'redirect' | 'extra';

export interface Cell {
  id: number;
  kind: 'brick' | 'power';
  hp: number;
  max: number;
  power?: PowerType;
}

export interface Ball {
  x: number; y: number; vx: number; vy: number;
  clone: boolean; // spawned by a multiplier; does not return to the pool
  lastPower: number; // id of the last power block touched, so one pass = one trigger
  done: boolean;
}

export type SimEvent =
  | { t: 'hit'; id: number; x: number; y: number; hp: number }
  | { t: 'break'; id: number; x: number; y: number; max: number }
  | { t: 'laser'; dir: 'h' | 'v'; row: number; col: number }
  | { t: 'power'; power: PowerType; x: number; y: number; amount?: number }
  | { t: 'wall'; x: number; y: number }
  | { t: 'land'; x: number };

export interface LevelSpec {
  level: number;
  seed: number;
  pressure: number;
  balls: number;
  queue: (Cell | null)[][]; // rows waiting to drop in, next first
  initialRows: number;
  par: number; // turns a strong player needs
  totalHp: number;
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

  constructor(spec: LevelSpec) {
    this.spec = spec;
    this.pool = spec.balls;
    this.rng = mulberry32(spec.seed ^ 0x9e3779b9);
    this.queue = spec.queue.map(r => r.map(c => (c ? { ...c } : null)));
    this.board = Array.from({ length: ROWS }, () => new Array<Cell | null>(COLS).fill(null));
    // Initial rows: the first queued row sits lowest.
    for (let i = 0; i < spec.initialRows; i++) {
      const row = this.queue.shift()!;
      this.board[spec.initialRows - 1 - i] = row;
    }
    this.updateGap();
  }

  /** Deep copy for lookahead (the bot). The copy gets its own RNG stream. */
  clone(): Game {
    const g: Game = Object.create(Game.prototype);
    Object.assign(g, this);
    g.board = this.board.map(r => r.map(c => (c ? { ...c } : null)));
    g.queue = this.queue.map(r => r.map(c => (c ? { ...c } : null)));
    g.balls = this.balls.map(b => ({ ...b }));
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

  bricksLeft(): number {
    let n = 0;
    for (const row of this.board) for (const c of row) if (c?.kind === 'brick') n++;
    return n;
  }
  rowsLeft(): number { return this.queue.length; }

  /** Fire the volley in direction (dx, dy). dy must point up (negative). */
  launch(dx: number, dy: number): boolean {
    if (this.phase !== 'aim') return false;
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
    if (this.phase !== 'fly') return;
    this.turnTime += dt;
    if (this.toLaunch > 0) {
      this.launchTimer -= dt;
      while (this.launchTimer <= 0 && this.toLaunch > 0) {
        this.balls.push({
          x: this.launchX, y: FLOOR_Y - BALL_R,
          vx: this.aim.x * BALL_SPEED, vy: this.aim.y * BALL_SPEED,
          clone: false, lastPower: 0, done: false,
        });
        this.toLaunch--; this.ballsFired++;
        this.launchTimer += LAUNCH_GAP;
      }
    }
    for (const b of this.balls) if (!b.done) this.moveBall(b, dt);
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
    const r0 = Math.max(0, Math.floor((b.y - BALL_R - TOP) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((b.y + BALL_R - TOP) / CELL));
    let bounced = false;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = this.board[r][c];
        if (!cell) continue;
        if (cell.kind === 'power') { this.touchPower(b, cell, r, c); continue; }
        const rc = Game.cellRect(r, c);
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
          this.damage(r, c, 1);
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

  private touchPower(b: Ball, cell: Cell, r: number, c: number) {
    const cc = Game.cellCenter(r, c);
    const dx = b.x - cc.x, dy = b.y - cc.y;
    if (dx * dx + dy * dy > (POWER_R + BALL_R) ** 2) return;
    if (b.lastPower === cell.id) return;
    b.lastPower = cell.id;
    switch (cell.power) {
      case 'laserH':
        this.events.push({ t: 'laser', dir: 'h', row: r, col: c });
        for (let k = 0; k < COLS; k++) this.damage(r, k, 1);
        break;
      case 'laserV':
        this.events.push({ t: 'laser', dir: 'v', row: r, col: c });
        for (let k = 0; k < ROWS; k++) this.damage(k, c, 1);
        break;
      case 'redirect': {
        // steer toward a random live brick so balls reach hidden pockets
        const targets: { x: number; y: number }[] = [];
        for (let rr = 0; rr < ROWS; rr++) for (let k = 0; k < COLS; k++)
          if (this.board[rr][k]?.kind === 'brick') targets.push(Game.cellCenter(rr, k));
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
    if (!cell || cell.kind !== 'brick') return;
    const dealt = Math.min(n, cell.hp);
    cell.hp -= dealt;
    this.hits += dealt;
    this.destroyedHp += dealt;
    const cc = Game.cellCenter(r, c);
    if (cell.hp <= 0) {
      this.board[r][c] = null;
      this.events.push({ t: 'break', id: cell.id, x: cc.x, y: cc.y, max: cell.max });
    } else this.events.push({ t: 'hit', id: cell.id, x: cc.x, y: cc.y, hp: cell.hp });
  }

  private endTurn() {
    this.turns++;
    if (this.nextLaunchX !== null) this.launchX = this.nextLaunchX;
    this.advance();
    // An empty board pulls the next rows straight in: no wasted turns.
    while (this.bricksLeft() === 0 && this.queue.length) this.advance();
    if (this.lost()) { this.phase = 'lost'; return; }
    if (this.bricksLeft() === 0 && this.queue.length === 0) { this.phase = 'won'; return; }
    this.updateGap();
    this.phase = 'aim';
  }

  private advance() {
    this.board.pop();
    this.board.unshift(this.queue.length ? this.queue.shift()! : new Array(COLS).fill(null));
  }

  private lost(): boolean {
    return this.board[LINE_ROW].some(c => c?.kind === 'brick');
  }

  private updateGap() {
    for (let r = LINE_ROW - 1; r >= 0; r--) {
      if (this.board[r].some(c => c?.kind === 'brick')) {
        this.closestGap = Math.min(this.closestGap, LINE_ROW - r);
        return;
      }
    }
  }

  /** Lowest row (0-based) holding a brick, or -1. */
  lowestBrickRow(): number {
    for (let r = LINE_ROW; r >= 0; r--) if (this.board[r].some(c => c?.kind === 'brick')) return r;
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
