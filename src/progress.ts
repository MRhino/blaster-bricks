// Saved progress, the running effectiveness average, and the in-progress level.
//
// Rules that keep progress safe across deploys (localStorage survives SW updates):
// - Never rename KEY. Change the shape by bumping SCHEMA and adding a step to MIGRATIONS.
// - load() never throws and never discards a save it can't fully read: it keeps
//   every field it can validate and defaults the rest.
// - Every save also writes a backup copy; a corrupt main save falls back to it.
// - The mid-level run is disposable: if it doesn't match the current sim, only
//   the run is dropped, never the progress.
import type { GameSnapshot } from './sim';
import { cleanChallengeData, freshChallengeData, type ChallengeData } from './saveid';

export interface Save {
  schema: number;
  level: number;
  history: number[]; // effectiveness score of every finished attempt, newest last
  lastEff: number | null;
  attempt: number; // retries of the current level (changes the layout)
  best: number;
  ch: ChallengeData; // challenge bests, streak, cosmetics (schema 2+)
}

const KEY = 'bb-save-v1';
const BACKUP = 'bb-save-backup';
const RUN = 'bb-run';
export const SCHEMA = 2;
export const AVG_WINDOW = 20;

// MIGRATIONS[n] upgrades a schema-n save to n+1. Add, never edit.
const MIGRATIONS: Record<number, (s: any) => any> = {
  0: s => ({ ...s, schema: 1 }), // v0.1–v0.2 saves had no schema field
  1: s => ({ ...s, schema: 2, ch: freshChallengeData() }), // v0.6: challenges
};

export const fresh = (): Save => ({ schema: SCHEMA, level: 1, history: [], lastEff: null, attempt: 0, best: 1, ch: freshChallengeData() });

function parse(raw: string | null): Save | null {
  if (!raw) return null;
  try {
    let s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return null;
    let v = typeof s.schema === 'number' ? s.schema : 0;
    while (v < SCHEMA && MIGRATIONS[v]) s = MIGRATIONS[v++](s);
    const num = (x: unknown, d: number) => (typeof x === 'number' && isFinite(x) ? x : d);
    const out = fresh();
    out.level = Math.max(1, Math.floor(num(s.level, 1)));
    out.history = Array.isArray(s.history) ? s.history.filter((x: unknown) => typeof x === 'number' && isFinite(x)) : [];
    out.lastEff = typeof s.lastEff === 'number' ? s.lastEff : null;
    out.attempt = Math.max(0, Math.floor(num(s.attempt, 0)));
    out.best = Math.max(out.level, Math.floor(num(s.best, 1)));
    out.ch = cleanChallengeData(s.ch);
    // A save from a newer build (rolled back deploy): keep what we understand.
    return out;
  } catch { return null; }
}

export function load(): Save {
  const s = parse(localStorage.getItem(KEY)) ?? parse(localStorage.getItem(BACKUP));
  if (!s) return fresh();
  save(s); // store migrated + refresh the backup straight away, not at the next level end
  return s;
}

export function save(s: Save) {
  const raw = JSON.stringify({ ...s, schema: SCHEMA });
  try { localStorage.setItem(KEY, raw); localStorage.setItem(BACKUP, raw); } catch { /* storage full/blocked */ }
}

/** Average of the last AVG_WINDOW attempts, or null before the first level. */
export function skillOf(s: Save): number | null {
  if (!s.history.length) return null;
  const h = s.history.slice(-AVG_WINDOW);
  return h.reduce((a, b) => a + b, 0) / h.length;
}

// ---------- in-progress level ----------
interface RunSave { level: number; attempt: number; snap: GameSnapshot }

export function saveRun(level: number, attempt: number, snap: GameSnapshot) {
  try { localStorage.setItem(RUN, JSON.stringify({ level, attempt, snap })); } catch { /* ignore */ }
}
export function clearRun() { localStorage.removeItem(RUN); }

/** The saved run for this level, or null if missing, stale, or from an incompatible sim. */
export function loadRun(level: number, attempt: number): GameSnapshot | null {
  try {
    const r: RunSave = JSON.parse(localStorage.getItem(RUN) ?? '');
    const s = r?.snap;
    const ok = r.level === level && r.attempt === attempt && s?.v === 1 &&
      Array.isArray(s.board) && Array.isArray(s.queue) && s.spec?.level === level && typeof s.pool === 'number';
    if (ok) return s;
  } catch { /* fall through */ }
  clearRun();
  return null;
}

/** Ask the browser not to evict our storage (iOS can clear idle home-screen apps). */
export function requestPersist() {
  void navigator.storage?.persist?.().catch(() => {});
}
