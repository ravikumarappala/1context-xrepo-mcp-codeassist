// Renders the order summary card. Reads order_id, status, total and items from orders-api.
const LABELS = { processing: 'Processing', shipped: 'On its way', delivered: 'Delivered', cancelled: 'Cancelled' };

export function orderSummary(order) {
  const count = order.items.reduce((n, i) => n + i.quantity, 0);
  return {
    title: `Order ${order.order_id}`,
    status: LABELS[order.status] || order.status,
    detail: `${count} item${count === 1 ? '' : 's'} · $${order.total.toFixed(2)}`,
  };
}
