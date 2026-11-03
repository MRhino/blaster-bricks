import { registerSW } from 'virtual:pwa-register';
import './style.css';
import { Game, generateLevel, pressureFor, effectiveness, FLOOR_Y, DT, ROWS, COLS, type LevelSpec } from './sim';
import { Renderer } from './render';
import { sfx, unlock, isMuted, setMuted } from './audio';
import { cloudId, newCloudId, displayId, lastSynced, backup, restore } from './cloud';
import { load, save, skillOf, fresh, saveRun, loadRun, clearRun, requestPersist, type Save } from './progress';

declare const __APP_VERSION__: string, __COMMIT__: string;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- app state ----------
type Mode = 'menu' | 'play' | 'paused' | 'result';
let mode: Mode = 'menu';
let progress: Save = load();
let game: Game | null = null;
let spec: LevelSpec | null = null;

// ---------- service worker ----------
// A new SW must never reload the page mid-level (Gate Runner lost runs this way).
let reloadPending = false;
const updateSW = registerSW({
  immediate: true,
  onNeedReload() {
    if (mode === 'play' || mode === 'paused') reloadPending = true;
    else location.reload();
  },
});
$('refresh').addEventListener('click', async () => {
  $('refresh').textContent = 'Checking…';
  const reg = await navigator.serviceWorker?.getRegistration();
  await reg?.update();
  if (reg?.waiting) await updateSW(true);
  setTimeout(() => location.reload(), 1500);
});
$('version-text').textContent = `v${__APP_VERSION__.split('.').slice(0, 2).join('.')} · ${__COMMIT__}`;

// ---------- render ----------
const cv = $<HTMLCanvasElement>('cv');
const renderer = new Renderer(cv);
function safeInsets() {
  // env() can't be read directly; measure it with a probe element.
  const p = document.createElement('div');
  p.style.cssText = 'position:fixed;top:env(safe-area-inset-top);bottom:env(safe-area-inset-bottom);left:0;width:1px;visibility:hidden';
  document.body.appendChild(p);
  const r = p.getBoundingClientRect();
  p.remove();
  return { top: r.top, bottom: innerHeight - r.bottom };
}
function resize() {
  const s = safeInsets();
  renderer.resize(s.top + 62, s.bottom + 30);
}
addEventListener('resize', resize);
resize();

let bricksAtEnd = 1;

// ---------- levels ----------
/** A level saved mid-play that still fits this build's board, or null. */
function resumable(): Game | null {
  const snap = loadRun(progress.level, progress.attempt);
  if (!snap) return null;
  try {
    const okShape = snap.board.length === ROWS && snap.board.every(r => r.length === COLS)
      && snap.queue.every(r => r.length === COLS);
    if (!okShape) throw new Error('board shape changed');
    const g = Game.restore(snap);
    if (g.bricksLeft() === 0 && !g.rowsLeft()) throw new Error('already finished');
    return g;
  } catch { clearRun(); return null; }
}

const debugShot = new URLSearchParams(location.search).has('shot');
function persistRun() {
  if (debugShot) return;
  if (game && game.phase === 'aim' && mode !== 'result') saveRun(progress.level, progress.attempt, game.snapshot());
}

function startLevel(resume = false) {
  const restored = resume ? resumable() : null;
  if (restored) { game = restored; spec = restored.spec; }
  else {
    const skill = skillOf(progress);
    const pressure = pressureFor(progress.level, progress.lastEff, skill);
    spec = generateLevel(progress.level, pressure, progress.attempt);
    game = new Game(spec);
  }
  bricksAtEnd = Math.max(1, game.bricksLeft());
  persistRun();
  renderer.reset(game);
  lastPhase = game.phase;
  mode = 'play';
  show(null);
  $('level').textContent = String(progress.level);
  banner(restored ? `LEVEL ${progress.level} · RESUMED` : `LEVEL ${progress.level}`);
  updateHud();
}

