// Challenge progress around the game: best results, the daily streak (with
// freezes), and cosmetic unlocks. Pure: works on the Save object only.
import type { Save } from './progress.ts';
import type { BestResult } from './saveid.ts';
import { daysBetween, type Challenge, type ChallengeResult } from './challenges.ts';

export const MAX_FREEZES = 2;

/** Streak as it stands today: still alive if the gap is covered by freezes. */
export function streakNow(s: Save, today: string): number {
  const st = s.ch.streak;
  if (!st.last) return 0;
  const gap = daysBetween(st.last, today);
  return gap <= 1 || gap - 1 <= st.freezes ? st.count : 0;
}

export interface RecordOutcome {
  newBest: boolean;
  streakUp: boolean;
  freezeEarned: boolean;
  freezesUsed: number;
}

/** Store a finished challenge run. `today` is the local date key (YYYY-MM-DD). */
export function recordChallenge(s: Save, ch: Challenge, r: ChallengeResult, today: string, weekKey: string): RecordOutcome {
  const out: RecordOutcome = { newBest: false, streakUp: false, freezeEarned: false, freezesUsed: 0 };
  const prev = s.ch.best[ch.key];
  if (!prev || r.rank > prev.rank) {
    s.ch.best[ch.key] = { stars: r.stars, score: r.score, rank: r.rank, label: r.label } satisfies BestResult;
    out.newBest = true;
  }
  const st = s.ch.streak;
  if (ch.kind === 'daily' && r.stars >= 1 && st.last !== today) {
    const gap = st.last ? daysBetween(st.last, today) : 1;
    if (gap === 1) st.count++;
    else if (gap > 1 && gap - 1 <= st.freezes) { st.freezes -= gap - 1; out.freezesUsed = gap - 1; st.count++; }
    else st.count = 1;
    st.last = today;
    st.best = Math.max(st.best, st.count);
    out.streakUp = true;
  }
  // Playing the weekly earns a streak freeze (once per week, max 2 banked).
  if (ch.kind === 'weekly' && r.stars >= 1 && !st.freezeWeeks.includes(weekKey)) {
    st.freezeWeeks.push(weekKey);
    if (st.freezes < MAX_FREEZES) { st.freezes++; out.freezeEarned = true; }
  }
  return out;
}

export const totalStars = (s: Save) => Object.values(s.ch.best).reduce((a, b) => a + b.stars, 0);
export const bossBeaten = (s: Save) => Object.entries(s.ch.best).some(([k, v]) => k.startsWith('m:') && v.stars >= 2);

// ---------- cosmetics ----------
export interface Cosmetic {
  id: string;
  type: 'ball' | 'bg';
  name: string;
  need: { stars?: number; streak?: number; boss?: boolean };
  // ball: core/glow colours (hue -1 = rainbow); bg: gradient + bokeh hues
  hue?: number; light?: number;
  bg?: [string, string, string]; bokeh?: number[];
}

export const COSMETICS: Cosmetic[] = [
  { id: 'classic', type: 'ball', name: 'Classic', need: {}, hue: 195 },
  { id: 'ember', type: 'ball', name: 'Ember', need: { stars: 3 }, hue: 22 },
  { id: 'lime', type: 'ball', name: 'Lime', need: { stars: 8 }, hue: 100 },
  { id: 'gold', type: 'ball', name: 'Gold', need: { stars: 15 }, hue: 46 },
  { id: 'violet', type: 'ball', name: 'Violet', need: { stars: 25 }, hue: 275 },
  { id: 'rainbow', type: 'ball', name: 'Rainbow', need: { streak: 7 }, hue: -1 },
  { id: 'ghost', type: 'ball', name: 'Ghost', need: { streak: 30 }, hue: 0, light: 100 },
  { id: 'crimson', type: 'ball', name: 'Warden Slayer', need: { boss: true }, hue: 350 },
  { id: 'nebula', type: 'bg', name: 'Nebula', need: {}, bg: ['#0a0624', '#120a33', '#05030f'], bokeh: [200, 260, 300, 330] },
  { id: 'ocean', type: 'bg', name: 'Deep Ocean', need: { stars: 5 }, bg: ['#03122a', '#06243f', '#020a14'], bokeh: [185, 200, 215, 170] },
  { id: 'sunset', type: 'bg', name: 'Synth Sunset', need: { stars: 20 }, bg: ['#2a0a2e', '#4a1238', '#120412'], bokeh: [330, 20, 40, 300] },
  { id: 'aurora', type: 'bg', name: 'Aurora', need: { streak: 14 }, bg: ['#03161a', '#0a2a2a', '#020a0c'], bokeh: [140, 170, 280, 120] },
  { id: 'void', type: 'bg', name: 'Warden\'s Void', need: { boss: true }, bg: ['#120006', '#24000c', '#050002'], bokeh: [350, 0, 330, 15] },
];

export function isUnlocked(c: Cosmetic, s: Save): boolean {
  const n = c.need;
  if (n.stars !== undefined && totalStars(s) < n.stars) return false;
  if (n.streak !== undefined && s.ch.streak.best < n.streak) return false;
  if (n.boss && !bossBeaten(s)) return false;
  return true;
}

export const needText = (c: Cosmetic) =>
  c.need.stars ? `${c.need.stars} ⭐` : c.need.streak ? `${c.need.streak}-day streak` : c.need.boss ? 'Beat a boss' : 'Free';

export const cosmetic = (id: string, type: 'ball' | 'bg') =>
  COSMETICS.find(c => c.id === id && c.type === type) ?? COSMETICS.find(c => c.type === type)!;

/** Unlocked cosmetics the player hasn't been told about yet (marks them seen). */
export function newUnlocks(s: Save): Cosmetic[] {
  const fresh = COSMETICS.filter(c => isUnlocked(c, s) && Object.keys(c.need).length && !s.ch.seen.includes(c.id));
  s.ch.seen.push(...fresh.map(c => c.id));
  return fresh;
}
