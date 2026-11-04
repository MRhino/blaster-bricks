// Canvas 2D renderer. Glow is pre-rendered into sprites once and composited
// with 'lighter' — per-frame shadowBlur is far too slow on iOS Safari.
import {
  Game, COLS, ROWS, CELL, W, H, TOP, LINE_Y, LINE_ROW, FLOOR_Y, BALL_R, POWER_R, BRICK_PAD,
  BALL_SPEED, COLOR_HUES, type Ball, type Cell, type SimEvent, type PowerType,
} from './sim';
import { cosmetic } from './meta';

const BRICK = CELL - 2 * BRICK_PAD;
const GLOW = 22;

function sprite(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void) {
  const cv = document.createElement('canvas');
  cv.width = Math.ceil(w); cv.height = Math.ceil(h);
  draw(cv.getContext('2d')!);
  return cv;
}

function radial(size: number, stops: [number, string][]) {
  return sprite(size, size, c => {
    const g = c.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    for (const [o, col] of stops) g.addColorStop(o, col);
    c.fillStyle = g; c.fillRect(0, 0, size, size);
  });
}

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
}

// Brick colour by strength relative to the level's toughest brick:
// weak = cyan, mid = violet/magenta, tough = hot orange. Distinct tiers, not subtle shades.
const TIERS = [190, 215, 255, 285, 315, 340, 15, 35];
const tierOf = (hp: number, maxHp: number) =>
  Math.min(TIERS.length - 1, Math.floor((hp / Math.max(1, maxHp)) * TIERS.length));

const POWER_COL: Record<PowerType, string> = {
  laserH: '#ff3d6e', laserV: '#ff3d6e', multi: '#ffd23f', redirect: '#3dffa8', extra: '#ffffff', prism: '#ffffff',
};
const colorCss = (i: number, l = 62) => `hsl(${COLOR_HUES[i]} 100% ${l}%)`;

function brickSprites(hue: number, sat = 95) {
  const body = sprite(BRICK, BRICK, c => {
    const g = c.createLinearGradient(0, 0, 0, BRICK);
    g.addColorStop(0, `hsl(${hue} ${sat}% 62%)`);
    g.addColorStop(1, `hsl(${hue} ${sat * 0.95}% 42%)`);
    c.fillStyle = g; rr(c, 0, 0, BRICK, BRICK, 14); c.fill();
    c.strokeStyle = `hsl(${hue} ${sat}% 85%)`; c.lineWidth = 3; rr(c, 1.5, 1.5, BRICK - 3, BRICK - 3, 13); c.stroke();
    const s = c.createLinearGradient(0, 0, 0, BRICK * 0.5);
    s.addColorStop(0, '#ffffff55'); s.addColorStop(1, '#ffffff00');
    c.fillStyle = s; rr(c, 6, 5, BRICK - 12, BRICK * 0.42, 10); c.fill();
  });
  const glow = sprite(BRICK + GLOW * 2, BRICK + GLOW * 2, c => {
    c.shadowColor = `hsl(${hue} ${sat}% 60%)`; c.shadowBlur = GLOW;
    c.fillStyle = `hsl(${hue} ${sat}% 55%)`;
    rr(c, GLOW, GLOW, BRICK, BRICK, 14); c.fill();
  });
  return { body, glow };
}

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; spr: HTMLCanvasElement }
interface Beam { dir: 'h' | 'v'; row: number; col: number; life: number }
interface Floater { x: number; y: number; text: string; life: number; col: string }
interface Ring { x: number; y: number; life: number; col: string }

export class Renderer {
  cv: HTMLCanvasElement;
  c: CanvasRenderingContext2D;
  scale = 1; ox = 0; oy = 0; dpr = 1;
  private brickSpr: HTMLCanvasElement[] = [];
  private brickGlowSpr: HTMLCanvasElement[] = [];
  private ballSpr!: HTMLCanvasElement;
  private ballGlow!: HTMLCanvasElement;
  private ballCache = new Map<string, { spr: HTMLCanvasElement; glow: HTMLCanvasElement }>();
  private skinHue = 195;
  private skinLight = false;
  private bgStops: [string, string, string] = ['#0a0624', '#120a33', '#05030f'];
  private colorBricks: { body: HTMLCanvasElement; glow: HTMLCanvasElement }[] = [];
  private greyBrick!: { body: HTMLCanvasElement; glow: HTMLCanvasElement };
  private steelSpr!: HTMLCanvasElement;
  private crystalGlow!: HTMLCanvasElement;
  private bossFlash = -9;
  private sparkSpr: HTMLCanvasElement[] = [];
  private bokeh: { x: number; y: number; r: number; vx: number; vy: number; hue: number; a: number }[] = [];
  private bokehSpr: HTMLCanvasElement[] = [];
  private particles: Particle[] = [];
  private beams: Beam[] = [];
  private floaters: Floater[] = [];
  private rings: Ring[] = [];
  private flash = new Map<number, number>(); // brick id → hit time
  private trails = new WeakMap<Ball, number[]>();
  private shake = 0;
  private t = 0;
  // smooth row descent: rendered rows lag the sim by this many rows
  private descend = 0;
  private lastTurns = 0;
  private displayLaunchX = W / 2;

