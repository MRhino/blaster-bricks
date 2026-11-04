// Tiny WebAudio synth. iOS only allows audio after a user gesture, so
// unlock() runs on the first pointerdown; resume() again after the app returns.
let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = localStorage.getItem('bb-muted') === '1';
let lastHit = 0;
let hitStreak = 0;

export function unlock() {
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state !== 'running') void ctx.resume();
}

export function isMuted() { return muted; }
export function setMuted(m: boolean) {
  muted = m;
  localStorage.setItem('bb-muted', m ? '1' : '0');
  if (master) master.gain.value = m ? 0 : 0.5;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && ctx && ctx.state !== 'running') void ctx.resume();
});

function tone(freq: number, dur: number, type: OscillatorType, vol: number, slide = 0, delay = 0) {
  if (!ctx || !master || muted) return;
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq * slide), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t); o.stop(t + dur + 0.02);
}

const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

export const sfx = {
  hit() {
    if (!ctx) return;
    const now = ctx.currentTime;
    if (now - lastHit < 0.035) return; // throttle: a volley can produce hundreds
    hitStreak = now - lastHit < 0.4 ? Math.min(PENTA.length - 1, hitStreak + 1) : 0;
    lastHit = now;
    tone(440 * Math.pow(2, PENTA[hitStreak] / 12), 0.07, 'triangle', 0.12);
  },
  break() { tone(880, 0.18, 'sine', 0.2, 0.35); tone(1320, 0.1, 'triangle', 0.08) },
  laser() { tone(1800, 0.25, 'sawtooth', 0.07, 0.15) },
  power() { [0, 4, 7, 12].forEach((s, i) => tone(660 * Math.pow(2, s / 12), 0.14, 'triangle', 0.12, 1, i * 0.05)) },
  launch() { tone(300, 0.12, 'sine', 0.12, 2) },
  clear() { [0, 4, 7, 12, 16, 19, 24].forEach((s, i) => tone(523 * Math.pow(2, s / 12), 0.3, 'triangle', 0.14, 1, i * 0.07)) },
  fail() { [7, 4, 0, -5].forEach((s, i) => tone(392 * Math.pow(2, s / 12), 0.35, 'sine', 0.14, 1, i * 0.12)) },
  tap() { tone(700, 0.05, 'sine', 0.08) },
};

export const sfx2 = {
  clang() { tone(180, 0.08, 'square', 0.04, 0.7); },
  crack() { tone(1600, 0.12, 'triangle', 0.1, 0.5); },
  shatter() { [0, 1, 2].forEach(i => tone(2400 - i * 500, 0.18, 'sawtooth', 0.05, 0.3, i * 0.03)); },
  saved() { [0, 7, 12].forEach((s, i) => tone(880 * Math.pow(2, s / 12), 0.2, 'sine', 0.12, 1, i * 0.06)); },
  boss() { tone(110, 0.12, 'sawtooth', 0.06, 0.8); },
  bossDown() { [0, -5, -12, -17].forEach((s, i) => tone(220 * Math.pow(2, s / 12), 0.5, 'sawtooth', 0.1, 0.5, i * 0.1)); },
};
