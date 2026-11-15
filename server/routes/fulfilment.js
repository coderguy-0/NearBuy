'use strict';
// Seller fulfilment choices for marketplace orders.
//
// A delivery order can be fulfilled in two ways, and the seller chooses:
//   * network — the delivery job in the partner network (default, already wired into the delivery engine)
//   * self    — the shop delivers it, and the customer verifies receipt with their delivery code
// A pickup order never creates a delivery job; the customer collects it with a collection code.
const crypto = require('node:crypto');
const { route } = require('../router');
const { get, all, run, tx } = require('../db');
const { conflict, notFound, tooMany, nowIso, validate } = require('../lib');
const deductOrderStock = (...args) => require('./orders').deductOrderStock(...args);

const C = () => require('../delivery/core');
const E = () => require('../delivery/engine');

const codeMatches = (a, b) => {
  const x = Buffer.from(String(a || '').trim());
  const y = Buffer.from(String(b || '').trim());
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
};
const codeAttempts = new Map();
function limitOrderCode(key) {
  const now = Date.now();
  const list = (codeAttempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  if (list.length >= 6) throw tooMany('Too many wrong codes for this order. Wait fifteen minutes or ask the customer to refresh the code.');
  list.push(now);
  codeAttempts.set(key, list);
}
function verifyOrderCode(order, provided, kind) {
  if (order.collection_code_expires_at && order.collection_code_expires_at < nowIso()) {
    throw conflict(`This ${kind} code has expired. Ask the customer to refresh it from My Orders.`);
  }
  limitOrderCode(`${kind}:${order.id}`);
  if (!order.collection_code || !codeMatches(provided, order.collection_code)) {
    throw conflict(`That ${kind} code does not match this order.`);
  }
  codeAttempts.delete(`${kind}:${order.id}`);
}

function sellerOrder(ctx) {
  const order = get('SELECT * FROM orders WHERE code = ? AND seller_id = ?', ctx.params.code, ctx.sellerId);
  if (!order) throw notFound('Order');
  return order;
}
const networkDelivery = (orderId) => get("SELECT * FROM deliveries WHERE order_id = ? AND kind = 'forward' AND status != 'cancelled'", orderId);

/** What the seller can do with this order right now. */
function fulfilmentState(order, delivery) {
  const closed = ['cancelled', 'delivered'].includes(order.status);
  if (order.fulfilment === 'pickup') {
    return {
      mode: 'pickup', can_choose: false, delivery: null,
      collection_code_set: Boolean(order.collection_code),
      steps: [
        { key: 'accept', done: order.status !== 'new', label: 'Accept the order' },
        { key: 'pack', done: ['packed', 'ready_to_ship', 'delivered'].includes(order.status), label: 'Pack the items' },
        { key: 'collect', done: order.status === 'delivered', label: 'Hand over the package at the counter' },
      ],
      instructions: closed ? 'This order is closed.' : 'The customer collects this order from your shop. Ask for the 4-digit collection code before handing it over.',
    };
  }
  const mode = order.delivery_mode === 'self' ? 'self' : 'network';
  return {
    mode, can_choose: !closed && !delivery?.partner_id && !['shipped'].includes(order.status),
    delivery: delivery ? { code: delivery.code, status: delivery.status, status_label: C().label(delivery.status), partner_id: delivery.partner_id } : null,
    steps: [
      { key: 'choose', done: mode === 'self' || Boolean(delivery), label: 'Choose how the order is delivered' },
      { key: 'accept', done: order.status !== 'new', label: 'Accept the order' },
      { key: 'pack', done: ['packed', 'ready_to_ship', 'delivered'].includes(order.status), label: 'Pack the items' },
      { key: 'out', done: mode === 'self' ? ['shipped', 'delivered'].includes(order.status) : Boolean(delivery && ['picked_up', 'out_for_delivery', 'delivered'].includes(delivery.status)), label: mode === 'self' ? 'Deliver it yourself' : 'Delivered by the NearBuy partner' },
      { key: 'done', done: order.status === 'delivered', label: 'Customer confirms receipt' },
    ],
    instructions: closed ? 'This order is closed.'
      : mode === 'self' ? 'Deliver this order yourself or through your own staff. The customer confirms with the 4-digit delivery code.'
        : 'A NearBuy delivery partner will collect the packed order and deliver it. Pickup and delivery are recorded in the partner app.',
  };
}

route('GET', '/api/seller/orders/:code/fulfilment', { perm: 'orders.read' }, (ctx) => {
  const order = sellerOrder(ctx);
  return { fulfilment: fulfilmentState(order, networkDelivery(order.id)) };
});

/** Switch between delivering yourself and using the NearBuy partner network. */
route('POST', '/api/seller/orders/:code/fulfilment', { perm: 'orders.write' }, (ctx) => {
  const data = validate(ctx.body, { mode: { required: true, enum: ['self', 'network'], label: 'Fulfilment' } });
  const actor = { type: 'seller', name: ctx.user.name, userId: ctx.user.id };
  return tx(() => {
    const order = sellerOrder(ctx);
    if (order.fulfilment === 'pickup') throw conflict('This order is a store pickup. The customer collects it from your shop.');
    if (['cancelled', 'delivered', 'shipped'].includes(order.status)) throw conflict('This order can no longer change its fulfilment.');
    let delivery = networkDelivery(order.id);
    if (delivery && delivery.partner_id) throw conflict('A delivery partner already has this order. Ask operations to reassign it if it cannot be delivered.');
    if (data.mode === 'self') {
      if (delivery) {
        E().cancelDelivery(delivery, actor, 'The seller chose to deliver this order on their own.');
        delivery = null;
      }
      const codeExp = new Date(Date.now() + C().CONFIG.codeTtlMs()).toISOString();
      run("UPDATE orders SET delivery_mode = 'self', collection_code = COALESCE(collection_code, ?), collection_code_expires_at = COALESCE(collection_code_expires_at, ?), updated_at = ? WHERE id = ?", C().newCode(4), codeExp, nowIso(), order.id);
      if (order.customer_order_id) {
        const parent = get('SELECT * FROM customer_orders WHERE id = ?', order.customer_order_id);
        if (parent) {
          require('./customer').notifyCustomerUser(parent.user_id, 'order', 'Your shop will deliver this order',
            'The shop is delivering your order directly. Share your 4-digit delivery code on handover.', `/customer/#/orders/${parent.code}`);
          C().publish(`customer:${parent.user_id}`, { kind: 'order', order_code: parent.code });
        }
      }
    } else {
      if (!delivery) {
        const created = E().ensureDelivery({ ...order, delivery_mode: 'network' }, { strict: true });
        delivery = created;
      }
      run("UPDATE orders SET delivery_mode = 'network', updated_at = ? WHERE id = ?", nowIso(), order.id);
    }
    C().audit(actor, 'Changed delivery method', 'order', order.code, data.mode === 'self' ? 'Seller delivers it themselves' : 'NearBuy partner network');
    C().publish([`seller:${ctx.sellerId}`, 'admin'], { kind: 'order', code: order.code });
    const fresh = get('SELECT * FROM orders WHERE id = ?', order.id);
    return { ok: true, fulfilment: fulfilmentState(fresh, networkDelivery(order.id)) };
  });
});

/** Self delivery: seller marks the packed order out for delivery directly. */
route('POST', '/api/seller/orders/:code/self-dispatch', { perm: 'orders.write' }, (ctx) => tx(() => {
  const order = sellerOrder(ctx);
  if (order.fulfilment === 'pickup') throw conflict('This is a store pickup order.');
  if (order.delivery_mode !== 'self') throw conflict('Switch to self-delivery before dispatching directly.');
  if (['delivered', 'cancelled', 'shipped'].includes(order.status)) throw conflict(`Order is already ${order.status}.`);
  if (!['processing', 'packed', 'ready_to_ship'].includes(order.status)) throw conflict('Accept and pack the order before dispatching.');
  if (order.stock_state === 'reserved') deductOrderStock(ctx.sellerId, order, ctx.user.name);
  run("UPDATE orders SET status = 'shipped', updated_at = ? WHERE id = ?", nowIso(), order.id);
  run("INSERT INTO order_events (seller_id, order_id, status, title, note, actor, created_at) VALUES (?, ?, 'shipped', 'Out for delivery (shop staff)', ?, ?, ?)",
    ctx.sellerId, order.id, 'Seller is delivering this order directly.', ctx.user.name, nowIso());
  C().notifyCustomerForOrder(order, 'delivery', `Out for delivery: ${order.code}`, 'The shop is on the way with your order. Keep your 4-digit delivery code ready.');
  C().syncCustomerOrderStatus(order.customer_order_id);
  C().publish([`seller:${ctx.sellerId}`, 'admin'], { kind: 'order', code: order.code, status: 'shipped' });
  return { ok: true, message: `Order ${order.code} marked out for delivery.`, order: { code: order.code, status: 'shipped' } };
}));

/** Store pickup: the customer shows the collection code, the seller hands the package over. */
route('POST', '/api/seller/orders/:code/collect', { perm: 'orders.write' }, (ctx) => {
  const data = validate(ctx.body, { code: { required: true, min: 4, max: 8, label: 'Collection code' } });
  return tx(() => {
    const order = sellerOrder(ctx);
    if (order.fulfilment !== 'pickup') throw conflict('This order is not a store pickup.');
    if (order.status === 'delivered') throw conflict('This order has already been collected.');
    if (order.status === 'cancelled') throw conflict('This order was cancelled.');
    if (!['packed', 'ready_to_ship'].includes(order.status)) throw conflict('Pack the order and mark it ready before handing it over.');
    verifyOrderCode(order, data.code, 'collection');
    // Deduct reserved inventory cleanly on pickup handover (if not already deducted).
    if (order.stock_state === 'reserved') deductOrderStock(ctx.sellerId, order, ctx.user.name);
    run("UPDATE orders SET status = 'delivered', delivered_at = ?, payment_status = CASE WHEN payment_status = 'cod_pending' THEN 'cod_collected' ELSE payment_status END, updated_at = ? WHERE id = ?", nowIso(), nowIso(), order.id);
    run("INSERT INTO order_events (seller_id, order_id, status, title, note, actor, created_at) VALUES (?, ?, 'delivered', 'Collected from the shop', ?, ?, ?)",
      ctx.sellerId, order.id, `Collection code verified at the counter by ${ctx.user.name}.`, ctx.user.name, nowIso());
    require('../ledger').recordSale(ctx.sellerId, { ...order, status: 'delivered' });
    C().syncCustomerOrderStatus(order.customer_order_id);
    C().notifyCustomerForOrder(order, 'order', `Collected: ${order.code}`, 'Thanks for collecting your order from the shop.');
    C().publish([`seller:${ctx.sellerId}`, 'admin'], { kind: 'order', code: order.code, status: 'delivered' });
    return { ok: true, message: `Order ${order.code} collected.`, order: { code: order.code, status: 'delivered' } };
  });
});

/** Self delivery: the customer reads their delivery code to the seller's staff. */
route('POST', '/api/seller/orders/:code/self-delivered', { perm: 'orders.write' }, (ctx) => {
  const data = validate(ctx.body, { code: { required: true, min: 4, max: 8, label: 'Delivery code' } });
  return tx(() => {
    const order = sellerOrder(ctx);
    if (order.fulfilment === 'pickup') throw conflict('This is a store pickup order.');
    if (order.delivery_mode !== 'self') throw conflict('This order is delivered by the NearBuy partner network.');
    if (order.status === 'delivered') throw conflict('This order has already been delivered.');
    if (order.status === 'cancelled') throw conflict('This order was cancelled.');
    if (!['shipped', 'ready_to_ship', 'packed'].includes(order.status)) throw conflict('Pack the order and start the delivery before recording the hand-over.');
    verifyOrderCode(order, data.code, 'delivery');
    if (order.stock_state === 'reserved') deductOrderStock(ctx.sellerId, order, ctx.user.name);
    run("UPDATE orders SET status = 'delivered', delivered_at = ?, payment_status = CASE WHEN payment_status = 'cod_pending' THEN 'cod_collected' ELSE payment_status END, updated_at = ? WHERE id = ?", nowIso(), nowIso(), order.id);
    run("INSERT INTO order_events (seller_id, order_id, status, title, note, actor, created_at) VALUES (?, ?, 'delivered', 'Delivered by the shop', ?, ?, ?)",
      ctx.sellerId, order.id, 'Customer confirmed receipt with the delivery code.', ctx.user.name, nowIso());
    require('../ledger').recordSale(ctx.sellerId, { ...order, status: 'delivered' });
    C().syncCustomerOrderStatus(order.customer_order_id);
    C().notifyCustomerForOrder(order, 'delivery', `Delivered: ${order.code}`, 'Your order was delivered by the shop and verified with your delivery code.');
    C().publish([`seller:${ctx.sellerId}`, 'admin'], { kind: 'order', code: order.code, status: 'delivered' });
    return { ok: true, message: `Order ${order.code} delivered.`, order: { code: order.code, status: 'delivered' } };
  });
});

module.exports = { fulfilmentState };
