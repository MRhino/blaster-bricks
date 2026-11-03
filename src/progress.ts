// Saved progress and the player's running effectiveness average.
export interface Save {
  level: number;
  history: number[]; // effectiveness score of every finished attempt, newest last
  lastEff: number | null;
  attempt: number; // retries of the current level (changes the layout)
  best: number;
}

const KEY = 'bb-save-v1';
export const AVG_WINDOW = 20;

export function load(): Save {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '');
    if (s && typeof s.level === 'number') return s;
  } catch { /* fresh start */ }
  return { level: 1, history: [], lastEff: null, attempt: 0, best: 1 };
}

export function save(s: Save) { localStorage.setItem(KEY, JSON.stringify(s)); }

/** Average of the last AVG_WINDOW attempts, or null before the first level. */
export function skillOf(s: Save): number | null {
  if (!s.history.length) return null;
  const h = s.history.slice(-AVG_WINDOW);
  return h.reduce((a, b) => a + b, 0) / h.length;
}
