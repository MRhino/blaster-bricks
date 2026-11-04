// One private blob per save ID: saves/<ID>.json. No accounts, no personal data.
//   PUT merges with the stored copy (mergeSaves), so nothing is ever dropped.
//   GET  /api/save?id=<ID>        → the stored save, or 404
//   PUT  /api/save  {id, save}    → stores it unless the stored copy is further along;
//                                   always responds with whichever copy won.
import { get, put } from '@vercel/blob';
import { normalizeId, mergeSaves } from '../src/saveid.js';

const MAX_BYTES = 32_000;
// Preview/branch deploys keep their own copies so testing never touches real saves.
const PREFIX = process.env.VERCEL_ENV === 'production' ? 'saves' : 'preview/saves';
const path = (id: string) => `${PREFIX}/${id}.json`;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

async function read(id: string): Promise<Record<string, unknown> | null> {
  const r = await get(path(id), { access: 'private', useCache: false });
  if (!r || r.statusCode !== 200) return null;
  try { return JSON.parse(await new Response(r.stream).text()); } catch { return null; }
}

export async function GET(req: Request) {
  const id = normalizeId(new URL(req.url).searchParams.get('id') ?? '');
  if (!id) return json({ error: 'bad id' }, 400);
  const save = await read(id);
  return save ? json({ id, save }) : json({ error: 'not found' }, 404);
}

export async function PUT(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json({ error: 'too large' }, 413);
  let body: { id?: string; save?: Record<string, unknown> };
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400); }
  const id = normalizeId(body.id ?? '');
  const save = body.save;
  if (!id || !save || typeof save !== 'object' || typeof save.level !== 'number' || !Array.isArray(save.history))
    return json({ error: 'bad save' }, 400);
  const existing = await read(id);
  // Never lose anything: level progress from whichever copy is further along,
  // plus every challenge best and the latest streak from both.
  const merged = existing ? mergeSaves(save, existing) : save;
  if (existing && JSON.stringify(merged) === JSON.stringify(existing)) return json({ id, save: existing, kept: 'cloud' });
  await put(path(id), JSON.stringify(merged), {
    access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json',
  });
  return json({ id, save: merged, kept: 'merged' });
}