  constructor(cv: HTMLCanvasElement) {
    this.cv = cv;
    this.c = cv.getContext('2d', { alpha: false })!;
    for (const hue of TIERS) {
      this.brickSpr.push(sprite(BRICK, BRICK, c => {
        const g = c.createLinearGradient(0, 0, 0, BRICK);
        g.addColorStop(0, `hsl(${hue} 95% 62%)`);
        g.addColorStop(1, `hsl(${hue} 90% 42%)`);
        c.fillStyle = g; rr(c, 0, 0, BRICK, BRICK, 14); c.fill();
        c.strokeStyle = `hsl(${hue} 100% 85%)`; c.lineWidth = 3; rr(c, 1.5, 1.5, BRICK - 3, BRICK - 3, 13); c.stroke();
        const s = c.createLinearGradient(0, 0, 0, BRICK * 0.5);
        s.addColorStop(0, '#ffffff55'); s.addColorStop(1, '#ffffff00');
        c.fillStyle = s; rr(c, 6, 5, BRICK - 12, BRICK * 0.42, 10); c.fill();
      }));
      this.brickGlowSpr.push(sprite(BRICK + GLOW * 2, BRICK + GLOW * 2, c => {
        c.shadowColor = `hsl(${hue} 100% 60%)`; c.shadowBlur = GLOW;
        c.fillStyle = `hsl(${hue} 100% 55%)`;
        rr(c, GLOW, GLOW, BRICK, BRICK, 14); c.fill();
      }));
      this.sparkSpr.push(radial(24, [[0, '#fff'], [0.25, `hsl(${hue} 100% 70%)`], [1, `hsla(${hue},100%,50%,0)`]]));
    }
    this.sparkSpr.push(radial(24, [[0, '#fff'], [0.3, '#fff8'], [1, '#fff0']]));
    this.setSkin('classic', 'nebula');
    this.colorBricks = COLOR_HUES.map(h => brickSprites(h, 100));
    this.greyBrick = brickSprites(240, 8);
    this.steelSpr = sprite(BRICK, BRICK, c => {
      const g = c.createLinearGradient(0, 0, BRICK, BRICK);
      g.addColorStop(0, '#d9dee8'); g.addColorStop(0.45, '#7d8597'); g.addColorStop(0.55, '#a9b0bf'); g.addColorStop(1, '#4a5163');
      c.fillStyle = g; rr(c, 0, 0, BRICK, BRICK, 10); c.fill();
      c.strokeStyle = '#2b3040'; c.lineWidth = 4; rr(c, 2, 2, BRICK - 4, BRICK - 4, 9); c.stroke();
      c.strokeStyle = '#ffffff55'; c.lineWidth = 2;
      c.beginPath(); c.moveTo(14, BRICK - 14); c.lineTo(BRICK - 14, 14); c.stroke();
      c.fillStyle = '#3a4050';
      for (const [x, y] of [[14, 14], [BRICK - 14, 14], [14, BRICK - 14], [BRICK - 14, BRICK - 14]]) { c.beginPath(); c.arc(x, y, 5, 0, Math.PI * 2); c.fill(); }
    });
    this.crystalGlow = radial(150, [[0, 'rgba(160,255,250,0.55)'], [0.4, 'rgba(80,220,255,0.18)'], [1, 'rgba(80,220,255,0)']]);
    for (let i = 0; i < 18; i++) {
      this.bokeh.push({
        x: Math.random() * W, y: Math.random() * H, r: 60 + Math.random() * 180,
        vx: (Math.random() - 0.5) * 10, vy: -4 - Math.random() * 10, hue: i % 4, a: 0.25 + Math.random() * 0.4,
      });
    }
  }

  /** Apply cosmetic choices: ball skin and background theme. */
  setSkin(ballId: string, bgId: string) {
    const b = cosmetic(ballId, 'ball'), bg = cosmetic(bgId, 'bg');
    this.skinHue = b.hue ?? 195; this.skinLight = !!b.light;
    const s = this.balls(this.skinHue === -1 ? 195 : this.skinHue, this.skinLight);
    this.ballSpr = s.spr; this.ballGlow = s.glow;
    this.bgStops = bg.bg ?? this.bgStops;
    this.bokehSpr = (bg.bokeh ?? [200, 260, 300, 330]).map(h => radial(128, [[0, `hsla(${h},90%,60%,0.5)`], [1, `hsla(${h},90%,50%,0)`]]));
  }

