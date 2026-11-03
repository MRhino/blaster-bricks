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
