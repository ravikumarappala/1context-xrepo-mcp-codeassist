import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { signToken } from '../../../reusable/auth-lib/src/index.js';
import { handle } from '../src/server.js';

async function get(path, token) {
  const server = http.createServer(handle).listen(0);
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const body = await res.json();
  server.close();
  return { status: res.status, body };
}

test('returns the signed-in user\'s order in the contract shape', async () => {
  const r = await get('/orders/o-1001', signToken({ sub: 'u-1' }, 'dev-only-secret'));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['items', 'order_id', 'status', 'total']);
});
test('requires sign-in', async () => assert.equal((await get('/orders/o-1001')).status, 401));
test('never returns another user\'s order', async () => {
  assert.equal((await get('/orders/o-1002', signToken({ sub: 'u-1' }, 'dev-only-secret'))).status, 404);
});
