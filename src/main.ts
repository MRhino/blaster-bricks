import { registerSW } from 'virtual:pwa-register';
import './style.css';
import { Game, generateLevel, pressureFor, effectiveness, FLOOR_Y, DT, ROWS, COLS, type LevelSpec } from './sim';
import { Renderer } from './render';
import { sfx, sfx2, unlock, isMuted, setMuted } from './audio';
import { challengesFor, dayKey, weekKeyOf, scoreRun, shareText, RUSH_STARS, type Challenge } from './challenges';
import { recordChallenge, streakNow, totalStars, newUnlocks, COSMETICS, isUnlocked, needText, MAX_FREEZES } from './meta';
import { COLOR_HUES } from './sim';
import { cloudId, newCloudId, displayId, lastSynced, backup, restore } from './cloud';
import { load, save, skillOf, fresh, saveRun, loadRun, clearRun, requestPersist, type Save } from './progress';

declare const __APP_VERSION__: string, __COMMIT__: string;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- app state ----------
type Mode = 'menu' | 'play' | 'paused' | 'result' | 'chal' | 'cresult' | 'cos';
let mode: Mode = 'menu';
let progress: Save = load();
let game: Game | null = null;
let spec: LevelSpec | null = null;
let current: Challenge | null = null; // the challenge being played, or null for a normal level

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
  if (debugShot || current) return;
  if (game && game.phase === 'aim' && mode !== 'result') saveRun(progress.level, progress.attempt, game.snapshot());
}

function startLevel(resume = false) {
  current = null;
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
  $('lvl-label').textContent = 'LEVEL';
  $('level').textContent = String(progress.level);
  renderer.setSkin(progress.ch.ball, progress.ch.bg);
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
type Screen = 'menu' | 'result' | 'paused' | 'chal' | 'cresult' | 'cos';
function show(id: Screen | null) {
  for (const s of ['menu', 'result', 'paused', 'chal', 'cresult', 'cos']) $(s).classList.toggle('hidden', s !== id);
  $('hud').classList.toggle('hidden', id === 'menu' || id === 'chal' || id === 'cos');
  $('controls').classList.toggle('hidden', id !== null);
  $('colorbtn').classList.toggle('hidden', id !== null || !game?.rules.colors);
  if (id) { clearTimeout(bannerTimer); $('banner').classList.remove('show'); }
  if (id === 'menu') renderMenu();
  if (id === 'chal') renderChallenges();
  if (id === 'cos') renderCosmetics();
}
function renderMenu() {
  const skill = skillOf(progress);
  const canResume = !!resumable();
  $('play').textContent = canResume ? `RESUME LEVEL ${progress.level}` : progress.level > 1 ? `PLAY LEVEL ${progress.level}` : 'PLAY';
  $('menu-stats').innerHTML = `<div><b>${progress.level}</b>LEVEL</div><div><b>${skill === null ? '—' : Math.round(skill * 100) + '%'}</b>SKILL AVG</div><div><b>${progress.history.length}</b>PLAYED</div>`;
  renderCloud();
  const st = streakNow(progress, dayKey(new Date()));
  $('streak-badge').textContent = st ? `🔥${st}` : '';
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
  if (mode === 'chal') renderChallenges();
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
  if (current) return updateChallengeHud();
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
tapped('open-chal', () => { requestPersist(); mode = 'chal'; show('chal'); });
tapped('chal-back', () => { mode = 'menu'; show('menu'); });
tapped('open-cos', () => { mode = 'cos'; show('cos'); });
tapped('cos-back', () => { mode = 'chal'; show('chal'); });
tapped('c-retry', () => { if (reloadPending) location.reload(); else if (current) startChallenge(current); });
tapped('c-back', () => { if (reloadPending) location.reload(); else { game = null; mode = 'chal'; show('chal'); } });
tapped('c-share', async () => {
  const text = $('c-share').dataset.text ?? '';
  try {
    if (navigator.share) await navigator.share({ text });
    else { await navigator.clipboard.writeText(text); $('c-share').textContent = 'Copied ✓'; }
  } catch { /* cancelled */ }
  setTimeout(() => ($('c-share').textContent = '📋 Share result'), 1800);
});
$('colorbtn').addEventListener('pointerdown', e => {
  e.stopPropagation(); unlock();
  if (!game?.rules.colors) return;
  game.color = (game.color + 1) % game.rules.colors;
  sfx.tap(); updateColorBtn();
});
tapped('restart', () => { if (current) startChallenge(current); else { clearRun(); startLevel(); } });
tapped('quit', () => {
  const wasChallenge = !!current;
  game = null; current = null;
  if (reloadPending) { location.reload(); return; }
  mode = wasChallenge ? 'chal' : 'menu'; show(mode as Screen);
});
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
    const rushing = game.isRush && (game.phase === 'aim' || game.phase === 'fly');
    if (game.phase === 'fly' || rushing) {
      if (game.phase === 'fly') flyTime += dt; else flyTime = 0;
      const speed = game.isRush ? 1 : Renderer.speedFor(game.turnTime); // rush runs on a real clock
      $('ff').classList.toggle('on', speed > 1.05);
      $('recall').classList.toggle('on', flyTime > 2.5);
      acc += dt * speed;
      let steps = 0;
      while (acc >= DT && steps < 900) {
        game.step();
        handleEvents();
        acc -= DT; steps++;
        if (game.phase === 'won' || game.phase === 'lost' || (!game.isRush && game.phase !== 'fly')) break;
      }
      if (current) hudTick(dt);
    } else { acc = 0; flyTime = 0; $('ff').classList.remove('on'); $('recall').classList.remove('on'); }
    // Compare with the previous frame, not the start of this one: recall()
    // ends the volley from a button handler, between frames.
    const wasPhase = lastPhase;
    lastPhase = game.phase;
    if (wasPhase !== game.phase && (wasPhase === 'fly' || game.phase === 'won' || game.phase === 'lost')) {
      updateHud();
      persistRun();
      if (game.phase === 'aim' && game.lowestBrickRow() >= 8) banner('CAREFUL');
      if (game.phase === 'aim' && !current && !game.rowsLeft() && game.bricksLeft() <= 3 && bricksAtEnd > 3) banner('ALMOST!');
      if (game.rowsLeft() > 0) bricksAtEnd = Math.max(1, game.bricksLeft());
      if (game.phase === 'won' || game.phase === 'lost') {
        const g = game;
        setTimeout(() => { if (game === g) (current ? finishChallenge() : finishLevel()); }, g.phase === 'won' ? 900 : 1000);
        if (g.phase === 'won') banner(current?.mechanic === 'boss' ? 'WARDEN DOWN!' : 'CLEAR!');
        else if (current?.mechanic === 'rush') banner('OVERRUN');
      }
    }
  }
  if (game) {
    const label = `×${game.phase === 'aim' ? game.pool : game.toLaunch}`;
    if (game.rules.colors) updateColorBtn();
    renderer.draw(game, mode === 'paused' ? 0 : dt, aiming, label);
  } else renderer.draw(idleGame, dt, null, '');
}

