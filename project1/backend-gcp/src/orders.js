// Orders domain logic. The response shape is part of the contract in contracts/openapi.yaml:
// web-portal (frontend-web) and the iOS app both read it, so change the contract first.
const ORDERS = new Map([
  ['o-1001', { order_id: 'o-1001', user: 'u-1', status: 'shipped', total: 42.5, items: [{ sku: 'sku-100', quantity: 2 }] }],
  ['o-1002', { order_id: 'o-1002', user: 'u-2', status: 'processing', total: 18, items: [{ sku: 'sku-300', quantity: 1 }] }],
]);

/** Return the order if it belongs to the signed-in user; null otherwise (no hint whether it exists). */
export function getOrderForUser(orderId, userId) {
  const o = ORDERS.get(orderId);
  if (!o || o.user !== userId) return null;
  const { user: _user, ...publicFields } = o;
  return publicFields;
}
