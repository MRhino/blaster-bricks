// Logic tests for streaks, freezes, save migration and cloud merges. `npm run test`
import assert from 'node:assert/strict';
import { recordChallenge, streakNow, newUnlocks, isUnlocked, COSMETICS } from '../src/meta.ts';
import { mergeSaves, freshChallengeData, cleanChallengeData } from '../src/saveid.ts';
import { dailyFor, weeklyFor, monthlyFor, daysBetween, weekKeyOf } from '../src/challenges.ts';

const mk = (): any => ({ schema: 2, level: 5, history: [0.5], lastEff: 0.5, attempt: 0, best: 5, ch: freshChallengeData() });
const r = (stars: number) => ({ stars, score: 10, rank: stars * 1e6 + 10, label: 'x' });
const daily = (k: string) => dailyFor(new Date(k + 'T12:00'));
let s = mk();

// streak builds day by day
recordChallenge(s, daily('2026-11-04'), r(1), '2026-11-04', '2026-W45');
recordChallenge(s, daily('2026-11-05'), r(2), '2026-11-05', '2026-W45');
assert.equal(s.ch.streak.count, 2);
// replaying the same day doesn't double count
recordChallenge(s, daily('2026-11-05'), r(3), '2026-11-05', '2026-W45');
assert.equal(s.ch.streak.count, 2);
assert.equal(s.ch.best['d:2026-11-05'].stars, 3, 'best keeps highest');
// 0 stars doesn't count
recordChallenge(s, daily('2026-11-06'), r(0), '2026-11-06', '2026-W45');
assert.equal(s.ch.streak.count, 2);
// weekly earns a freeze, once per week, max 2
recordChallenge(s, weeklyFor(new Date('2026-11-06T12:00')), r(1), '2026-11-06', '2026-W45');
recordChallenge(s, weeklyFor(new Date('2026-11-06T12:00')), r(2), '2026-11-06', '2026-W45');
assert.equal(s.ch.streak.freezes, 1);
// miss the 6th and 7th: one freeze isn't enough for a 2-day gap → streak shown as 0, restarts at 1
assert.equal(streakNow(s, '2026-11-07'), 2, 'one missed day covered by a freeze');
assert.equal(streakNow(s, '2026-11-08'), 0, 'two missed days not covered');
recordChallenge(s, daily('2026-11-07'), r(1), '2026-11-07', '2026-W45');
assert.equal(s.ch.streak.count, 3, 'freeze used for the 6th');
assert.equal(s.ch.streak.freezes, 0);
recordChallenge(s, daily('2026-11-10'), r(1), '2026-11-10', '2026-W46');
assert.equal(s.ch.streak.count, 1, 'reset after an uncovered gap');
assert.equal(s.ch.streak.best, 3);

// unlocks: stars + boss
const s2 = mk();
assert.equal(newUnlocks(s2).length, 0);
recordChallenge(s2, monthlyFor(new Date('2026-11-04T12:00')), r(2), '2026-11-04', '2026-W45');
const names = newUnlocks(s2).map(c => c.id).sort();
assert.deepEqual(names, ['crimson', 'void'].sort());
assert.equal(newUnlocks(s2).length, 0, 'announced once');
assert.ok(isUnlocked(COSMETICS.find(c => c.id === 'classic')!, s2));

// merge never loses challenge data, takes level from the further-along copy
const a = mk(); a.level = 9; a.ch.best['d:2026-11-04'] = { stars: 1, score: 1, rank: 1e6, label: 'a' };
const b = mk(); b.level = 3; b.ch.best['d:2026-11-04'] = { stars: 3, score: 1, rank: 3e6, label: 'b' }; b.ch.best['w:2026-W45'] = { stars: 2, score: 1, rank: 2e6, label: 'w' };
b.ch.streak = { count: 4, best: 6, last: '2026-11-05', freezes: 1, freezeWeeks: ['2026-W45'] };
const m = mergeSaves(a, b);
assert.equal(m.level, 9);
assert.equal(m.ch.best['d:2026-11-04'].stars, 3);
assert.ok(m.ch.best['w:2026-W45']);
assert.equal(m.ch.streak.count, 4); assert.equal(m.ch.streak.best, 6);
// an old (v0.5, no ch) client pushing to a merged copy keeps the challenge data
const old = { schema: 1, level: 10, history: [0.1, 0.2], lastEff: 0.2, attempt: 0, best: 10 };
const m2 = mergeSaves(old as any, m);
assert.equal(m2.level, 10); assert.equal(m2.ch.best['d:2026-11-04'].stars, 3);
// junk is tolerated
assert.deepEqual(cleanChallengeData('nope').best, {});
assert.equal(cleanChallengeData({ best: { 'd:x': { stars: 9, rank: 1 }, evil: { stars: 3, rank: 1 } } }).best['d:x'].stars, 3);

// challenges are deterministic and identical for everyone
assert.deepEqual(JSON.stringify(daily('2026-11-04').spec), JSON.stringify(daily('2026-11-04').spec));
assert.notEqual(JSON.stringify(daily('2026-11-04').spec), JSON.stringify(daily('2026-11-07').spec));
assert.equal(daily('2026-11-01').num, 1);
assert.deepEqual([4, 5, 6].map(d => daily(`2026-11-0${d}`).mechanic), ['crystal', 'steel', 'colour']);
assert.equal(weekKeyOf(new Date('2026-11-04T12:00')), '2026-W45');
assert.equal(weekKeyOf(new Date('2026-11-08T12:00')), '2026-W45', 'Sunday belongs to the same ISO week');
assert.equal(weekKeyOf(new Date('2026-11-09T12:00')), '2026-W46');
assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
assert.equal(monthlyFor(new Date('2026-11-04T12:00')).num, 1);
assert.equal(monthlyFor(new Date('2027-01-04T12:00')).num, 3);
console.log('all meta tests passed');