function finishLevel() {
  if (!game || !spec) return;
  const r = game.result();
  const e = effectiveness(r);
  clearRun();
  const before = skillOf(progress);
  progress.history.push(e.score);
  if (progress.history.length > 200) progress.history.splice(0, progress.history.length - 200);
  progress.lastEff = e.score;
  const prevLevel = progress.level;
  if (r.cleared) { progress.level++; progress.attempt = 0; progress.best = Math.max(progress.best, progress.level); }
  else progress.attempt++;
  save(progress);
  void syncNow();
  const after = skillOf(progress)!;
  const nextPressure = pressureFor(progress.level, progress.lastEff, after);
  const samePressure = pressureFor(progress.level, null, null); // a neutral player's level
  r.cleared ? sfx.clear() : sfx.fail();

  mode = 'result';
  $('r-title').textContent = r.cleared ? `LEVEL ${prevLevel} CLEAR` : 'THE LINE WAS CROSSED';
  $('r-pct').textContent = String(Math.round(e.score * 100));
  const bars: [string, number, string][] = r.cleared
    ? [['SPEED', e.speed, `${r.turns} turns · par ${r.par}`], ['SAFETY', e.safety, `closest: ${r.closestGap} row${r.closestGap === 1 ? '' : 's'}`], ['ACCURACY', e.accuracy, `${(r.hits / Math.max(1, r.ballsFired)).toFixed(1)} hits/ball`]]
    : [['CLEARED', r.destroyedHp / Math.max(1, r.totalHp), `${r.destroyedHp} / ${r.totalHp}`], ['ACCURACY', e.accuracy, `${(r.hits / Math.max(1, r.ballsFired)).toFixed(1)} hits/ball`]];
  $('r-bars').innerHTML = bars.map(([k, v, tip]) =>
    `<div title="${tip}"><span>${k}</span><div class="bar"><i style="width:${Math.round(v * 100)}%"></i></div><span>${Math.round(v * 100)}</span></div>`).join('');
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  $('r-skill').textContent = `Skill average ${pct(before)} → ${pct(after)}`;
  const diff = nextPressure / samePressure;
  const word = diff > 1.06 ? 'tougher' : diff < 0.94 ? 'gentler' : 'balanced';
  $('r-next').innerHTML = r.cleared
    ? `Level ${progress.level} will be <b>${word}</b> for you`
    : `No stress — the retry is re-built <b>${word}</b>`;
  $('r-go').textContent = r.cleared ? 'NEXT' : 'TRY AGAIN';
  show('result');
}