let lastClang = 0;
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
    else if (e.t === 'clang') { if (performance.now() - lastClang > 60) { lastClang = performance.now(); sfx2.clang(); } }
    else if (e.t === 'crack') sfx2.crack();
    else if (e.t === 'shatter') sfx2.shatter();
    else if (e.t === 'saved') sfx2.saved();
    else if (e.t === 'boss') { if (e.dead) sfx2.bossDown(); else sfx.hit(); }
  }
  if (ev.some(e => e.t === 'break')) updateHud();
}

// ---------- challenges ----------
const KIND_LABEL = { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY' } as const;
const starStr = (n: number) => '★'.repeat(n) + '☆'.repeat(3 - n);
function timeLeft(ms: number) {
  const m = Math.max(0, Math.floor(ms / 60000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m % 60}m left` : `${m}m left`;
}

function renderChallenges() {
  const now = new Date();
  const today = dayKey(now);
  const st = progress.ch.streak;
  const alive = streakNow(progress, today);
  $('chal-meta').innerHTML = `<div><b>🔥 ${alive}</b>STREAK</div><div><b>❄ ${st.freezes}/${MAX_FREEZES}</b>FREEZES</div><div><b>⭐ ${totalStars(progress)}</b>STARS</div><div><b>🏆 ${st.best}</b>BEST</div>`;
  const list = challengesFor(now);
  $('chal-cards').innerHTML = list.map((ch, i) => {
    const best = progress.ch.best[ch.key];
    const name = ch.kind === 'daily' ? `#${ch.num}` : ch.kind === 'weekly' ? `WEEK ${ch.num}` : `MONTH ${ch.num}`;
    const goals = ch.goals.map((g, k) => `<div>${best && best.stars > k ? '★' : '☆'} ${g}</div>`).join('');
    return `<div class="card ${ch.kind}">
      <div class="tag"><span>${KIND_LABEL[ch.kind]} ${name}</span><span>${timeLeft(ch.ends - now.getTime())}</span></div>
      <h4>${ch.title}</h4><p>${ch.blurb}</p><div class="goals">${goals}</div>
      <div class="foot"><span class="best">${best ? starStr(best.stars) : '☆☆☆'}</span>
      <button class="go" data-i="${i}">${best ? 'PLAY AGAIN' : 'PLAY'}</button></div>
      ${best ? `<p>Best: ${best.label}</p>` : ''}</div>`;
  }).join('');
  for (const b of $('chal-cards').querySelectorAll<HTMLButtonElement>('.go'))
    b.addEventListener('click', () => { unlock(); sfx.tap(); startChallenge(list[Number(b.dataset.i)]); });
}

