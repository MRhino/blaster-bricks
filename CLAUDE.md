# Blaster Bricks

- Every push to `main` must bump the `version` in `package.json` (minor: 0.1.0 → 0.2.0). The start screen shows `v<major>.<minor> · <commit>` so the user can confirm they're on the latest build.
- Deploys: Vercel auto-deploys from `main`. Confirm each push: deployment Ready, GitHub check green, version string present in the live bundle.
- `src/sim.ts` is pure (no DOM). Any balance change must be checked with `npm run bot -- 30` (casual / decent / sharp bots) and the numbers reported.
- Difficulty is ONE scalar (`pressureFor`): level growth + running skill average + last level. Don't stack extra multipliers.
- Visual check: `npm run build && npx vite preview`, then screenshot with a headless Chrome. `?shot=LEVEL&ang=RAD&freeze=MS` starts a level, fires, and freezes the frame.
- The service worker must never reload mid-level (`reloadPending` in main.ts).
- Player progress must survive every deploy (`src/progress.ts`): never rename the `bb-save-v1` key; change the save shape only by bumping `SCHEMA` and adding a `MIGRATIONS` step. The mid-level run (`bb-run`) is disposable — if `GameSnapshot` or the board shape changes, bump its `v` so old runs are dropped, never progress.
- Cloud save: `api/save.ts` stores one private Vercel Blob per save ID (`saves/<ID>.json`, store `blaster-bricks-saves`, syd1). The server never lets a save with less progress overwrite one with more (`isAhead` in `src/saveid.ts`). The client syncs once on launch and after each level — never per frame; count `/api/` requests when testing.
