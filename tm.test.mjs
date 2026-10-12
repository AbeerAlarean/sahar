// Pure-helper tests for tm.mjs (no network, no Keychain).
import { expiryFrom, needsRefresh, parseTokens, publicUser, friendlyError, findMarker, TmError, MIND_NAME, AGENT_ID, pickMind } from './tm.mjs';
let bad = 0, n = 0;
const eq = (name, got, exp) => { n++; if (JSON.stringify(got) !== JSON.stringify(exp)) { bad++; console.log(`MISMATCH ${name}: got=${JSON.stringify(got)} expected=${JSON.stringify(exp)}`); } };

eq('expiry from string seconds', expiryFrom(1000, '3600'), 1000 + 3600000);
eq('expiry from number', expiryFrom(0, 60), 60000);
eq('expiry bad value defaults to 1h', expiryFrom(0, 'abc'), 3600000);
eq('expiry zero defaults to 1h', expiryFrom(0, 0), 3600000);
const exp = 10_000_000;
eq('fresh token: no refresh', needsRefresh(exp, exp - 6 * 60000), false);
eq('inside 5 min window: refresh', needsRefresh(exp, exp - 4 * 60000), true);
eq('exactly 5 min: refresh', needsRefresh(exp, exp - 5 * 60000), true);
eq('expired: refresh', needsRefresh(exp, exp + 1), true);
eq('never signed in: refresh', needsRefresh(0, 5), true);

eq('parse good login', parseTokens({ id_token: 'a', refresh_token: 'b', expires_in: '3600', user: { id: 'u', email: 'e@x.com', display_name: 'E' } }),
  { idToken: 'a', refreshToken: 'b', expiresIn: '3600', user: { id: 'u', email: 'e@x.com', display_name: 'E' } });
eq('parse refresh (no user)', parseTokens({ id_token: 'a', refresh_token: 'b', expires_in: 3600 })?.user, null);
eq('parse missing id_token', parseTokens({ refresh_token: 'b' }), null);
eq('parse null', parseTokens(null), null);
eq('parse missing refresh token', parseTokens({ id_token: 'a' })?.refreshToken, null);
eq('publicUser maps fields only', publicUser({ id: 'u', email: 'e', display_name: 'N', secret: 'x' }), { id: 'u', email: 'e', name: 'N' });
eq('publicUser null', publicUser(null), null);

eq('friendly keeps TmError text', friendlyError(new TmError('plain words')), 'plain words');
eq('friendly hides raw errors', /Can't reach TrueMemory/.test(friendlyError(new Error('ECONNREFUSED 1.2.3.4'))), true);
eq('marker found in nested excerpts', findMarker([{ filename: 'f', content: 'x sahar-proof-1 y' }], 'sahar-proof-1'), true);
eq('marker absent', findMarker([{ content: 'nope' }], 'sahar-proof-1'), false);
eq('marker on undefined', findMarker(undefined, 'm'), false);
eq('defaults', [MIND_NAME, AGENT_ID], ['Sahar', 'sahar']);
eq('pickMind from a bare list, case-insensitive', pickMind([{ id: 'a', name: 'Other' }, { id: 'b', name: ' sahar ' }])?.id, 'b');
eq('pickMind from { minds }', pickMind({ minds: [{ id: 'c', name: 'Sahar' }] })?.id, 'c');
eq('pickMind none', pickMind([{ id: 'a', name: 'Other' }]), null);
eq('pickMind garbage', pickMind(null), null);
eq('pickMind ignores entries without an id', pickMind([{ name: 'Sahar' }]), null);

console.log(bad ? `${bad} of ${n} FAILED` : `all ${n} tm tests pass`);
process.exit(bad ? 1 : 0);
