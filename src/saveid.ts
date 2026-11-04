// Shared by the browser and the /api/save function: save IDs and "which save is further along".
// IDs are 16 chars of Crockford base32 (80 random bits): unguessable, easy to read aloud.
export const ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ID_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

/** Accepts "BB-7K3M-Q9TX-2HWP-R4FN", lowercase, spaces, O for 0, I/L for 1. */
export function normalizeId(input: string): string | null {
  let s = input.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length === 18 && s.startsWith('BB')) s = s.slice(2);
  s = s.replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  return ID_RE.test(s) ? s : null;
}

export const formatId = (id: string) => `BB-${id.match(/.{4}/g)!.join('-')}`;

interface Comparable { level?: unknown; history?: unknown }
const score = (s: Comparable | null) => s
  ? [typeof s.level === 'number' ? s.level : 0, Array.isArray(s.history) ? s.history.length : 0]
  : [-1, -1];

/** True if `a` has strictly more progress than `b` (level first, then levels played). */
export function isAhead(a: Comparable | null, b: Comparable | null): boolean {
  const [la, ha] = score(a), [lb, hb] = score(b);
  return la !== lb ? la > lb : ha > hb;
}

// ---------- challenge data (shared with the server so cloud merges never drop it) ----------
export interface BestResult { stars: number; score: number; rank: number; label: string }
export interface Streak { count: number; best: number; last: string | null; freezes: number; freezeWeeks: string[] }
export interface ChallengeData {
  best: Record<string, BestResult>; // 'd:2026-11-04' → best result
  streak: Streak;
  ball: string; // selected cosmetics
  bg: string;
  seen: string[]; // cosmetics already announced as unlocked
}

export const freshChallengeData = (): ChallengeData => ({
  best: {}, streak: { count: 0, best: 0, last: null, freezes: 0, freezeWeeks: [] }, ball: 'classic', bg: 'nebula', seen: [],
});

const isNum = (x: unknown): x is number => typeof x === 'number' && isFinite(x);
const strs = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []);

/** Tolerant: keeps every field it can validate, defaults the rest. */
export function cleanChallengeData(x: any): ChallengeData {
  const out = freshChallengeData();
  if (!x || typeof x !== 'object') return out;
  if (x.best && typeof x.best === 'object') for (const [k, v] of Object.entries<any>(x.best)) {
    if (/^[dwm]:/.test(k) && v && isNum(v.stars) && isNum(v.rank)) {
      out.best[k] = { stars: Math.max(0, Math.min(3, v.stars)), score: isNum(v.score) ? v.score : 0, rank: v.rank, label: typeof v.label === 'string' ? v.label.slice(0, 80) : '' };
    }
  }
  const s = x.streak ?? {};
  out.streak = {
    count: isNum(s.count) ? Math.max(0, s.count) : 0, best: isNum(s.best) ? Math.max(0, s.best) : 0,
    last: typeof s.last === 'string' && /^\d{4}-\d\d-\d\d$/.test(s.last) ? s.last : null,
    freezes: isNum(s.freezes) ? Math.max(0, Math.min(2, s.freezes)) : 0, freezeWeeks: strs(s.freezeWeeks).slice(-20),
  };
  out.streak.best = Math.max(out.streak.best, out.streak.count);
  if (typeof x.ball === 'string') out.ball = x.ball;
  if (typeof x.bg === 'string') out.bg = x.bg;
  out.seen = strs(x.seen);
  return out;
}

/** Combine two copies of a save without losing anything: level progress from
 *  whichever is further along, every challenge best, the most recent streak. */
export function mergeSaves<T extends { level?: unknown; history?: unknown; ch?: unknown }>(a: T, b: T): T {
  const base = isAhead(b, a) ? b : a;
  const ca = cleanChallengeData(a.ch), cb = cleanChallengeData(b.ch);
  const best = { ...ca.best };
  for (const [k, v] of Object.entries(cb.best)) if (!best[k] || v.rank > best[k].rank) best[k] = v;
  const later = (x: Streak, y: Streak) =>
    (x.last ?? '') !== (y.last ?? '') ? ((x.last ?? '') > (y.last ?? '') ? x : y) : (x.count >= y.count ? x : y);
  const streak = { ...later(ca.streak, cb.streak) };
  streak.best = Math.max(ca.streak.best, cb.streak.best, streak.count);
  streak.freezeWeeks = [...new Set([...ca.streak.freezeWeeks, ...cb.streak.freezeWeeks])].slice(-20);
  const ch: ChallengeData = { best, streak, ball: ca.ball, bg: ca.bg, seen: [...new Set([...ca.seen, ...cb.seen])] };
  return { ...base, ch };
}