  private balls(hue: number, white = false) {
    const key = `${hue}:${white}`;
    let s = this.ballCache.get(key);
    if (!s) {
      const mid = white ? '#ffffff' : `hsl(${hue} 100% 75%)`;
      s = {
        spr: radial(BALL_R * 2 + 4, [[0, '#ffffff'], [0.55, white ? '#ffffff' : `hsl(${hue} 100% 93%)`], [0.8, mid], [1, `hsla(${hue},100%,62%,0)`]]),
        glow: radial(BALL_R * 7, [[0, white ? 'rgba(220,235,255,0.6)' : `hsla(${hue},100%,65%,0.66)`], [0.35, white ? 'rgba(200,220,255,0.2)' : `hsla(${hue},100%,55%,0.27)`], [1, `hsla(${hue},100%,50%,0)`]]),
      };
      this.ballCache.set(key, s);
    }
    return s;
  }

  /** Sprites for one ball: colour modes show the ball's colour, rainbow cycles. */
  private ballLook(b: Ball | null, i: number, g: Game) {
    if (g.rules.colors) return this.balls(COLOR_HUES[(b ? b.color : g.color) ?? 0]);
    if (this.skinHue === -1) return this.balls((Math.floor((i * 37 + this.t * 120) / 30) * 30) % 360);
    return { spr: this.ballSpr, glow: this.ballGlow };
  }

  private brickLook(cell: Cell, g: Game, maxHp: number) {
    if (g.rules.colors) return cell.color === undefined ? this.greyBrick : this.colorBricks[cell.color];
    const t = tierOf(cell.hp, maxHp);
    return { body: this.brickSpr[t], glow: this.brickGlowSpr[t] };
  }

  resize(topPx: number, bottomPx: number) {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = innerWidth, h = innerHeight;
    this.cv.width = Math.round(w * this.dpr); this.cv.height = Math.round(h * this.dpr);
    const availH = h - topPx - bottomPx;
    this.scale = Math.min((w - 12) / W, availH / H);
    this.ox = (w - W * this.scale) / 2;
    this.oy = topPx + (availH - H * this.scale) / 2;
  }

  /** Screen (CSS px) → field coordinates. */
  toField(sx: number, sy: number) {
    return { x: (sx - this.ox) / this.scale, y: (sy - this.oy) / this.scale };
  }

  reset(g: Game) {
    this.particles.length = 0; this.beams.length = 0; this.floaters.length = 0; this.rings.length = 0;
    this.flash.clear(); this.descend = 0; this.lastTurns = g.turns; this.displayLaunchX = g.launchX;
  }

  levelMax(g: Game) {
    let m = 1;
    for (const row of g.board) for (const c of row) if (c?.kind === 'brick') m = Math.max(m, c.max);
    for (const row of g.queue) for (const c of row) if (c?.kind === 'brick') m = Math.max(m, c.max);
    return m;
  }