function startChallenge(ch: Challenge) {
  current = ch;
  game = new Game(ch.spec);
  spec = ch.spec;
  game.color = 0;
  renderer.reset(game);
  renderer.setSkin(progress.ch.ball, progress.ch.bg);
  lastPhase = game.phase;
  mode = 'play';
  show(null);
  $('lvl-label').textContent = KIND_LABEL[ch.kind];
  $('level').textContent = ch.kind === 'daily' ? `#${ch.num}` : String(ch.num);
  banner(ch.title.toUpperCase());
  updateHud();
}

let hudTimer = 0;
function hudTick(dt: number) { hudTimer += dt; if (hudTimer > 0.1) { hudTimer = 0; updateHud(); } }

function updateChallengeHud() {
  const g = game!, ch = current!;
  let text = '', frac = 0;
  switch (ch.mechanic) {
    case 'crystal': {
      const total = ch.spec.crystals ?? 0;
      text = `💎 ${g.crystalsSaved} SAVED · ${g.crystalsLost} LOST · ${g.rowsLeft()} ROWS`;
      frac = 1 - (g.rowsLeft() / ch.spec.queue.length);
      void total; break;
    }
    case 'steel': case 'colour':
      text = `TURN ${g.turns + (g.phase === 'fly' ? 1 : 0)} · PAR ${ch.par} · ${g.rowsLeft() ? g.rowsLeft() + ' ROWS' : g.bricksLeft() + ' LEFT'}`;
      frac = 1 - (g.rowsLeft() / ch.spec.queue.length); break;
    case 'rush': {
      const score = Math.floor(g.destroyedHp + g.time * 5);
      const targets = RUSH_STARS[ch.twist ?? 'steel'];
      const next = targets.find(s => s > score) ?? targets[2];
      text = `${score.toLocaleString()} PTS · ${Math.floor(g.time)}s · NEXT ★ ${next.toLocaleString()}`;
      frac = Math.min(1, score / targets[2]); break;
    }
    case 'boss':
      text = `WARDEN ${g.boss?.hp ?? 0} HP · TURN ${g.turns + (g.phase === 'fly' ? 1 : 0)}`;
      frac = g.boss ? 1 - g.boss.hp / g.boss.max : 1; break;
  }
  $('rows').textContent = text;
  $('progbar').style.width = `${Math.round(frac * 100)}%`;
}

function updateColorBtn() {
  if (!game?.rules.colors) return;
  const b = $('colorbtn');
  b.style.setProperty('--c', `hsl(${COLOR_HUES[game.color]} 100% 60%)`);
  b.classList.toggle('hidden', mode !== 'play');
}

function finishChallenge() {
  if (!game || !current) return;
  const ch = current, g = game;
  const res = scoreRun(ch, g);
  const now = new Date();
  const day = ch.kind === 'daily' ? ch.key.slice(2) : dayKey(now);
  const prevBest = progress.ch.best[ch.key];
  const out = recordChallenge(progress, ch, res, day, weekKeyOf(now));
  const unlocks = newUnlocks(progress);
  save(progress);
  void syncNow();
  res.stars ? sfx.clear() : sfx.fail();

  mode = 'cresult';
  $('c-tag').textContent = `${KIND_LABEL[ch.kind]} ${ch.kind === 'daily' ? '#' + ch.num : ch.num} · ${ch.title.toUpperCase()}`;
  $('c-title').textContent = res.stars === 3 ? 'PERFECT!' : res.stars ? (g.phase === 'won' ? 'CHALLENGE CLEAR' : 'NICE RUN') : 'NOT THIS TIME';
  $('c-stars').innerHTML = [0, 1, 2].map(i => `<span class="${i < res.stars ? '' : 'off'}">★</span>`).join('');
  $('c-label').textContent = res.label;
  $('c-goals').innerHTML = ch.goals.map((goal, i) => `<li class="${i < res.stars ? 'done' : ''}">${i < res.stars ? '✓' : '○'} ${goal}</li>`).join('');
  const extra: string[] = [];
  if (out.newBest && prevBest) extra.push(`New best! (was ${starStr(prevBest.stars)})`);
  else if (prevBest && !out.newBest) extra.push(`Best: ${starStr(prevBest.stars)} ${prevBest.label}`);
  if (out.streakUp) extra.push(`🔥 Streak: ${progress.ch.streak.count} day${progress.ch.streak.count === 1 ? '' : 's'}${out.freezesUsed ? ` (used ${out.freezesUsed} ❄)` : ''}`);
  else if (ch.kind === 'daily' && !res.stars) extra.push('Get ★ on the daily to keep your streak going.');
  if (out.freezeEarned) extra.push(`❄ Streak freeze earned (${progress.ch.streak.freezes}/${MAX_FREEZES})`);
  for (const u of unlocks) extra.push(`<span class="unlock">🎁 Unlocked: ${u.name} ${u.type === 'ball' ? 'balls' : 'background'}</span>`);
  $('c-extra').innerHTML = extra.map(x => `<div>${x}</div>`).join('');
  $('c-share').dataset.text = shareText(ch, res);
  $('c-retry').textContent = res.stars === 3 ? 'PLAY AGAIN' : 'TRY AGAIN';
  show('cresult');
}

