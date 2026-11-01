// Calls orders-api. Shape documented in project1/backend-gcp/contracts/openapi.yaml.
const BASE = globalThis.ACME_ORDERS_URL || 'http://localhost:8080';

export async function fetchOrder(orderId, token, fetchImpl = fetch) {
  const res = await fetchImpl(`${BASE}/orders/${encodeURIComponent(orderId)}`, { headers: { authorization: `Bearer ${token}` } });
  if (res.status === 401) throw new Error('Please sign in again');
  if (!res.ok) throw new Error('Order not found');
  return res.json();
}