  onEvents(events: SimEvent[], g: Game) {
    const maxHp = this.levelMax(g);
    for (const e of events) {
      switch (e.t) {
        case 'hit': this.flash.set(e.id, this.t); break;
        case 'break': {
          const spr = this.sparkSpr[tierOf(e.max, maxHp)];
          for (let i = 0; i < 18; i++) {
            const a = Math.random() * Math.PI * 2, s = 150 + Math.random() * 520;
            this.addParticle(e.x + (Math.random() - 0.5) * 60, e.y + (Math.random() - 0.5) * 60, Math.cos(a) * s, Math.sin(a) * s, 0.5 + Math.random() * 0.5, 18 + Math.random() * 22, spr);
          }
          this.rings.push({ x: e.x, y: e.y, life: 1, col: '#ffffff' });
          this.shake = Math.min(14, this.shake + 3);
          break;
        }
        case 'laser':
          this.beams.push({ dir: e.dir, row: e.row, col: e.col, life: 1 });
          this.shake = Math.min(14, this.shake + 2);
          break;
        case 'power':
          this.rings.push({ x: e.x, y: e.y, life: 1, col: POWER_COL[e.power] });
          if (e.power === 'multi') this.floaters.push({ x: e.x, y: e.y, text: `×3  +${e.amount}`, life: 1, col: '#ffd23f' });
          if (e.power === 'extra') this.floaters.push({ x: e.x, y: e.y, text: `+${e.amount} BALL${e.amount! > 1 ? 'S' : ''}`, life: 1, col: '#ffffff' });
          for (let i = 0; i < 24; i++) {
            const a = (i / 24) * Math.PI * 2;
            this.addParticle(e.x, e.y, Math.cos(a) * 420, Math.sin(a) * 420, 0.5, 16, this.sparkSpr[TIERS.length]);
          }
          break;
        case 'block':
          if (Math.random() < 0.5) this.addParticle(e.x, e.y, 0, 0, 0.2, 22, this.sparkSpr[TIERS.length]);
          break;
        case 'clang':
          if (Math.random() < 0.6) for (let i = 0; i < 3; i++) this.addParticle(e.x + (Math.random() - 0.5) * 50, e.y + (Math.random() - 0.5) * 50, (Math.random() - 0.5) * 400, (Math.random() - 0.5) * 400, 0.25, 14, this.sparkSpr[TIERS.length]);
          break;
        case 'crack':
          this.flash.set(e.id, this.t);
          this.floaters.push({ x: e.x, y: e.y - 20, text: `${'◆'.repeat(e.hp)}${'◇'.repeat(3 - e.hp)}`, life: 0.8, col: '#9ffcff' });
          break;
        case 'shatter':
          for (let i = 0; i < 26; i++) { const a = Math.random() * Math.PI * 2, s = 200 + Math.random() * 500; this.addParticle(e.x, e.y, Math.cos(a) * s, Math.sin(a) * s, 0.7, 20, this.sparkSpr[0]); }
          this.floaters.push({ x: e.x, y: e.y, text: 'SHATTERED', life: 1, col: '#ff6b8a' });
          this.shake = Math.min(14, this.shake + 4);
          break;
        case 'saved':
          this.rings.push({ x: e.x, y: e.y, life: 1, col: '#9ffcff' });
          this.floaters.push({ x: e.x, y: e.y - 30, text: '+1 CRYSTAL', life: 1.2, col: '#9ffcff' });
          break;
        case 'boss':
          this.bossFlash = this.t;
          if (e.dead) {
            for (let i = 0; i < 90; i++) { const a = Math.random() * Math.PI * 2, s = 200 + Math.random() * 900; this.addParticle(e.x, e.y, Math.cos(a) * s, Math.sin(a) * s, 0.6 + Math.random() * 0.8, 24 + Math.random() * 30, this.sparkSpr[Math.floor(Math.random() * TIERS.length)]); }
            this.shake = 30;
          }
          break;
        case 'wall':
          if (Math.random() < 0.3) this.addParticle(e.x, e.y, 0, 0, 0.25, 26, this.sparkSpr[0]);
          break;
      }
    }
  }

  private addParticle(x: number, y: number, vx: number, vy: number, life: number, size: number, spr: HTMLCanvasElement) {
    if (this.particles.length > 700) this.particles.shift();
    this.particles.push({ x, y, vx, vy, life, max: life, size, spr });
  }

  draw(g: Game, dt: number, aim: { x: number; y: number; ok: boolean } | null, ballsLabel: string) {
    this.t += dt;
    const c = this.c;
    if (g.turns !== this.lastTurns) { if (!g.isRush) this.descend += g.turns - this.lastTurns; this.lastTurns = g.turns; }
    this.descend = Math.max(0, this.descend - dt * 4.5);
    if (this.descend < 0.001) this.descend = 0;
    this.displayLaunchX += (g.launchX - this.displayLaunchX) * Math.min(1, dt * 12);
    // ease-out: rows glide down rather than snap
    const lag = this.descend * this.descend;

    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    // backdrop
    const bg = c.createLinearGradient(0, 0, 0, innerHeight);
    bg.addColorStop(0, this.bgStops[0]); bg.addColorStop(0.6, this.bgStops[1]); bg.addColorStop(1, this.bgStops[2]);
    c.fillStyle = bg; c.fillRect(0, 0, innerWidth, innerHeight);

    this.shake *= Math.pow(0.002, dt);
    const sx = (Math.random() - 0.5) * this.shake, sy = (Math.random() - 0.5) * this.shake;
    c.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * (this.ox + sx), this.dpr * (this.oy + sy));