// ---------- screens ----------
function show(id: 'menu' | 'result' | 'paused' | null) {
  for (const s of ['menu', 'result', 'paused']) $(s).classList.toggle('hidden', s !== id);
  $('hud').classList.toggle('hidden', id === 'menu');
  $('controls').classList.toggle('hidden', id !== null);
  if (id === 'menu') renderMenu();
}
function renderMenu() {
  const skill = skillOf(progress);
  const canResume = !!resumable();
  $('play').textContent = canResume ? `RESUME LEVEL ${progress.level}` : progress.level > 1 ? `PLAY LEVEL ${progress.level}` : 'PLAY';
  $('menu-stats').innerHTML = `<div><b>${progress.level}</b>LEVEL</div><div><b>${skill === null ? '—' : Math.round(skill * 100) + '%'}</b>SKILL AVG</div><div><b>${progress.history.length}</b>PLAYED</div>`;
  renderCloud();
  $('sound').textContent = isMuted() ? '🔇 Sound off' : '🔊 Sound on';
}
// ---------- cloud save ----------
let syncState: 'idle' | 'syncing' | 'offline' = 'idle';
function renderCloud() {
  $('cloud-id').textContent = displayId();
  const t = lastSynced();
  const ago = (ms: number) => ms < 60e3 ? 'just now' : ms < 3600e3 ? `${Math.round(ms / 60e3)} min ago` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} h ago` : `${Math.round(ms / 86400e3)} days ago`;
  $('cloud-status').textContent = syncState === 'syncing' ? 'Backing up…'
    : syncState === 'offline' ? 'Offline. Will back up when connected.'
    : t ? `Backed up ${ago(Date.now() - t)}` : 'Not backed up yet';
}
async function syncNow() {
  if (debugShot) return;
  syncState = 'syncing'; if (mode === 'menu') renderCloud();
  const before = lastSynced();
  const newer = await backup();
  syncState = lastSynced() > before ? 'idle' : 'offline';
  if (newer) progress = newer; // the cloud copy was further along
  if (mode === 'menu') renderMenu();
}
let bannerTimer = 0;
function banner(text: string) {
  const b = $('banner');
  b.textContent = text; b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => b.classList.remove('show'), 1200);
}
function updateHud() {
  if (!game || !spec) return;
  const total = spec.queue.length;
  const spawned = total - game.rowsLeft();
  const bricks = game.bricksLeft();
  $('rows').textContent = game.rowsLeft() ? `${game.rowsLeft()} ROWS TO COME` : `${bricks} BRICK${bricks === 1 ? '' : 'S'} LEFT`;
  const doneFrac = game.rowsLeft() ? spawned / total * 0.7 : 0.7 + 0.3 * (1 - bricks / Math.max(1, bricksAtEnd));
  $('progbar').style.width = `${Math.round(doneFrac * 100)}%`;
}

function setPaused(p: boolean) {
  if (p && mode === 'play') { mode = 'paused'; show('paused'); }
  else if (!p && mode === 'paused') { mode = 'play'; show(null); last = performance.now(); }
}

const tapped = (id: string, fn: () => void) => $(id).addEventListener('click', () => { unlock(); sfx.tap(); fn(); });
tapped('play', () => { requestPersist(); startLevel(true); });
tapped('r-go', () => { if (reloadPending) location.reload(); else startLevel(); });
tapped('r-menu', () => { if (reloadPending) location.reload(); else { mode = 'menu'; show('menu'); } });
tapped('resume', () => setPaused(false));
tapped('restart', () => { clearRun(); startLevel(); });
tapped('quit', () => { mode = 'menu'; game = null; show('menu'); if (reloadPending) location.reload(); });
tapped('cloud-copy', async () => {
  try { await navigator.clipboard.writeText(displayId()); $('cloud-copy').textContent = 'Copied ✓'; }
  catch { $('cloud-copy').textContent = 'Select & copy'; }
  setTimeout(() => ($('cloud-copy').textContent = 'Copy'), 1800);
});
tapped('cloud-restore', async () => {
  const input = prompt('Enter the save ID from your other device (BB-XXXX-XXXX-XXXX-XXXX):');
  if (!input) return;
  $('cloud-status').textContent = 'Restoring…';
  const r = await restore(input);
  if (!r.ok) { alert(r.reason); renderCloud(); return; }
  progress = load();
  renderMenu();
  alert(`Save restored: level ${r.level}. This device now backs up to that ID.`);
});
tapped('sound', () => { setMuted(!isMuted()); renderMenu(); });
tapped('reset', () => {
  const oldId = displayId();
  if (!confirm(`Reset level and skill history?\n\nYour current progress stays in the cloud under ${oldId} if you ever want it back.`)) return;
  newCloudId();
  progress = fresh();
  save(progress); clearRun(); renderMenu();
});
$('pause').addEventListener('pointerdown', e => { e.stopPropagation(); setPaused(true); });
$('recall').addEventListener('pointerdown', e => { e.stopPropagation(); game?.recall(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) setPaused(true); });

// ---------- aiming ----------
// Point above the launcher to aim at that spot. Drag below it and it works as a slingshot.
let aiming: { downX: number; downY: number; x: number; y: number; ok: boolean; id: number } | null = null;
const MIN_UP = Math.sin((10 * Math.PI) / 180);

function aimFrom(px: number, py: number) {
  if (!game || !aiming) return;
  const f = renderer.toField(px, py);
  const lx = game.launchX, ly = FLOOR_Y;
  let dx: number, dy: number;
  if (f.y < ly - 40) { dx = f.x - lx; dy = f.y - ly; }
  else {
    const d = renderer.toField(aiming.downX, aiming.downY);
    dx = d.x - f.x; dy = d.y - f.y;
  }
  const len = Math.hypot(dx, dy);
  if (len < 25) { aiming.ok = false; return; }
  aiming.x = dx / len; aiming.y = dy / len;
  aiming.ok = -aiming.y >= MIN_UP;
  if (!aiming.ok && aiming.y < 0.5) {
    // too flat: show it clamped but greyed so the player sees why it won't fire
    aiming.y = -MIN_UP * 0.98; aiming.x = Math.sign(dx) * Math.sqrt(1 - aiming.y ** 2);
  }
}

cv.addEventListener('pointerdown', e => {
  unlock();
  if (mode !== 'play' || game?.phase !== 'aim') return;
  if (e.clientY > innerHeight - 24) return; // iOS home-indicator zone
  cv.setPointerCapture(e.pointerId);
  aiming = { downX: e.clientX, downY: e.clientY, x: 0, y: -1, ok: false, id: e.pointerId };
  aimFrom(e.clientX, e.clientY);
});
cv.addEventListener('pointermove', e => { if (aiming?.id === e.pointerId) aimFrom(e.clientX, e.clientY); });
cv.addEventListener('pointerup', e => {
  if (aiming?.id !== e.pointerId) return;
  const a = aiming; aiming = null;
  if (a.ok && game?.launch(a.x, a.y)) sfx.launch();
});
cv.addEventListener('pointercancel', () => { aiming = null; });

// ---------- loop ----------
let last = performance.now();
let acc = 0;
let flyTime = 0;
let lastPhase: Game['phase'] = 'aim';
function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  if (game && mode === 'play') {
    if (game.phase === 'fly') {
      flyTime += dt;
      const speed = Renderer.speedFor(game.turnTime);
      $('ff').classList.toggle('on', speed > 1.05);
      $('recall').classList.toggle('on', flyTime > 2.5);
      acc += dt * speed;
      let steps = 0;
      while (acc >= DT && steps < 900) {
        game.step();
        handleEvents();
        acc -= DT; steps++;
        if (game.phase !== 'fly') break;
      }
    } else { acc = 0; flyTime = 0; $('ff').classList.remove('on'); $('recall').classList.remove('on'); }
    // Compare with the previous frame, not the start of this one: recall()
    // ends the volley from a button handler, between frames.
    const wasPhase = lastPhase;
    lastPhase = game.phase;
    if (wasPhase === 'fly' && game.phase !== 'fly') {
      updateHud();
      persistRun();
      if (game.phase === 'aim' && game.lowestBrickRow() >= 8) banner('CAREFUL');
      if (game.phase === 'aim' && !game.rowsLeft() && game.bricksLeft() <= 3 && bricksAtEnd > 3) banner('ALMOST!');
      if (game.rowsLeft() > 0) bricksAtEnd = Math.max(1, game.bricksLeft());
      if (game.phase === 'won' || game.phase === 'lost') {
        const g = game;
        setTimeout(() => { if (game === g) finishLevel(); }, g.phase === 'won' ? 700 : 900);
        if (g.phase === 'won') banner('CLEAR!');
      }
    }
  }
  if (game) {
    const label = `×${game.phase === 'aim' ? game.pool : game.toLaunch}`;
    renderer.draw(game, mode === 'paused' ? 0 : dt, aiming, label);
  } else renderer.draw(idleGame, dt, null, '');
}

function handleEvents() {
  if (!game) return;
  const ev = game.events;
  if (!ev.length) return;
  renderer.onEvents(ev, game);
  for (const e of ev) {
    if (e.t === 'hit') sfx.hit();
    else if (e.t === 'break') sfx.break();
    else if (e.t === 'laser') sfx.laser();
    else if (e.t === 'power') sfx.power();
  }
  if (ev.some(e => e.t === 'break')) updateHud();
}

// A decorative board behind the menu.
const idleGame = new Game(generateLevel(3, 0.9, 7));

// ---------- debug hooks (?shot=LEVEL, ?bot) for headless screenshots ----------
const qs = new URLSearchParams(location.search);
if (qs.has('debug')) (window as any).__bb = { get game() { return game; }, get mode() { return mode; } };
if (qs.has('shot')) {
  progress = { ...fresh(), level: Number(qs.get('shot')) || 5, history: [0.7, 0.6, 0.8], lastEff: 0.7, best: 5 };
  startLevel();
  const ang = Number(qs.get('ang') ?? -1.15);
  setTimeout(() => game?.launch(Math.cos(ang), Math.sin(ang)), 300);
  if (qs.has('freeze')) setTimeout(() => { mode = 'paused'; }, Number(qs.get('freeze')));
} else show('menu');

requestAnimationFrame(frame);

cloudId();
void syncNow(); // existing players' saves go up on first launch of this build
