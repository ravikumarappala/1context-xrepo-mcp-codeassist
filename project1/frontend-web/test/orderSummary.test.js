import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSummary } from '../src/orderSummary.js';
import { fetchOrder } from '../src/api.js';

const order = { order_id: 'o-1001', status: 'shipped', total: 42.5, items: [{ sku: 'sku-100', quantity: 2 }] };

test('summary card', () => assert.deepEqual(orderSummary(order), { title: 'Order o-1001', status: 'On its way', detail: '2 items · $42.50' }));
test('fetchOrder sends the bearer token and maps 401', async () => {
  let seen;
  const fake = async (url, opts) => { seen = opts.headers.authorization; return { ok: false, status: 401 }; };
  await assert.rejects(fetchOrder('o-1', 'tok', fake), /sign in/);
  assert.equal(seen, 'Bearer tok');
});
