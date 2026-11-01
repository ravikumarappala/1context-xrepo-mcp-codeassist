import test from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, userFromRequest } from '../src/index.js';

test('round trip', () => assert.equal(verifyToken(signToken({ sub: 'u1' }, 's'), 's').sub, 'u1'));
test('rejects a tampered token', () => assert.throws(() => verifyToken(signToken({ sub: 'u1' }, 's') + 'x', 's')));
test('rejects an expired token', () => assert.throws(() => verifyToken(signToken({ sub: 'u1', ttlSec: -1 }, 's'), 's'), /expired/));
test('reads the bearer header', () => {
  assert.equal(userFromRequest({ authorization: `Bearer ${signToken({ sub: 'u2' }, 's')}` }, 's'), 'u2');
  assert.equal(userFromRequest({}, 's'), null);
});
