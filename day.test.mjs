// Deterministic tests for the day rhythm helpers (no model, no server).
import { dayKey, parseWrapHour, morningDue, wrapDecision } from './night.mjs';

let bad = 0, n = 0;
const eq = (name, got, exp) => {
  n++;
  if (JSON.stringify(got) !== JSON.stringify(exp)) { bad++; console.log(`MISMATCH ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`); }
};
const TZ = 'Asia/Tokyo'; // fixed zone, so the test does not depend on the machine's timezone
const local = (iso) => Date.parse(iso + '+09:00');

eq('dayKey uses the given zone, not UTC', dayKey(local('2026-10-12T01:00:00'), TZ), '2026-10-12');
eq('dayKey just before midnight', dayKey(local('2026-10-12T23:59:00'), TZ), '2026-10-12');
eq('dayKey rolls at local midnight', dayKey(local('2026-10-13T00:01:00'), TZ), '2026-10-13');
eq('parseWrapHour hh:mm', parseWrapHour('18:30'), 18.5);
eq('parseWrapHour decimal', parseWrapHour('17.25'), 17.25);
eq('parseWrapHour junk → default', parseWrapHour('late'), 18.5);
eq('parseWrapHour empty → default', parseWrapHour(undefined), 18.5);
eq('parseWrapHour out of range', parseWrapHour('25:00'), 18.5);

const now = local('2026-10-12T09:00:00');
eq('first message ever', morningDue({ now, tz: TZ, lastMorningDate: undefined }), true);
eq('yesterday’s morning', morningDue({ now, tz: TZ, lastMorningDate: '2026-10-11' }), true);
eq('already briefed today', morningDue({ now, tz: TZ, lastMorningDate: '2026-10-12' }), false);
eq('after local midnight is a new day', morningDue({ tz: TZ, now: local('2026-10-13T00:05:00'), lastMorningDate: '2026-10-12' }), true);

const base = { now: local('2026-10-12T18:40:00'), lastUserAt: local('2026-10-12T14:00:00'), lastWrapDate: '2026-10-11', wrapHour: 18.5, tz: TZ };
eq('wraps after the hour', wrapDecision(base).wrap, true);
eq('too early', wrapDecision({ ...base, now: local('2026-10-12T18:29:00') }).wrap, false);
eq('exactly at the hour', wrapDecision({ ...base, now: local('2026-10-12T18:30:00') }).wrap, true);
eq('once a day', wrapDecision({ ...base, lastWrapDate: '2026-10-12' }).wrap, false);
eq('person silent today', wrapDecision({ ...base, lastUserAt: local('2026-10-11T20:00:00') }).wrap, false);
eq('no user ever', wrapDecision({ ...base, lastUserAt: 0 }).wrap, false);
eq('turn running', wrapDecision({ ...base, turnActive: true }).wrap, false);
eq('rotating', wrapDecision({ ...base, rotating: true }).wrap, false);
eq('workers running', wrapDecision({ ...base, workers: 2 }).wrap, false);
eq('never in a night shift', wrapDecision({ ...base, nightActive: true }).wrap, false);

console.log(bad ? `FAILED (${bad}/${n})` : `day: all ${n} cases ok`);
process.exit(bad ? 1 : 0);