    // drifting bokeh (behind everything, extends past the field)
    c.globalCompositeOperation = 'lighter';
    for (const b of this.bokeh) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.y < -b.r) { b.y = H + b.r; b.x = Math.random() * W; }
      if (b.x < -b.r) b.x = W + b.r; else if (b.x > W + b.r) b.x = -b.r;
      c.globalAlpha = b.a * (0.75 + 0.25 * Math.sin(this.t * 0.7 + b.r));
      c.drawImage(this.bokehSpr[b.hue % this.bokehSpr.length], b.x - b.r, b.y - b.r, b.r * 2, b.r * 2);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';

    // field
    c.fillStyle = '#0b0726cc';
    rr(c, -6, -6, W + 12, H + 12, 18); c.fill();
    c.strokeStyle = '#6f5bff55'; c.lineWidth = 3; c.stroke();
    // faint grid that pulses
    c.strokeStyle = `rgba(120,100,255,${0.06 + 0.03 * Math.sin(this.t * 1.3)})`;
    c.lineWidth = 2; c.beginPath();
    for (let i = 1; i < COLS; i++) { c.moveTo(i * CELL, 0); c.lineTo(i * CELL, LINE_Y); }
    for (let r = 0; r <= LINE_ROW; r++) { c.moveTo(0, TOP + r * CELL); c.lineTo(W, TOP + r * CELL); }
    c.stroke();

    // danger line
    const low = g.lowestBrickRow();
    const danger = low >= LINE_ROW - 2 ? (low >= LINE_ROW - 1 ? 1 : 0.5) : 0;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * (danger ? 8 : 2));
    c.globalCompositeOperation = 'lighter';
    c.strokeStyle = danger ? `rgba(255,60,90,${0.5 + 0.5 * pulse})` : `rgba(140,120,255,${0.35 + 0.2 * pulse})`;
    c.lineWidth = danger ? 6 : 4;
    c.setLineDash([22, 14]); c.lineDashOffset = -this.t * 40;
    c.beginPath(); c.moveTo(0, LINE_Y); c.lineTo(W, LINE_Y); c.stroke();
    c.setLineDash([]);
    if (danger) {
      const dg = c.createLinearGradient(0, LINE_Y - 160, 0, LINE_Y);
      dg.addColorStop(0, 'rgba(255,40,80,0)'); dg.addColorStop(1, `rgba(255,40,80,${0.18 * danger * pulse})`);
      c.fillStyle = dg; c.fillRect(0, LINE_Y - 160, W, 160);
    }
    c.globalCompositeOperation = 'source-over';

    // cells
    const maxHp = this.levelMax(g);
    const yOff = -lag * CELL + g.yOff;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    // glow pass
    c.globalCompositeOperation = 'lighter';
    for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) {
      const cell = g.board[r][k];
      if (!cell) continue;
      const rc = Game.cellRect(r, k);
      if (cell.kind === 'crystal') {
        c.globalAlpha = 0.6 + 0.3 * Math.sin(this.t * 3 + k);
        c.drawImage(this.crystalGlow, rc.x + rc.w / 2 - 75, rc.y + rc.h / 2 - 75 + yOff);
        continue;
      }
      if (cell.kind !== 'brick') continue;
      const hit = this.t - (this.flash.get(cell.id) ?? -9);
      c.globalAlpha = 0.45 + (hit < 0.15 ? 0.5 * (1 - hit / 0.15) : 0);
      c.drawImage(this.brickLook(cell, g, maxHp).glow, rc.x - GLOW, rc.y - GLOW + yOff);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) {
      const cell = g.board[r][k];
      if (!cell) continue;
      const rc = Game.cellRect(r, k);
      const y = rc.y + yOff;
      if (cell.kind === 'brick') {
        const hit = this.t - (this.flash.get(cell.id) ?? -9);
        const pop = hit < 0.12 ? 1 - hit / 0.12 : 0;
        const s = 1 - pop * 0.06;
        const cx = rc.x + rc.w / 2, cy = y + rc.h / 2;
        c.drawImage(this.brickLook(cell, g, maxHp).body, cx - (rc.w * s) / 2, cy - (rc.h * s) / 2, rc.w * s, rc.h * s);
        if (pop) { c.fillStyle = `rgba(255,255,255,${pop * 0.55})`; rr(c, cx - (rc.w * s) / 2, cy - (rc.h * s) / 2, rc.w * s, rc.h * s, 14); c.fill(); }
        const txt = String(cell.hp);
        c.font = `900 ${txt.length > 3 ? 28 : 36}px system-ui, -apple-system, sans-serif`;
        c.fillStyle = '#00000055'; c.fillText(txt, cx + 2, cy + 3);
        c.fillStyle = '#fff'; c.fillText(txt, cx, cy + 1);
      } else if (cell.kind === 'steel') c.drawImage(this.steelSpr, rc.x, y);
      else if (cell.kind === 'crystal') this.drawCrystal(cell, rc.x + rc.w / 2, y + rc.h / 2);
      else if (cell.kind === 'power') this.drawPower(cell.power!, rc.x + rc.w / 2, y + rc.h / 2, cell.color);
    }
    if (g.boss && g.boss.hp > 0) this.drawBoss(g, yOff);

    // beams
    c.globalCompositeOperation = 'lighter';
    for (const b of this.beams) {
      b.life -= dt * 2.6;
      const a = Math.max(0, b.life);
      const cc = Game.cellCenter(b.row, b.col);
      for (const [wid, col] of [[46, `rgba(255,60,110,${0.35 * a})`], [18, `rgba(255,140,170,${0.8 * a})`], [6, `rgba(255,255,255,${a})`]] as const) {
        c.fillStyle = col;
        if (b.dir === 'h') c.fillRect(0, cc.y - wid / 2 + g.yOff, W, wid);
        else c.fillRect(cc.x - wid / 2, 0, wid, LINE_Y);
      }
    }
    this.beams = this.beams.filter(b => b.life > 0);

    // balls + trails
    let bi = 0;
    for (const b of g.balls) {
      const look = this.ballLook(b, bi++, g);
      let tr = this.trails.get(b);
      if (!tr) { tr = []; this.trails.set(b, tr); }
      tr.unshift(b.x, b.y);
      if (tr.length > 10) tr.length = 10;
      for (let i = 2; i < tr.length; i += 2) {
        const f = 1 - i / 10;
        c.globalAlpha = 0.4 * f;
        const s = BALL_R * 2 * (0.4 + 0.6 * f);
        c.drawImage(look.spr, tr[i] - s / 2, tr[i + 1] - s / 2, s, s);
      }
      c.globalAlpha = 0.9;
      c.drawImage(look.glow, b.x - BALL_R * 3.5, b.y - BALL_R * 3.5);
      c.globalAlpha = 1;
    }
    c.globalCompositeOperation = 'source-over';
    bi = 0;
    for (const b of g.balls) c.drawImage(this.ballLook(b, bi++, g).spr, b.x - BALL_R - 2, b.y - BALL_R - 2);

    // launcher
    const lx = this.displayLaunchX;
    const waiting = g.phase === 'aim' ? g.pool : g.toLaunch;
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.7 + 0.3 * Math.sin(this.t * 3);
    const launchLook = this.ballLook(null, 0, g);
    c.drawImage(launchLook.glow, lx - BALL_R * 5, FLOOR_Y - BALL_R - BALL_R * 5, BALL_R * 10, BALL_R * 10);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    if (waiting > 0) c.drawImage(launchLook.spr, lx - BALL_R - 2, FLOOR_Y - BALL_R * 2 - 2);
    if (g.rules.colors && g.phase === 'aim') {
      c.strokeStyle = colorCss(g.color); c.lineWidth = 4;
      c.beginPath(); c.arc(lx, FLOOR_Y - BALL_R, 22 + 3 * Math.sin(this.t * 5), 0, Math.PI * 2); c.stroke();
    }
    c.font = '800 26px system-ui, -apple-system, sans-serif';
    c.fillStyle = '#cfe9ff';
    if (waiting > 0) c.fillText(ballsLabel, lx, FLOOR_Y + 22 > H ? FLOOR_Y - 40 : FLOOR_Y + 18);

    // aim guide
    if (aim && g.phase === 'aim') this.drawAim(g, aim);

    // particles, rings, floaters
    c.globalCompositeOperation = 'lighter';
    for (const p of this.particles) {
      p.life -= dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.94; p.vy = p.vy * 0.94 + 600 * dt;
      const f = Math.max(0, p.life / p.max);
      c.globalAlpha = f;
      const s = p.size * (0.5 + 0.5 * f);
      c.drawImage(p.spr, p.x - s / 2, p.y - s / 2 + yOff * 0, s, s);
    }
    this.particles = this.particles.filter(p => p.life > 0);
    for (const r of this.rings) {
      r.life -= dt * 2.2;
      const f = Math.max(0, r.life);
      c.globalAlpha = f; c.strokeStyle = r.col; c.lineWidth = 6 * f + 1;
      c.beginPath(); c.arc(r.x, r.y, 30 + (1 - f) * 90, 0, Math.PI * 2); c.stroke();
    }
    this.rings = this.rings.filter(r => r.life > 0);
    c.globalCompositeOperation = 'source-over';
    for (const f of this.floaters) {
      f.life -= dt * 0.9; f.y -= dt * 90;
      c.globalAlpha = Math.max(0, Math.min(1, f.life * 2));
      c.font = '900 40px system-ui, -apple-system, sans-serif';
      c.fillStyle = '#000a'; c.fillText(f.text, f.x + 2, f.y + 3);
      c.fillStyle = f.col; c.fillText(f.text, f.x, f.y);
    }
    this.floaters = this.floaters.filter(f => f.life > 0);
    c.globalAlpha = 1;
  }

  private drawPower(p: PowerType, x: number, y: number, color?: number) {
    const c = this.c;
    const col = p === 'prism' && color !== undefined ? colorCss(color) : POWER_COL[p];
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 4 + x);
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.5 + 0.4 * pulse;
    c.drawImage(p === 'laserH' || p === 'laserV' ? this.sparkSpr[6] : p === 'multi' ? this.sparkSpr[7] : p === 'redirect' ? this.sparkSpr[0] : this.sparkSpr[TIERS.length], x - 60, y - 60, 120, 120);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    c.lineWidth = 5; c.strokeStyle = col; c.fillStyle = '#0b0726';
    c.beginPath(); c.arc(x, y, POWER_R + pulse * 3, 0, Math.PI * 2); c.fill(); c.stroke();
    c.fillStyle = col; c.strokeStyle = col; c.lineWidth = 6; c.lineCap = 'round';
    switch (p) {
      case 'laserH':
        c.beginPath(); c.moveTo(x - 17, y); c.lineTo(x + 17, y); c.stroke();
        c.beginPath(); c.moveTo(x - 20, y); c.lineTo(x - 11, y - 8); c.lineTo(x - 11, y + 8); c.fill();
        c.beginPath(); c.moveTo(x + 20, y); c.lineTo(x + 11, y - 8); c.lineTo(x + 11, y + 8); c.fill();
        break;
      case 'laserV':
        c.beginPath(); c.moveTo(x, y - 17); c.lineTo(x, y + 17); c.stroke();
        c.beginPath(); c.moveTo(x, y - 20); c.lineTo(x - 8, y - 11); c.lineTo(x + 8, y - 11); c.fill();
        c.beginPath(); c.moveTo(x, y + 20); c.lineTo(x - 8, y + 11); c.lineTo(x + 8, y + 11); c.fill();
        break;
      case 'multi':
        c.font = '900 26px system-ui, -apple-system, sans-serif'; c.fillText('×3', x, y + 1);
        break;
      case 'extra':
        c.font = '900 26px system-ui, -apple-system, sans-serif'; c.fillText('+1', x, y + 1);
        break;
      case 'prism':
        c.beginPath(); c.moveTo(x, y - 17); c.lineTo(x + 16, y + 12); c.lineTo(x - 16, y + 12); c.closePath(); c.fill();
        c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke();
        break;
      case 'redirect': {
        const a = this.t * 3;
        c.lineWidth = 5;
        c.beginPath(); c.arc(x, y, 14, a, a + 4.2); c.stroke();
        const ex = x + Math.cos(a + 4.2) * 14, ey = y + Math.sin(a + 4.2) * 14;
        c.beginPath(); c.arc(ex, ey, 5, 0, Math.PI * 2); c.fill();
        break;
      }
    }
    c.lineCap = 'butt';
  }

  private drawCrystal(cell: Cell, x: number, y: number) {
    const c = this.c;
    const hit = this.t - (this.flash.get(cell.id) ?? -9);
    const s = 34 + (hit < 0.15 ? 6 * (1 - hit / 0.15) : 0) + 2 * Math.sin(this.t * 3 + x);
    const g = c.createLinearGradient(x, y - s, x, y + s);
    g.addColorStop(0, '#f0ffff'); g.addColorStop(0.5, '#6ff3ff'); g.addColorStop(1, '#1aa0d8');
    c.fillStyle = g;
    c.beginPath(); c.moveTo(x, y - s); c.lineTo(x + s * 0.8, y); c.lineTo(x, y + s); c.lineTo(x - s * 0.8, y); c.closePath(); c.fill();
    c.strokeStyle = '#ffffff'; c.lineWidth = 3; c.stroke();
    c.strokeStyle = '#ffffff88'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x - s * 0.8, y); c.lineTo(x + s * 0.8, y); c.moveTo(x, y - s); c.lineTo(x - s * 0.3, y); c.lineTo(x, y + s); c.stroke();
    // cracks
    c.strokeStyle = '#0b0726'; c.lineWidth = 3;
    if (cell.hp <= 2) { c.beginPath(); c.moveTo(x - 6, y - s * 0.7); c.lineTo(x + 4, y - 8); c.lineTo(x - 2, y + 6); c.stroke(); }
    if (cell.hp <= 1) { c.beginPath(); c.moveTo(x + s * 0.6, y - 4); c.lineTo(x + 8, y + 4); c.lineTo(x + 12, y + s * 0.6); c.stroke(); }
  }

  private drawBoss(g: Game, yOff: number) {
    const box = g.bossBox();
    if (!box || !g.boss) return;
    const c = this.c;
    const x = box.c0 * CELL + BRICK_PAD, y = TOP + box.r0 * CELL + BRICK_PAD + yOff;
    const w = (box.c1 - box.c0 + 1) * CELL - 2 * BRICK_PAD, h = (box.r1 - box.r0 + 1) * CELL - 2 * BRICK_PAD;
    const hue = g.boss.color !== undefined ? COLOR_HUES[g.boss.color] : 300;
    const hit = this.t - this.bossFlash;
    const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.5);
    c.globalCompositeOperation = 'lighter';
    c.globalAlpha = 0.5 + 0.3 * pulse;
    c.drawImage(this.colorBricks[g.boss.color ?? 0].glow, x - 40, y - 40, w + 80, h + 80);
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
    const body = c.createLinearGradient(x, y, x, y + h);
    body.addColorStop(0, `hsl(${hue} 100% 60%)`); body.addColorStop(1, `hsl(${hue} 90% 28%)`);
    c.fillStyle = body; rr(c, x, y, w, h, 26); c.fill();
    c.strokeStyle = `hsl(${hue} 100% 85%)`; c.lineWidth = 5; rr(c, x + 2.5, y + 2.5, w - 5, h - 5, 24); c.stroke();
    if (hit < 0.12) { c.fillStyle = `rgba(255,255,255,${0.5 * (1 - hit / 0.12)})`; rr(c, x, y, w, h, 26); c.fill(); }
    // face
    const cx = x + w / 2, cy = y + h * 0.42;
    c.fillStyle = '#0b0726';
    for (const dx of [-58, 58]) { c.beginPath(); c.ellipse(cx + dx, cy, 26, 18 + 4 * pulse, 0, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#fff';
    for (const dx of [-58, 58]) { c.beginPath(); c.arc(cx + dx + 6 * Math.sin(this.t), cy, 8, 0, Math.PI * 2); c.fill(); }
    c.fillStyle = '#0b0726'; rr(c, cx - 50, y + h * 0.66, 100, 14, 7); c.fill();
    // health bar
    const f = g.boss.hp / g.boss.max;
    c.fillStyle = '#0b0726cc'; rr(c, x + 20, y + h - 30, w - 40, 16, 8); c.fill();
    c.fillStyle = f > 0.5 ? '#7dff9a' : f > 0.25 ? '#ffd23f' : '#ff4d6d'; rr(c, x + 22, y + h - 28, (w - 44) * f, 12, 6); c.fill();
    c.font = '900 24px system-ui, -apple-system, sans-serif'; c.fillStyle = '#fff';
    c.fillText(`${g.boss.hp}`, cx, y + 22);
  }

  /** Dotted aim guide, traced through one wall/brick bounce. */
  private drawAim(g: Game, aim: { x: number; y: number; ok: boolean }) {
    const c = this.c;
    let x = g.launchX, y = FLOOR_Y - BALL_R;
    let dx = aim.x, dy = aim.y;
    const pts: number[] = [];
    let bounces = 0;
    const step = 6;
    for (let i = 0; i < 400 && bounces < 2; i++) {
      x += dx * step; y += dy * step;
      if (x < BALL_R || x > W - BALL_R) { dx = -dx; x = Math.min(W - BALL_R, Math.max(BALL_R, x)); bounces++; }
      if (y < BALL_R) { dy = -dy; bounces++; }
      if (y > FLOOR_Y) break;
      const r = Math.floor((y - TOP - g.yOff) / CELL), k = Math.floor(x / CELL);
      if (r >= 0 && r < ROWS && k >= 0 && k < COLS) {
        const cell = g.board[r][k];
        if (cell && cell.kind !== 'power') {
          const rc = Game.cellRect(r, k); rc.y += g.yOff;
          if (x > rc.x - BALL_R && x < rc.x + rc.w + BALL_R && y > rc.y - BALL_R && y < rc.y + rc.h + BALL_R) {
            // reflect on the axis we entered through
            const px = x - dx * step, py = y - dy * step;
            const inX = px > rc.x - BALL_R && px < rc.x + rc.w + BALL_R;
            if (inX) dy = -dy; else dx = -dx;
            x = px; y = py; bounces++;
          }
        }
      }
      if (i % 5 === 0) pts.push(x, y, bounces);
    }
    c.globalCompositeOperation = 'lighter';
    for (let i = 0; i < pts.length; i += 3) {
      const f = 1 - i / pts.length;
      const s = (aim.ok ? 13 : 10) * (0.5 + 0.5 * f);
      c.globalAlpha = (aim.ok ? 0.95 : 0.4) * (pts[i + 2] > 0 ? 0.55 : 1) * (0.35 + 0.65 * f);
      c.drawImage(aim.ok ? this.ballSpr : this.sparkSpr[6], pts[i] - s / 2, pts[i + 1] - s / 2, s, s);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'source-over';
  }

  /** Speed multiplier hint so the UI can show fast-forward. */
  static speedFor(turnTime: number) {
    return turnTime < 4 ? 1 : Math.min(3, 1 + (turnTime - 4) * 0.5);
  }
}

export { BALL_SPEED };