function renderCosmetics() {
  $('cos-stars').textContent = `⭐ ${totalStars(progress)} · 🏆 ${progress.ch.streak.best}-day best streak`;
  for (const type of ['ball', 'bg'] as const) {
    const sel = type === 'ball' ? progress.ch.ball : progress.ch.bg;
    $(`cos-${type}`).innerHTML = COSMETICS.filter(c => c.type === type).map(c => {
      const ok = isUnlocked(c, progress);
      const sw = type === 'ball'
        ? `<span class="sw" style="background:${c.hue === -1 ? 'conic-gradient(red,yellow,lime,cyan,blue,magenta,red)' : c.light ? '#fff' : `radial-gradient(circle,#fff 20%,hsl(${c.hue} 100% 60%))`};box-shadow:0 0 12px ${c.hue === -1 ? '#fff' : `hsl(${c.hue} 100% 60%)`}"></span>`
        : `<span class="bgsw" style="background:linear-gradient(${c.bg!.join(',')})"></span>`;
      return `<button class="cos ${c.id === sel ? 'sel' : ''} ${ok ? '' : 'locked'}" data-id="${c.id}" data-ok="${ok}">${sw}${c.name}<small>${ok ? (c.id === sel ? 'Selected' : 'Tap to use') : '🔒 ' + needText(c)}</small></button>`;
    }).join('');
    for (const b of $(`cos-${type}`).querySelectorAll<HTMLButtonElement>('.cos')) b.addEventListener('click', () => {
      if (b.dataset.ok !== 'true') return;
      sfx.tap();
      if (type === 'ball') progress.ch.ball = b.dataset.id!; else progress.ch.bg = b.dataset.id!;
      save(progress); renderer.setSkin(progress.ch.ball, progress.ch.bg); renderCosmetics();
    });
  }
}

// A decorative board behind the menu.
const idleGame = new Game(generateLevel(3, 0.9, 7));

// ---------- debug hooks (?shot=LEVEL, ?bot) for headless screenshots ----------
const qs = new URLSearchParams(location.search);
if (qs.has('debug')) (window as any).__bb = {
  get game() { return game; }, get mode() { return mode; }, get progress() { return progress; },
  challenges: (d?: string) => challengesFor(d ? new Date(d + 'T12:00') : new Date()), startChallenge: (ch: Challenge) => startChallenge(ch),
};
if (qs.has('chal')) {
  // ?chal=daily|weekly|monthly[&date=YYYY-MM-DD][&ang=RAD&freeze=MS] for screenshots
  const list = challengesFor(qs.get('date') ? new Date(qs.get('date') + 'T12:00') : new Date());
  startChallenge(list[['daily', 'weekly', 'monthly'].indexOf(qs.get('chal')!)] ?? list[0]);
  if (qs.has('ang')) { const ang = Number(qs.get('ang')); setTimeout(() => game?.launch(Math.cos(ang), Math.sin(ang)), 300); }
  if (qs.has('freeze')) setTimeout(() => { mode = 'paused'; }, Number(qs.get('freeze')));
} else if (qs.has('shot')) {
  progress = { ...fresh(), level: Number(qs.get('shot')) || 5, history: [0.7, 0.6, 0.8], lastEff: 0.7, best: 5 };
  startLevel();
  const ang = Number(qs.get('ang') ?? -1.15);
  setTimeout(() => game?.launch(Math.cos(ang), Math.sin(ang)), 300);
  if (qs.has('freeze')) setTimeout(() => { mode = 'paused'; }, Number(qs.get('freeze')));
} else show('menu');

renderer.setSkin(progress.ch.ball, progress.ch.bg);
requestAnimationFrame(frame);

cloudId();
void syncNow(); // existing players' saves go up on first launch of this build
