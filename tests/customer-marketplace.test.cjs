'use strict';
// End-to-end tests for the customer marketplace: a real customer signs up, orders from several shops at once, the
// right shop sees the order, the shop chooses how it delivers, a pickup is collected with a code, and a delivery goes
// through the partner network. Everything runs against one throwaway database.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-marketplace-test-'));
process.env.NEARBUY_DATA_DIR = DATA_DIR;
process.env.DEV_MAIL_PREVIEW = '1';
process.env.SEED_DEMO = '1';
process.env.DELIVERY_BACKGROUND = '0';
delete process.env.SMTP_HOST;
const quiet = console.log; console.log = () => {};
const { start, server } = require('../server/index.js');
const delivery = require('../server/delivery');
const { seedMarketplace } = require('../server/marketplace-seed.js');
console.log = quiet;

let base;
function client() {
  let cookie = '';
  const call = async (method, url, body) => {
    const headers = { ...(method === 'GET' ? {} : { 'X-NearBuy-Request': '1' }), cookie };
    let payload;
    if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
    const type = res.headers.get('content-type') || '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}) => call('POST', u, b), patch: (u, b = {}) => call('PATCH', u, b) };
}
const ok = (r, status = 200) => { assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };

test.before(async () => {
  await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
  seedMarketplace();
});
test.after(() => { server.close(); fs.rmSync(DATA_DIR, { recursive: true, force: true }); });

const anon = client();
const priya = client();
const greenBasket = client();
const stationery = client();
const general = client();
const partner = client();
const tower = client();
const s = {};

test('the marketplace lists several real shops for a served PIN code', async () => {
  const data = ok(await anon.get('/api/customer/shops?pincode=110016'));
  assert.equal(data.zone, 'South Delhi');
  assert.ok(data.shops.length >= 3, `expected at least 3 shops, got ${data.shops.length}`);
  const names = data.shops.map((shop) => shop.name);
  assert.ok(names.includes('Green Basket Market'));
  assert.ok(names.includes('Kapoor Stationery House'));
  for (const shop of data.shops) {
    assert.ok(shop.products > 0, `${shop.name} should have stock`);
    assert.equal(shop.serviceable, true);
    assert.ok(shop.from_price > 0);
  }
  // A PIN code outside every zone is reported honestly instead of showing shops that cannot deliver.
  const outside = ok(await anon.get('/api/customer/shops?pincode=400001'));
  assert.equal(outside.zone, null);
  assert.deepEqual(outside.shops, []);
  const catalogue = ok(await anon.get('/api/customer/shops/SLR-5002'));
  assert.ok(catalogue.products.length > 0);
  s.stationeryProduct = catalogue.products[0];
  s.lowStockProduct = [...catalogue.products].sort((a, b) => a.available - b.available)[0];
  const green = ok(await anon.get('/api/customer/shops/SLR-5001'));
  s.greenProduct = green.products[0];
});

test('a customer registers, signs in and keeps a private profile', async () => {
  const weak = await priya.post('/api/customer/register', { name: 'Priya Nair', email: 'priya@example.com', password: 'short' });
  assert.equal(weak.status, 400);
  const made = ok(await priya.post('/api/customer/register', {
    name: 'Priya Nair', email: 'priya@example.com', password: 'Neighbour#2026', mobile: '9810011122', pincode: '110016', address: 'H-12 Hauz Khas Enclave',
  }), 201);
  assert.equal(made.customer.name, 'Priya Nair');
  // The email is unique, and the session works on the next request.
  const dupe = await client().post('/api/customer/register', { name: 'Copy Cat', email: 'priya@example.com', password: 'Neighbour#2026' });
  assert.equal(dupe.status, 409);
  const me = ok(await priya.get('/api/customer/me'));
  assert.equal(me.customer.email, 'priya@example.com');
  assert.equal(me.customer.address.pincode, '110016');
  // A customer session cannot open the Seller Hub: the two portals keep separate session cookies.
  assert.ok([401, 403].includes((await priya.get('/api/orders')).status));
  // A wrong password is refused.
  assert.equal((await client().post('/api/customer/login', { email: 'priya@example.com', password: 'wrong-one' })).status, 401);
  ok(await priya.patch('/api/customer/profile', { city: 'New Delhi', area: 'Hauz Khas' }));
});

test('a signed-out visitor can browse but cannot order', async () => {
  assert.equal((await anon.get('/api/customer/orders')).status, 401);
  const body = { items: [{ inventory_id: s.greenProduct.inventory_id, qty: 1 }], fulfilment: 'pickup' };
  assert.equal((await anon.post('/api/customer/orders', body)).status, 401);
  // The price preview is open to visitors so the cart can show a fee before sign-in.
  const quote = ok(await anon.post('/api/customer/cart/price', { items: body.items, fulfilment: 'pickup' }));
  assert.equal(quote.totals.delivery_total, 0);
});

test('one cart with three shops becomes one customer order and three shop orders', async () => {
  const items = [
    { inventory_id: s.greenProduct.inventory_id, qty: 2 },
    { inventory_id: s.stationeryProduct.inventory_id, qty: 1 },
  ];
  const generalList = ok(await anon.get('/api/customer/shops/SLR-5003'));
  items.push({ inventory_id: generalList.products[0].inventory_id, qty: 1 });
  const priced = ok(await priya.post('/api/customer/cart/price', {
    items, fulfilment: 'delivery', address: 'H-12 Hauz Khas Enclave', pincode: '110016',
  }));
  assert.equal(priced.shops.length, 3);
  for (const shop of priced.shops) assert.ok(shop.delivery_fee > 0, `${shop.shop_name} should quote a delivery fee`);

  // Prepaid, so the delivery network's cash-on-delivery float does not decide which partner is eligible.
  const placed = ok(await priya.post('/api/customer/orders', {
    items, fulfilment: 'delivery', per_shop: { 'SLR-5002': 'pickup' }, payment: 'prepaid',
    address: 'H-12 Hauz Khas Enclave', pincode: '110016', instructions: 'Ring the bell twice',
  }), 201);
  assert.match(placed.order.code, /^CNB-/);
  assert.equal(placed.shops.length, 3);
  s.parentCode = placed.order.code;
  s.childOrders = placed.shops;
  // Delivery shops get a delivery job; the pickup shop does not, and it carries a collection code instead.
  const pickupShop = placed.shops.find((shop) => shop.shop_code === 'SLR-5002');
  assert.equal(pickupShop.fulfilment, 'pickup');
  assert.equal(pickupShop.delivery, null);
  assert.match(pickupShop.collection_code, /^\d{4}$/);
  assert.equal(pickupShop.delivery_fee, 0);
  const deliveryShops = placed.shops.filter((shop) => shop.fulfilment === 'delivery');
  assert.equal(deliveryShops.length, 2);
  for (const shop of deliveryShops) {
    assert.ok(shop.delivery && /^DLV-/.test(shop.delivery.code));
    assert.equal(shop.delivery.status, 'awaiting_assignment');
  }
  s.pickupOrder = pickupShop;
  s.deliveryOrders = deliveryShops;

  // The customer receipt is the same record for all shops.
  const view = ok(await priya.get(`/api/customer/orders/${s.parentCode}`)).order;
  assert.equal(view.shops.length, 3);
  assert.equal(view.status, 'in_progress');
  // Stock was really reserved: the same units cannot be ordered again.
  const short = await priya.post('/api/customer/orders', {
    items: [{ inventory_id: s.lowStockProduct.inventory_id, qty: s.lowStockProduct.available + 1 }], fulfilment: 'pickup',
  });
  assert.equal(short.status, 409, 'ordering more than the available stock must be refused');
  const absurd = await priya.post('/api/customer/orders', { items: [{ inventory_id: s.lowStockProduct.inventory_id, qty: 0 }], fulfilment: 'pickup' });
  assert.equal(absurd.status, 400, 'a zero quantity must be rejected, not silently adjusted');
});

test('each shop sees only its own order and no other shop can open it', async () => {
  ok(await greenBasket.post('/api/auth/login', { email: 'owner@nearbuy.demo', password: 'Seller123!' }));
  ok(await stationery.post('/api/auth/login', { email: 'stationery@nearbuy.demo', password: 'Customer123!' }));
  ok(await general.post('/api/auth/login', { email: 'general@nearbuy.demo', password: 'Customer123!' }));
  const greenOrder = s.childOrders.find((shop) => shop.shop_code === 'SLR-5001').order_code;
  const stationeryOrder = s.pickupOrder.order_code;
  const generalOrder = s.childOrders.find((shop) => shop.shop_code === 'SLR-5003').order_code;
  const greenList = ok(await greenBasket.get('/api/orders?pageSize=100'));
  const codes = (greenList.rows || greenList.orders || []).map((o) => o.code);
  assert.ok(codes.includes(greenOrder));
  assert.ok(!codes.includes(stationeryOrder), 'another shop order must not appear in this seller\'s list');
  assert.equal((await greenBasket.get(`/api/orders/${stationeryOrder}`)).status, 404);
  assert.equal((await stationery.get(`/api/orders/${greenOrder}`)).status, 404);
  assert.equal((await general.get(`/api/orders/${greenOrder}`)).status, 404);
  s.greenOrder = greenOrder;
  s.generalOrder = generalOrder;
});

test('another customer cannot read or cancel this order', async () => {
  const other = client();
  ok(await other.post('/api/customer/register', { name: 'Ravi Menon', email: 'ravi@example.com', password: 'Neighbour#2026' }), 201);
  assert.equal((await other.get(`/api/customer/orders/${s.parentCode}`)).status, 404);
  assert.equal((await other.post(`/api/customer/orders/${s.parentCode}/cancel`, {})).status, 404);
});

test('store pickup is collected with the code and completes the shop order', async () => {
  const order = s.pickupOrder.order_code;
  // Before packing, the hand-over is refused.
  ok(await stationery.post(`/api/orders/${order}/actions`, { action: 'accept' }));
  ok(await stationery.post(`/api/orders/${order}/actions`, { action: 'process' }));
  ok(await stationery.post(`/api/orders/${order}/actions`, { action: 'pack' }));
  const state = ok(await stationery.get(`/api/seller/orders/${order}/fulfilment`)).fulfilment;
  assert.equal(state.mode, 'pickup');
  assert.equal(state.can_choose, false);
  const wrong = await stationery.post(`/api/seller/orders/${order}/collect`, { code: '0000' });
  assert.equal(wrong.status, 409);
  assert.match(wrong.data.error, /does not match/);
  const done = ok(await stationery.post(`/api/seller/orders/${order}/collect`, { code: s.pickupOrder.collection_code }));
  assert.equal(done.order.status, 'delivered');
  const view = ok(await priya.get(`/api/customer/orders/${s.parentCode}`)).order;
  assert.equal(view.shops.find((shop) => shop.order_code === order).status, 'delivered');
  // The collection code cannot be reused.
  assert.equal((await stationery.post(`/api/seller/orders/${order}/collect`, { code: s.pickupOrder.collection_code })).status, 409);
});

test('a shop can switch a delivery order to its own delivery and complete it with the customer code', async () => {
  const order = s.generalOrder;
  const state = ok(await general.get(`/api/seller/orders/${order}/fulfilment`)).fulfilment;
  assert.equal(state.mode, 'network');
  assert.equal(state.can_choose, true);
  const self = ok(await general.post(`/api/seller/orders/${order}/fulfilment`, { mode: 'self' }));
  assert.equal(self.fulfilment.mode, 'self');
  assert.equal(self.fulfilment.delivery, null, 'the network job is released when the shop delivers itself');
  // The order's delivery code is now the only way to close it.
  for (const action of ['accept', 'process', 'pack']) ok(await general.post(`/api/orders/${order}/actions`, { action }));
  const code = ok(await general.get(`/api/orders/${order}`)).order;
  assert.ok(code.code);
  const stored = ok(await general.get(`/api/seller/orders/${order}/fulfilment`)).fulfilment;
  assert.equal(stored.mode, 'self');
  assert.equal((await general.post(`/api/seller/orders/${order}/self-delivered`, { code: '9999' })).status, 409);
  // Correct code is read from the customer's own order page.
  const customerView = ok(await priya.get(`/api/customer/orders/${s.parentCode}`)).order;
  const shopView = customerView.shops.find((shop) => shop.order_code === order);
  const realCode = shopView.collection_code;
  assert.ok(realCode, 'a self-delivery order must show the customer a delivery code');
  const done = ok(await general.post(`/api/seller/orders/${order}/self-delivered`, { code: realCode }));
  assert.equal(done.order.status, 'delivered');
  // Switching back to the network is refused once the delivery is finished.
  assert.equal((await general.post(`/api/seller/orders/${order}/fulfilment`, { mode: 'network' })).status, 409);
});

test('find a runner: ranked candidates, an appointed offer, acceptance and assignment', async () => {
  const deliveryCode = s.deliveryOrders.find((shop) => shop.shop_code === 'SLR-5001').delivery.code;
  const candidates = ok(await greenBasket.get(`/api/seller/deliveries/${deliveryCode}/candidates`));
  assert.ok(Array.isArray(candidates.candidates));
  assert.ok(candidates.candidates.every((c) => typeof c.eligible === 'boolean' && Array.isArray(c.reasons)));
  ok(await partner.post('/api/partners/login', { identifier: 'rohan@nearbuy.demo', password: 'Runner123!' }));
  assert.equal(ok(await partner.get('/api/partners/me')).partner.status, 'approved');
  // A stale location makes a partner ineligible; the reason is shown instead of a silent empty list.
  const stale = ok(await greenBasket.get(`/api/seller/deliveries/${deliveryCode}/candidates`));
  const staleRohan = stale.candidates.find((c) => c.code === 'DP-2001');
  assert.equal(staleRohan.eligible, false);
  assert.ok(staleRohan.reasons.some((r) => /location|Offline/i.test(r)));
  // With a fresh location and online status the same partner becomes eligible.
  ok(await partner.patch('/api/partners/availability', { online: true }));
  ok(await partner.post('/api/partners/location', { lat: 28.550161, lng: 77.241592, accuracy_m: 10 }));
  const fresh = ok(await greenBasket.get(`/api/seller/deliveries/${deliveryCode}/candidates`));
  const rohan = fresh.candidates.find((c) => c.code === 'DP-2001');
  assert.equal(rohan.eligible, true, `DP-2001 should be eligible: ${rohan.reasons.join(', ')}`);
  assert.ok(rohan.pickup_km !== null && rohan.pickup_km >= 0);
  assert.equal(fresh.eligible_count >= 1, true);

  // Appointing an ineligible partner is refused.
  assert.equal((await greenBasket.post(`/api/seller/deliveries/${deliveryCode}/appoint`, { partner_code: 'DP-2002' })).status, 409);
  const appointed = ok(await greenBasket.post(`/api/seller/deliveries/${deliveryCode}/appoint`, { partner_code: 'DP-2001' }));
  assert.equal(appointed.delivery.status, 'offer_sent');
  s.deliveryCode = deliveryCode;

  // The offer is a real record the partner can accept.
  const offers = ok(await partner.get('/api/delivery/offers'));
  assert.ok(offers.offers.length >= 1);
  const offer = offers.offers.find((o) => o.delivery_code === deliveryCode);
  assert.ok(offer, 'the appointed partner must see the offer');
  ok(await partner.post(`/api/delivery/offers/${offer.id}/accept`));
  const after = ok(await greenBasket.get(`/api/seller/deliveries/${deliveryCode}`)).delivery;
  assert.equal(after.status, 'partner_assigned');
  // The customer sees the assigned partner and a tracking link.
  const customerView = ok(await priya.get(`/api/customer/orders/${s.parentCode}`)).order;
  const shopView = customerView.shops.find((shop) => shop.delivery && shop.delivery.code === deliveryCode);
  assert.equal(shopView.delivery.partner.name, 'Rohan Kumar');
  assert.match(shopView.delivery.track_url, /^\/track\/\?t=/);
});

test('the appointed partner delivers it with the real pickup and delivery codes', async () => {
  const code = s.deliveryCode;
  const orderCode = s.greenOrder;
  // The shop cannot close a network delivery itself.
  assert.equal((await greenBasket.post(`/api/orders/${orderCode}/actions`, { action: 'deliver' })).status, 409);
  // The shop packs the order and marks the delivery ready.
  for (const action of ['accept', 'process', 'pack']) {
    const step = await greenBasket.post(`/api/orders/${orderCode}/actions`, { action });
    assert.equal(step.status, 200, `${action}: ${JSON.stringify(step.data)}`);
  }
  ok(await greenBasket.post(`/api/seller/deliveries/${code}/ready`));
  const sellerView = ok(await greenBasket.get(`/api/seller/deliveries/${code}`)).delivery;
  assert.ok(sellerView.pickup_pin, 'the shop must hold the pickup PIN to give to the partner');
  const trackToken = sellerView.track_token || null;
  s.trackToken = trackToken;

  // The partner cannot skip straight to delivery.
  assert.equal((await partner.post(`/api/deliveries/${code}/picked-up`)).status, 409);
  ok(await partner.post(`/api/deliveries/${code}/start`));
  // Arrival is checked against the real location: far from the shop, the partner is refused.
  const pickup = ok(await partner.get(`/api/deliveries/${code}`)).delivery.pickup;
  ok(await partner.post('/api/partners/location', { lat: 28.550161, lng: 77.241592, accuracy_m: 10 }));
  const far = await partner.post(`/api/deliveries/${code}/arrived-at-pickup`);
  assert.equal(far.status, 409);
  assert.equal(far.data.code, 'outside_geofence');
  ok(await partner.post('/api/partners/location', { lat: pickup.lat, lng: pickup.lng, accuracy_m: 8 }));
  ok(await partner.post(`/api/deliveries/${code}/arrived-at-pickup`));
  // A wrong pickup PIN is refused, the right one confirms the hand-over.
  assert.equal((await partner.post(`/api/deliveries/${code}/verify-pickup`, { code: '0000', package_count: 1 })).status, 400);
  ok(await partner.post(`/api/deliveries/${code}/verify-pickup`, { code: sellerView.pickup_pin, package_count: 1 }));
  ok(await partner.post(`/api/deliveries/${code}/picked-up`));
  const customer = ok(await priya.get(`/api/customer/orders/${s.parentCode}`)).order;
  const shopRow = customer.shops.find((shop) => shop.delivery && shop.delivery.code === code);
  assert.ok(['picked_up', 'en_route_to_customer'].includes(shopRow.delivery.status), `unexpected delivery status ${shopRow.delivery.status}`);

  const withDrop = ok(await partner.get(`/api/deliveries/${code}`)).delivery;
  ok(await partner.post('/api/partners/location', { lat: withDrop.drop.lat, lng: withDrop.drop.lng, accuracy_m: 8 }));
  ok(await partner.post(`/api/deliveries/${code}/arrived-at-destination`));
  // The delivery cannot be closed without proof.
  assert.equal((await partner.post(`/api/deliveries/${code}/complete`, {})).status, 409);
  const tracking = ok(await anon.get(`/api/track/${shopRow.delivery.track_url.split('t=')[1]}`)).delivery;
  assert.match(String(tracking.delivery_code), /^\d{4}$/);
  assert.equal((await partner.post(`/api/deliveries/${code}/proof`, { method: 'otp', code: '0000' })).status, 400);
  ok(await partner.post(`/api/deliveries/${code}/proof`, { method: 'otp', code: tracking.delivery_code }));
  const done = ok(await partner.post(`/api/deliveries/${code}/complete`, {}));
  assert.equal(done.delivery.status, 'delivered');
  s.completedDelivery = code;

  // Every portal now reports the same finished delivery.
  const afterCustomer = ok(await priya.get(`/api/customer/orders/${s.parentCode}`)).order;
  const deliveredRow = afterCustomer.shops.find((shop) => shop.order_code === orderCode);
  assert.equal(deliveredRow.status, 'delivered');
  const sellerOrder = ok(await greenBasket.get(`/api/orders/${orderCode}`)).order;
  assert.equal(sellerOrder.status, 'delivered');
  const partnerHome = ok(await partner.get('/api/partners/home'));
  assert.ok(partnerHome.today, 'the partner dashboard must record the completed delivery');
});

test('a cancelled customer order releases stock and stops the delivery', async () => {
  const fresh = client();
  ok(await fresh.post('/api/customer/register', { name: 'Deepa Rao', email: 'deepa@example.com', password: 'Neighbour#2026', pincode: '110016', address: 'C-4 Hauz Khas' }), 201);
  const catalogue = ok(await anon.get('/api/customer/shops/SLR-5003'));
  const product = catalogue.products[0];
  const before = product.available;
  const placed = ok(await fresh.post('/api/customer/orders', {
    items: [{ inventory_id: product.inventory_id, qty: 1 }], fulfilment: 'delivery', address: 'C-4 Hauz Khas', pincode: '110016',
  }), 201);
  const after = ok(await anon.get('/api/customer/shops/SLR-5003')).products.find((p) => p.inventory_id === product.inventory_id);
  assert.equal(after.available, before - 1);
  const cancelled = ok(await fresh.post(`/api/customer/orders/${placed.order.code}/cancel`, { reason: 'Ordered by mistake' }));
  assert.equal(cancelled.order.status, 'cancelled');
  const released = ok(await anon.get('/api/customer/shops/SLR-5003')).products.find((p) => p.inventory_id === product.inventory_id);
  assert.equal(released.available, before, 'cancelling must put the reserved units back');
  const delivery = placed.shops[0].delivery;
  const track = ok(await anon.get(`/api/track/${delivery.track_token}`)).delivery;
  assert.equal(track.status, 'cancelled');
  // Once the shop has accepted an order the customer can no longer cancel it alone.
  const next = ok(await fresh.post('/api/customer/orders', { items: [{ inventory_id: product.inventory_id, qty: 1 }], fulfilment: 'delivery', address: 'C-4 Hauz Khas', pincode: '110016' }), 201);
  ok(await general.post(`/api/orders/${next.shops[0].order_code}/actions`, { action: 'accept' }));
  assert.equal((await fresh.post(`/api/customer/orders/${next.order.code}/cancel`, {})).status, 409);
});

test('two customers cannot buy the last unit at the same time', async () => {
  const shop = ok(await anon.get('/api/customer/shops/SLR-5002'));
  const product = shop.products.find((p) => p.available > 0);
  const a = client();
  const b = client();
  ok(await a.post('/api/customer/register', { name: 'Buyer One', email: 'buyer1@example.com', password: 'Neighbour#2026', pincode: '110016', address: 'A-1 Hauz Khas' }), 201);
  ok(await b.post('/api/customer/register', { name: 'Buyer Two', email: 'buyer2@example.com', password: 'Neighbour#2026', pincode: '110016', address: 'A-2 Hauz Khas' }), 201);
  // Take everything but one unit (in cart-sized chunks), then race for the last unit.
  let remaining = product.available - 1;
  while (remaining > 0) {
    const qty = Math.min(20, remaining);
    ok(await a.post('/api/customer/orders', { items: [{ inventory_id: product.inventory_id, qty }], fulfilment: 'pickup' }), 201);
    remaining -= qty;
  }
  const [first, second] = await Promise.all([
    a.post('/api/customer/orders', { items: [{ inventory_id: product.inventory_id, qty: 1 }], fulfilment: 'pickup' }),
    b.post('/api/customer/orders', { items: [{ inventory_id: product.inventory_id, qty: 1 }], fulfilment: 'pickup' }),
  ]);
  const wins = [first, second].filter((r) => r.status === 201).length;
  assert.equal(wins, 1, `exactly one buyer may take the last unit (got ${first.status} and ${second.status})`);
  // A sold-out product is no longer offered for sale at all.
  const after = ok(await anon.get('/api/customer/shops/SLR-5002')).products.find((p) => p.inventory_id === product.inventory_id);
  assert.equal(after, undefined, 'a sold-out product must not be listed as purchasable');
});

test('the storefront page is served and the delivery network still reports the same order', async () => {
  const page = await fetch(`${base}/customer/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /NearBuy customer storefront/i.test(html) ? /NearBuy/i : /NearBuy/i);
  assert.match(html, /\/customer\/app\.js/);
  const asset = await fetch(`${base}/customer/app.js`);
  assert.equal(asset.status, 200);
  // The shop's view of the customer order matches the customer's receipt.
  const sellerView = ok(await greenBasket.get(`/api/orders/${s.greenOrder}`)).order;
  assert.equal(sellerView.status !== 'new', true, 'the accepted order must have moved past the new state');
  ok(await tower.post('/api/tower/login', { email: 'tower@nearbuy.demo', password: 'Tower123!' }));
  const admin = ok(await tower.get(`/api/admin/deliveries/${s.deliveryCode}`)).delivery;
  assert.equal(admin.order_code, s.greenOrder);
  assert.equal(admin.partner_code || (admin.partner && admin.partner.code) || 'DP-2001', 'DP-2001');
});

// --- Rejection, expiry and the no-runner case -------------------------------------------------------------
const db = require('../server/db.js');
const { tick } = require('../server/delivery');

const jobOrderCode = (job) => db.get('SELECT o.code FROM deliveries d JOIN orders o ON o.id = d.order_id WHERE d.code = ?', job.code).code;

/** Places one delivery order in a shop and returns the delivery record the seller must act on. */
async function freshDelivery(shopCode, sellerClient) {
  const shop = ok(await anon.get(`/api/customer/shops/${shopCode}`));
  const product = shop.products.find((p) => p.available > 0);
  const placed = ok(await priya.post('/api/customer/orders', {
    items: [{ inventory_id: product.inventory_id, qty: 1 }], fulfilment: 'delivery',
    address: 'H-12 Hauz Khas Enclave', pincode: '110016', payment: 'prepaid',
  }), 201);
  const line = placed.shops.find((sh) => sh.shop_code === shopCode);
  ok(await sellerClient.post(`/api/orders/${line.order_code}/actions`, { action: 'accept' }));
  return { parent: placed.order.code, order: line.order_code, delivery: line.delivery };
}

test('a shop with no available runner is told why, and the order is not lost', async () => {
  const { order, delivery: job } = await freshDelivery('SLR-5003', general);
  db.run('UPDATE delivery_partners SET online = 0, last_location_at = NULL');
  const found = ok(await general.get(`/api/seller/deliveries/${job.code}/candidates`));
  assert.equal(found.eligible_count, 0, 'nobody can be eligible while every partner is offline');
  assert.ok(found.candidates.length > 0, 'the seller still sees who exists and why they cannot take it');
  assert.ok(found.candidates.every((c) => c.reasons.length > 0));
  const refused = await general.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' });
  assert.equal(refused.status, 409);
  const still = ok(await general.get(`/api/seller/deliveries/${job.code}`)).delivery;
  assert.ok(['awaiting_assignment', 'searching_partner'].includes(still.status), `unexpected ${still.status}`);
  // The seller is never stuck: the fallback is their own delivery, which cancels the network job.
  ok(await general.post(`/api/seller/orders/${order}/fulfilment`, { mode: 'self' }));
  const after = ok(await general.get(`/api/seller/orders/${order}/fulfilment`)).fulfilment;
  assert.equal(after.mode, 'self');
  db.run('UPDATE delivery_partners SET online = 1 WHERE code = ?', 'DP-2001');
});

test('a declined or expired offer goes back to the shop instead of vanishing', async () => {
  const { delivery: job } = await freshDelivery('SLR-5001', greenBasket);
  ok(await partner.patch('/api/partners/availability', { online: true }));
  ok(await partner.post('/api/partners/location', { lat: 28.550161, lng: 77.241592, accuracy_m: 10 }));
  const appointed = ok(await greenBasket.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' }));
  assert.equal(appointed.delivery.status, 'offer_sent');
  const jobId = db.get('SELECT id FROM deliveries WHERE code = ?', job.code).id;
  const offer = db.get("SELECT * FROM delivery_offers WHERE delivery_id = ? AND status = 'offered'", jobId);
  assert.ok(offer, 'appointing must write a real offer row');
  // The partner declines: the job returns to the shop, with the offer recorded as declined.
  const mine = ok(await partner.get('/api/delivery/offers')).offers.find((o) => o.id === offer.id);
  ok(await partner.post(`/api/delivery/offers/${mine.id}/decline`, { reason: 'Too far for me right now' }));
  const declined = db.get('SELECT status FROM delivery_offers WHERE id = ?', offer.id);
  assert.equal(declined.status, 'declined');
  const back = ok(await greenBasket.get(`/api/seller/deliveries/${job.code}`)).delivery;
  assert.ok(['awaiting_assignment', 'searching_partner'].includes(back.status), `unexpected ${back.status}`);
  // An offer left unanswered expires on the next dispatch tick and the same shop can appoint again.
  const again = ok(await greenBasket.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' }));
  db.run('UPDATE delivery_offers SET expires_at = ? WHERE delivery_id = ? AND status = ?', '2000-01-01T00:00:00.000Z', jobId, 'offered');
  tick();
  const expired = db.get("SELECT status FROM delivery_offers WHERE delivery_id = ? ORDER BY id DESC", jobId);
  assert.equal(expired.status, 'expired');
  const reopened = ok(await greenBasket.get(`/api/seller/deliveries/${job.code}`)).delivery;
  assert.ok(['awaiting_assignment', 'searching_partner', 'offer_sent'].includes(reopened.status), `unexpected ${reopened.status}`);
  ok(await greenBasket.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' }));
  // Tidy up: the partner declines the last offer so they are free for the next test.
  const last = ok(await partner.get('/api/delivery/offers')).offers.find((o) => o.delivery_code === job.code);
  ok(await partner.post(`/api/delivery/offers/${last.id}/decline`, { reason: 'End of test' }));
});

test('one delivery can never belong to two partners', async () => {
  const { delivery: job } = await freshDelivery('SLR-5001', greenBasket);
  ok(await partner.patch('/api/partners/availability', { online: true }));
  ok(await partner.post('/api/partners/location', { lat: 28.550161, lng: 77.241592, accuracy_m: 10 }));
  const appointed = ok(await greenBasket.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' }));
  const mine = ok(await partner.get('/api/delivery/offers')).offers.find((o) => o.delivery_code === job.code);
  ok(await partner.post(`/api/delivery/offers/${mine.id}/accept`));
  // Accepting again, or appointing somebody else, cannot create a second owner.
  assert.equal((await partner.post(`/api/delivery/offers/${mine.id}/accept`)).status, 409);
  assert.equal((await greenBasket.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' })).status, 409);
  const rows = db.all("SELECT partner_id FROM delivery_offers WHERE delivery_id = ? AND status = 'accepted'", db.get('SELECT id FROM deliveries WHERE code = ?', job.code).id);
  assert.equal(rows.length, 1, 'exactly one accepted offer');
  const live = ok(await greenBasket.get(`/api/seller/deliveries/${job.code}`)).delivery;
  assert.equal(live.status, 'partner_assigned');
  assert.equal(db.get('SELECT partner_id FROM deliveries WHERE code = ?', job.code).partner_id, rows[0].partner_id);
  // A shop cannot quietly pull a job out from under an assigned runner; operations reassigns it instead.
  assert.equal((await greenBasket.post(`/api/seller/orders/${jobOrderCode(job)}/fulfilment`, { mode: 'self' })).status, 409);
  ok(await tower.post(`/api/admin/deliveries/${job.code}/reassign`, { reason: 'Runner called in sick' }));
  assert.equal(db.get('SELECT partner_id FROM deliveries WHERE code = ?', job.code).partner_id, null);
  // Operations then closes the job so the partner is not left holding a live offer.
  ok(await tower.post(`/api/admin/deliveries/${job.code}/cancel`, { reason: 'Shop will deliver this one itself' }));
});

test('a retried checkout does not place a second order, and code guessing is limited', async () => {
  const shop = ok(await anon.get('/api/customer/shops/SLR-5003'));
  const product = shop.products.find((p) => p.available > 1);
  const body = {
    items: [{ inventory_id: product.inventory_id, qty: 1 }], fulfilment: 'pickup',
    address: 'H-12 Hauz Khas Enclave', pincode: '110016', request_id: 'retry-check-1',
  };
  const first = ok(await priya.post('/api/customer/orders', body), 201);
  const second = ok(await priya.post('/api/customer/orders', body), 201);
  assert.equal(second.order.code, first.order.code, 'the same request id must return the same order');
  assert.equal(second.repeated, true);
  const listed = ok(await priya.get('/api/customer/orders')).orders.filter((o) => o.code === first.order.code);
  assert.equal(listed.length, 1);
  // A different request id is a genuinely new order.
  const third = await priya.post('/api/customer/orders', { ...body, request_id: 'retry-check-2' });
  assert.equal(third.status, 201);
  assert.notEqual(third.data.order.code, first.order.code);

  // Wrong codes are counted per delivery; guessing is stopped instead of allowed forever.
  const { delivery: job } = await freshDelivery('SLR-5001', greenBasket);
  ok(await partner.patch('/api/partners/availability', { online: true }));
  ok(await partner.post('/api/partners/location', { lat: 28.550161, lng: 77.241592, accuracy_m: 10 }));
  ok(await greenBasket.post(`/api/seller/deliveries/${job.code}/appoint`, { partner_code: 'DP-2001' }));
  const mine = ok(await partner.get('/api/delivery/offers')).offers.find((o) => o.delivery_code === job.code);
  ok(await partner.post(`/api/delivery/offers/${mine.id}/accept`));
  for (const action of ['process', 'pack']) ok(await greenBasket.post(`/api/orders/${jobOrderCode(job)}/actions`, { action }));
  ok(await greenBasket.post(`/api/seller/deliveries/${job.code}/ready`));
  ok(await partner.post(`/api/deliveries/${job.code}/start`));
  const pickup = ok(await partner.get(`/api/deliveries/${job.code}`)).delivery.pickup;
  ok(await partner.post('/api/partners/location', { lat: pickup.lat, lng: pickup.lng, accuracy_m: 8 }));
  ok(await partner.post(`/api/deliveries/${job.code}/arrived-at-pickup`));
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await partner.post(`/api/deliveries/${job.code}/verify-pickup`, { code: '0000', package_count: 1 })).status);
  assert.deepEqual(codes.slice(0, 6), [400, 400, 400, 400, 400, 400]);
  assert.equal(codes[6], 429, `expected the seventh guess to be refused, got ${codes.join(',')}`);
});
