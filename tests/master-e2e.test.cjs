'use strict';
// Master End-to-End Verification Suite covering all 14 mandatory NearBuy ecosystem scenarios:
// 1. Customer -> Seller Order        8. No Runner Available
// 2. Seller Self-Delivery + OTP      9. Store Pickup Flow (₹0 + OTP + Stock Deduction)
// 3. Find a Runner Flow             10. Multi-Shop Checkout (mixed per_shop override)
// 4. Runner Acceptance              11. Concurrent Runner Acceptance
// 5. Pickup OTP Verification        12. Access Control, 18+ Age Gate & OTP Expiry
// 6. Delivery OTP Verification      13. Real Production Account Onboarding (No Demo Needed)
// 7. Runner Rejection & Re-appoint  14. Persistence Across Server Restart + Unified Admin Ops + Static Assets
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearbuy-master-e2e-'));
const dbFile = path.join(tmpDir, 'master.sqlite');
process.env.NEARBUY_DB_FILE = dbFile;
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.HOST = '127.0.0.1';
process.env.DELIVERY_OFFER_SECONDS = '45';

const { start } = require('../server/index');
const db = require('../server/db');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let srv;
let base;

function makeClient() {
  const jar = new Map();
  async function req(method, urlPath, body, extraHeaders = {}) {
    const headers = { 'X-NearBuy-Request': '1', ...extraHeaders };
    if (jar.size) headers.Cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (Buffer.isBuffer(body)) {
      headers['Content-Type'] = 'image/png';
      payload = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${urlPath}`, { method, headers, body: payload, redirect: 'manual' });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const pair = c.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const k = pair.slice(0, eq).trim();
        const v = pair.slice(eq + 1).trim();
        if (v) jar.set(k, v); else jar.delete(k);
      }
    }
    const text = await res.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, headers: res.headers, data, text };
  }
  return {
    get: (p) => req('GET', p),
    post: (p, b) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    patch: (p, b) => req('PATCH', p, b),
    del: (p) => req('DELETE', p),
  };
}
const ok = (r, expected = 200) => {
  assert.equal(r.status, expected, `Expected ${expected}, got ${r.status}: ${typeof r.data === 'string' ? r.data : JSON.stringify(r.data)}`);
  return r.data;
};

const anon = makeClient();
const customer = makeClient();
const seller1 = makeClient();
const seller2 = makeClient();
const runner1 = makeClient();
const runner2 = makeClient();
const admin = makeClient();

test.before(async () => {
  // Fresh DB start MUST automatically seed all 3 demo shops and customer without calling seedMarketplace manually.
  srv = await start();
  base = `http://127.0.0.1:${srv.address().port}`;
});
test.after(async () => {
  if (srv) await new Promise((resolve) => srv.close(resolve));
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

test('Scenario 14a: Static asset serving, redirects, and fresh-DB automatic seeding', async () => {
  const js = await anon.get('/customer/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  const css = await anon.get('/customer/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  const loginRedir = await anon.get('/customer/login');
  assert.equal(loginRedir.status, 302);
  assert.equal(loginRedir.headers.get('location'), '/customer/#/login');
  const adminPage = await anon.get('/admin/');
  assert.equal(adminPage.status, 200);
  assert.match(adminPage.text, /\/control-tower\//);

  // All 3 demo shops must be auto-seeded on fresh DB without any manual seedMarketplace() workaround!
  const shops = ok(await anon.get('/api/customer/shops?pincode=110016')).shops;
  assert.ok(shops.length >= 3, `Expected >=3 auto-seeded shops in 110016, got ${shops.length}`);
});

test('Scenario 1 & 10: Customer registers, searches/compares products, and places a multi-shop order with mixed per_shop override', async () => {
  ok(await customer.post('/api/customer/register', {
    name: 'Neha Kapoor', email: 'neha.e2e@example.com', password: 'Neighbour#2026', mobile: '9811223344',
    pincode: '110016', address: 'B-19 Green Park Main',
  }), 201);

  // Saved addresses CRUD
  const saved = ok(await customer.post('/api/customer/addresses', {
    label: 'Home', address: 'B-19 Green Park Main', area: 'Green Park', pincode: '110016', is_default: true,
  }), 201);
  assert.equal(saved.address.pincode, '110016');

  // Cross-shop search & product detail comparison
  const search = ok(await customer.get('/api/customer/products?pincode=110016&in_stock=1'));
  assert.ok(search.products.length >= 5);
  const firstProd = search.products[0];
  const detail = ok(await customer.get(`/api/customer/products/${firstProd.product_code}`));
  assert.equal(detail.product.code, firstProd.product_code);
  assert.ok(Array.isArray(detail.compare_offers));

  // Cart quote without address MUST still return shop items (fixing old empty-cart bug)
  const noAddrQuote = ok(await anon.post('/api/customer/cart/price', {
    items: [{ inventory_id: firstProd.inventory_id, qty: 1 }], fulfilment: 'delivery',
  }));
  assert.equal(noAddrQuote.needs_address, true);
  assert.equal(noAddrQuote.shops.length, 1);

  // Multi-shop cart: default = pickup, override SLR-5001 = delivery (tests pickup->delivery fee quote fix!)
  const s1 = ok(await customer.get('/api/customer/shops/SLR-5001'));
  const s2 = ok(await customer.get('/api/customer/shops/SLR-5002'));
  const p1 = s1.products[0];
  const p2 = s2.products[0];
  const inv1Before = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p1.inventory_id);
  const inv2Before = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p2.inventory_id);

  const priced = ok(await customer.post('/api/customer/cart/price', {
    items: [{ inventory_id: p1.inventory_id, qty: 1 }, { inventory_id: p2.inventory_id, qty: 1 }],
    fulfilment: 'pickup', per_shop: { 'SLR-5001': 'delivery' },
    address: 'B-19 Green Park Main', pincode: '110016',
  }));
  const q1 = priced.shops.find((x) => x.shop_code === 'SLR-5001');
  const q2 = priced.shops.find((x) => x.shop_code === 'SLR-5002');
  assert.equal(q1.fulfilment, 'delivery');
  assert.ok(q1.delivery_fee > 0, 'per_shop pickup->delivery override must calculate real delivery fee');
  assert.equal(q2.fulfilment, 'pickup');
  assert.equal(q2.delivery_fee, 0, 'store pickup must remain free (₹0)');

  const placed = ok(await customer.post('/api/customer/orders', {
    items: [{ inventory_id: p1.inventory_id, qty: 1 }, { inventory_id: p2.inventory_id, qty: 1 }],
    fulfilment: 'pickup', per_shop: { 'SLR-5001': 'delivery' }, payment: 'prepaid',
    address: 'B-19 Green Park Main', pincode: '110016', request_id: 'master-multi-1',
  }), 201);
  // Honest payment disclosure — never falsely mark unverified prepaid as 'paid'
  assert.equal(placed.order.payment_status, 'unconfirmed_prepaid');
  assert.match(placed.order.payment_disclosure, /No online payment gateway/i);

  // Stock reserved transactionally
  const inv1After = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p1.inventory_id);
  const inv2After = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p2.inventory_id);
  assert.equal(inv1After.reserved, inv1Before.reserved + 1);
  assert.equal(inv2After.reserved, inv2Before.reserved + 1);

  test.master = {
    parentCode: placed.order.code,
    shop1Order: placed.shops.find((x) => x.shop_code === 'SLR-5001'),
    shop2Order: placed.shops.find((x) => x.shop_code === 'SLR-5002'),
    p1, p2, inv1Before, inv2Before,
  };
});

test('Scenario 9: Free Store Pickup completes ONLY with valid OTP and properly deducts on_hand + clears reserved stock', async () => {
  ok(await seller2.post('/api/auth/login', { email: 'stationery@nearbuy.demo', password: 'Customer123!' }));
  const ordCode = test.master.shop2Order.order_code;
  const p2 = test.master.p2;
  const invBefore = test.master.inv2Before;

  // Seller accepts & packs
  ok(await seller2.post(`/api/orders/${ordCode}/actions`, { action: 'accept' }));
  ok(await seller2.post(`/api/orders/${ordCode}/actions`, { action: 'process' }));
  ok(await seller2.post(`/api/orders/${ordCode}/actions`, { action: 'pack' }));

  // Manual deliver OTP bypass MUST be blocked!
  assert.equal((await seller2.post(`/api/orders/${ordCode}/actions`, { action: 'deliver' })).status, 409);

  // Wrong code refused
  assert.equal((await seller2.post(`/api/seller/orders/${ordCode}/collect`, { code: '0000' })).status, 409);

  // Valid customer collection OTP completes pickup AND deducts stock cleanly
  const custOrder = ok(await customer.get(`/api/customer/orders/${test.master.parentCode}`)).order;
  const pickupRow = custOrder.shops.find((s) => s.order_code === ordCode);
  assert.match(pickupRow.collection_code, /^\d{4}$/);
  ok(await seller2.post(`/api/seller/orders/${ordCode}/collect`, { code: pickupRow.collection_code }));

  const invAfter = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p2.inventory_id);
  assert.equal(invAfter.on_hand, invBefore.on_hand - 1, 'pickup completion must decrement on_hand');
  assert.equal(invAfter.reserved, invBefore.reserved, 'pickup completion must clear reserved');
});

test('Scenario 2: Seller Self-Delivery blocks manual OTP bypass, dispatches, verifies customer OTP, and deducts stock', async () => {
  ok(await seller1.post('/api/auth/login', { email: 'owner@nearbuy.demo', password: 'Seller123!' }));
  const p1 = test.master.p1;
  const invBefore = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p1.inventory_id);

  // Place a dedicated delivery order for self-delivery test
  const placed = ok(await customer.post('/api/customer/orders', {
    items: [{ inventory_id: p1.inventory_id, qty: 1 }], fulfilment: 'delivery', payment: 'cod',
    address: 'B-19 Green Park Main', pincode: '110016', request_id: 'master-self-1',
  }), 201);
  const ordCode = placed.shops[0].order_code;

  // Seller switches to Deliver Myself
  ok(await seller1.post(`/api/seller/orders/${ordCode}/fulfilment`, { mode: 'self' }));
  for (const action of ['accept', 'process', 'pack']) ok(await seller1.post(`/api/orders/${ordCode}/actions`, { action }));
  ok(await seller1.post(`/api/seller/orders/${ordCode}/self-dispatch`, {}));

  // Manual deliver shortcut MUST be blocked!
  assert.equal((await seller1.post(`/api/orders/${ordCode}/actions`, { action: 'deliver' })).status, 409);

  // Fetch customer's 4-digit self-delivery code
  const custOrd = ok(await customer.get(`/api/customer/orders/${placed.order.code}`)).order;
  const selfCode = custOrd.shops[0].collection_code;
  assert.match(selfCode, /^\d{4}$/);

  // Wrong code refused, right code completes + deducts stock + syncs parent status
  assert.equal((await seller1.post(`/api/seller/orders/${ordCode}/self-delivered`, { code: '9999' })).status, 409);
  ok(await seller1.post(`/api/seller/orders/${ordCode}/self-delivered`, { code: selfCode }));

  const finalCust = ok(await customer.get(`/api/customer/orders/${placed.order.code}`)).order;
  assert.equal(finalCust.status, 'delivered');
  const invAfter = db.get('SELECT on_hand, reserved FROM inventory WHERE id = ?', p1.inventory_id);
  assert.equal(invAfter.on_hand, invBefore.on_hand - 1);
  assert.equal(invAfter.reserved, invBefore.reserved);
});

test('Scenario 3, 4, 5, 6, 7 & 11: Find-a-Runner, Rejection, Re-appointment, Concurrent Acceptance, Pickup & Delivery OTPs', async () => {
  ok(await runner1.post('/api/partners/login', { identifier: 'rohan@nearbuy.demo', password: 'Runner123!' }));
  ok(await runner2.post('/api/partners/login', { identifier: 'farhan@nearbuy.demo', password: 'Runner123!' }));
  for (const r of [runner1, runner2]) {
    ok(await r.patch('/api/partners/availability', { online: true }));
    ok(await r.post('/api/partners/location', { lat: 28.550161, lng: 77.241592, accuracy_m: 10 }));
  }

  const dlvCode = test.master.shop1Order.delivery.code;
  const ordCode = test.master.shop1Order.order_code;

  // Seller updates parcel details and fetches enriched Find-a-Runner candidates (with approx privacy coords & carrying capacity)
  ok(await seller1.patch(`/api/seller/deliveries/${dlvCode}/parcel`, { package_count: 2, weight_g: 1500, pickup_instructions: 'Main counter' }));
  const candRes = ok(await seller1.get(`/api/seller/deliveries/${dlvCode}/candidates`));
  assert.ok(candRes.eligible_count >= 2);
  const c1 = candRes.candidates.find((c) => c.code === 'DP-2001');
  assert.ok(c1.max_kg > 0 && c1.fits_parcel === true && c1.approx_location);

  // Scenario 7: Appoint runner1 -> runner1 declines -> auto-offers/returns cleanly -> seller cancels offer and explicitly appoints runner2!
  ok(await seller1.post(`/api/seller/deliveries/${dlvCode}/appoint`, { partner_code: 'DP-2001' }));
  const offer1 = ok(await runner1.get('/api/delivery/offers')).offers.find((o) => o.delivery_code === dlvCode);
  assert.ok(offer1);
  ok(await runner1.post(`/api/delivery/offers/${offer1.id}/decline`, { reason: 'Taking a break' }));
  const afterDecline = ok(await seller1.get(`/api/seller/deliveries/${dlvCode}`)).delivery;
  assert.ok(['awaiting_assignment', 'searching_partner', 'offer_sent'].includes(afterDecline.status));
  // If system auto-sent an offer to another partner, test Seller Cancel Offer too before explicit re-appoint
  if (afterDecline.status === 'offer_sent') ok(await seller1.post(`/api/seller/deliveries/${dlvCode}/cancel-offer`, {}));

  // Explicitly appoint runner2
  ok(await seller1.post(`/api/seller/deliveries/${dlvCode}/appoint`, { partner_code: 'DP-2003' }));
  const offer2 = ok(await runner2.get('/api/delivery/offers')).offers.find((o) => o.delivery_code === dlvCode);
  assert.ok(offer2);

  // Scenario 11: Concurrent acceptance race (two simultaneous accept requests + rival appoint) -> strictly ONE wins!
  const [raceA, raceB, rivalAppoint] = await Promise.all([
    runner2.post(`/api/delivery/offers/${offer2.id}/accept`),
    runner2.post(`/api/delivery/offers/${offer2.id}/accept`),
    seller1.post(`/api/seller/deliveries/${dlvCode}/appoint`, { partner_code: 'DP-2001' }),
  ]);
  assert.equal([raceA.status, raceB.status].filter((s) => s === 200).length, 1, 'exactly one concurrent acceptance must succeed');
  assert.equal(rivalAppoint.status, 409, 'cannot appoint another runner while assigned/offered');

  // Scenario 4: Customer sees assigned partner name/vehicle + delivery OTP (NEVER partner phone)
  const custView = ok(await customer.get(`/api/customer/orders/${test.master.parentCode}`)).order;
  const sh1 = custView.shops.find((s) => s.order_code === ordCode);
  assert.equal(sh1.delivery.partner.name, 'Farhan Ali');
  assert.match(String(sh1.delivery.delivery_code), /^\d{4}$/);
  assert.ok(!JSON.stringify(sh1).includes('9810011103'), 'customer view must never expose partner phone number');

  // Scenario 5: Pickup OTP verification + geofence (seller marks parcel ready for pickup -> gets pickup PIN)
  const ready = ok(await seller1.post(`/api/seller/deliveries/${dlvCode}/ready`));
  const pickupPin = ready.delivery.pickup_pin;
  ok(await runner2.post(`/api/deliveries/${dlvCode}/start`));
  const job = ok(await runner2.get(`/api/deliveries/${dlvCode}`)).delivery;
  ok(await runner2.post('/api/partners/location', { lat: job.pickup.lat, lng: job.pickup.lng, accuracy_m: 10 }));
  ok(await runner2.post(`/api/deliveries/${dlvCode}/arrived-at-pickup`));
  assert.equal((await runner2.post(`/api/deliveries/${dlvCode}/verify-pickup`, { code: '0000', package_count: 2 })).status, 400);
  ok(await runner2.post(`/api/deliveries/${dlvCode}/verify-pickup`, { code: pickupPin, package_count: 2 }));
  ok(await runner2.post(`/api/deliveries/${dlvCode}/picked-up`));

  // Scenario 6: Delivery OTP verification + geofence + completion
  const activeJob = ok(await runner2.get(`/api/deliveries/${dlvCode}`)).delivery;
  ok(await runner2.post('/api/partners/location', { lat: activeJob.drop.lat, lng: activeJob.drop.lng, accuracy_m: 10 }));
  ok(await runner2.post(`/api/deliveries/${dlvCode}/arrived-at-destination`));
  assert.equal((await runner2.post(`/api/deliveries/${dlvCode}/complete`, {})).status, 409, 'cannot complete without OTP proof');
  assert.equal((await runner2.post(`/api/deliveries/${dlvCode}/proof`, { method: 'otp', code: '0000' })).status, 400);
  ok(await runner2.post(`/api/deliveries/${dlvCode}/proof`, { method: 'otp', code: sh1.delivery.delivery_code }));
  const finished = ok(await runner2.post(`/api/deliveries/${dlvCode}/complete`, {}));
  assert.equal(finished.delivery.status, 'delivered');

  // Verify parent customer order auto-synced to 'delivered' (both shops now delivered!)
  const syncedParent = ok(await customer.get(`/api/customer/orders/${test.master.parentCode}`)).order;
  assert.equal(syncedParent.status, 'delivered');
});

test('Scenario 8: No Runner Available keeps order safe without silent pickup conversion, offers clear self-delivery fallback', async () => {
  for (const r of [runner1, runner2]) ok(await r.patch('/api/partners/availability', { online: false }));
  db.run('UPDATE delivery_partners SET online = 0');
  const placed = ok(await customer.post('/api/customer/orders', {
    items: [{ inventory_id: test.master.p1.inventory_id, qty: 1 }], fulfilment: 'delivery', payment: 'prepaid',
    address: 'B-19 Green Park Main', pincode: '110016', request_id: 'master-norunner-1',
  }), 201);
  const dlvCode = placed.shops[0].delivery.code;
  const ordCode = placed.shops[0].order_code;

  const cands = ok(await seller1.get(`/api/seller/deliveries/${dlvCode}/candidates`));
  assert.equal(cands.eligible_count, 0);
  assert.ok(cands.candidates.every((c) => c.reasons.length > 0));
  // Order MUST remain delivery (never silently converted to store pickup!)
  const ful = ok(await seller1.get(`/api/seller/orders/${ordCode}/fulfilment`)).fulfilment;
  assert.equal(ful.mode, 'network');
  // Seller can explicitly choose Deliver Myself
  ok(await seller1.post(`/api/seller/orders/${ordCode}/fulfilment`, { mode: 'self' }));
  assert.equal(ok(await seller1.get(`/api/seller/orders/${ordCode}/fulfilment`)).fulfilment.mode, 'self');
});

test('Scenario 12: Access Control, 18+ Server-Side Age Gate, OTP Expiry & Refresh, Returns, Issues, and Unified Admin Ops', async () => {
  // 18+ age gate on partner registration (under 18 rejected server-side!)
  const minorClient = makeClient();
  const minorReg = await minorClient.post('/api/partners/applications', {
    name: 'Minor Applicant', mobile: '9899112233', email: 'minor.test@example.com',
    password: 'Runner#2026', date_of_birth: '2012-08-15', accept_terms: true,
  });
  assert.equal(minorReg.status, 400);
  assert.match(JSON.stringify(minorReg.data), /18/);

  // OTP expiry check + refresh on pickup order
  const expOrd = ok(await customer.post('/api/customer/orders', {
    items: [{ inventory_id: test.master.p2.inventory_id, qty: 1 }], fulfilment: 'pickup',
    address: 'B-19 Green Park Main', pincode: '110016', request_id: 'master-exp-1',
  }), 201);
  const oCode = expOrd.shops[0].order_code;
  for (const a of ['accept', 'process', 'pack']) ok(await seller2.post(`/api/orders/${oCode}/actions`, { action: a }));
  db.run('UPDATE orders SET collection_code_expires_at = ? WHERE code = ?', '2020-01-01T00:00:00.000Z', oCode);
  const expiredRes = await seller2.post(`/api/seller/orders/${oCode}/collect`, { code: expOrd.shops[0].collection_code });
  assert.equal(expiredRes.status, 409);
  assert.match(expiredRes.data.error, /expired/i);
  const refreshed = ok(await customer.post(`/api/customer/orders/${expOrd.order.code}/shops/${oCode}/refresh-code`, {}));
  ok(await seller2.post(`/api/seller/orders/${oCode}/collect`, { code: refreshed.collection_code }));

  // Customer submits return request + support issue -> visible in Seller Hub & Unified Admin Control Tower
  const ret = ok(await customer.post(`/api/customer/orders/${test.master.parentCode}/shops/${test.master.shop2Order.order_code}/return`, {
    reason: 'Damaged in transit', description: 'Cover arrived bent',
  }), 201);
  assert.match(ret.return.code, /^RET-/);
  const issue = ok(await customer.post(`/api/customer/orders/${test.master.parentCode}/issue`, {
    category: 'delayed', subject: 'Need receipt check', description: 'Please verify my multi-shop invoice breakdown.',
  }), 201);
  assert.match(issue.code, /^CMP-/);

  // Unified Admin Control Tower checks & access isolation
  assert.equal((await customer.get('/api/admin/sellers')).status, 401);
  assert.equal((await seller1.get('/api/admin/sellers')).status, 401);
  ok(await admin.post('/api/tower/login', { email: 'tower@nearbuy.demo', password: 'Tower123!' }));
  const dash = ok(await admin.get('/api/admin/dashboard'));
  assert.ok(dash.marketplace.sellers_approved >= 3);
  assert.ok(dash.marketplace.customers >= 2);
  const disputes = ok(await admin.get('/api/admin/disputes'));
  assert.ok(disputes.returns.some((r) => r.code === ret.return.code));
  assert.ok(disputes.customer_complaints.some((c) => c.code === issue.code));
});

test('Scenario 13: Real Production Account Onboarding (Customer + Seller + Adult 18+ Runner — Zero Demo Accounts Used)', async () => {
  // 1) Brand-new real seller registers, verifies email, completes onboarding, gets approved by Admin, lists product, gets approved!
  const prodSeller = makeClient();
  const sReg = ok(await prodSeller.post('/api/auth/register', {
    business_name: 'Hauz Khas Books & More', store_name: 'Hauz Khas Books', business_type: 'Sole proprietorship',
    name: 'Vikram Sethi', email: 'vikram.prod@example.com', mobile: '9811445566',
    password: 'ProdSeller#2026', confirm_password: 'ProdSeller#2026', accept_terms: true,
  }), 201);
  // Verify email using outbox token
  const outbox = db.get("SELECT link, body FROM email_outbox WHERE to_email = 'vikram.prod@example.com' ORDER BY id DESC LIMIT 1");
  const vTok = (outbox.link || outbox.body).match(/token=([A-Za-z0-9_-]+)/)[1];
  ok(await prodSeller.post('/api/auth/verify-email', { token: vTok }));
  // Set store profile, pickup location, business details, bank, and add a product
  ok(await prodSeller.put('/api/settings/store', {
    store_name: 'Hauz Khas Books', store_description: 'Independent neighbourhood bookshop and stationery counter in Hauz Khas Delhi.',
    contact_email: 'vikram.prod@example.com', contact_phone: '9811445566', is_open: true, operating_hours: '09:00–21:00', service_radius_km: 3,
  }));
  ok(await prodSeller.post('/api/settings/pickup-locations', {
    name: 'Hauz Khas Counter', contact_person: 'Vikram Sethi', mobile: '9811445566',
    address: '18 Hauz Khas Market', pincode: '110016', city: 'New Delhi', state: 'Delhi', is_default: true,
  }), 201);
  const sellerCode = ok(await prodSeller.get('/api/auth/me')).seller.code;
  ok(await admin.post(`/api/admin/sellers/${sellerCode}/review`, { decision: 'approve', note: 'Verified local shop' }));
  const prodCreated = ok(await prodSeller.post('/api/products', {
    title: 'Classmate Spiral Notebook A4', category: 'Books', brand: 'Classmate',
    description: '200-page ruled spiral notebook for students and professionals.',
    sku: 'HKB-NB-01', price: 110, mrp: 140, gst_rate: 12, quantity: 12, safety_stock: 2,
    weight_g: 320, length_cm: 29, width_cm: 21, height_cm: 2, dispatch_days: 1, submit: true,
  }), 201);
  ok(await admin.post(`/api/admin/listings/${prodCreated.code}/review`, { decision: 'approve', note: 'Approved' }));

  // 2) Brand-new real 18+ adult runner registers, verifies, submits, gets approved by Admin!
  const prodRunner = makeClient();
  const rReg = ok(await prodRunner.post('/api/partners/applications', {
    name: 'Suresh Yadav', date_of_birth: '1993-07-10', mobile: '9811667788', email: 'suresh.prod@example.com',
    password: 'ProdRunner#2026', accept_terms: true,
  }), 201);
  for (const ch of ['mobile', 'email']) {
    const otp = ok(await prodRunner.post(`/api/partners/verify/${ch}/request`));
    ok(await prodRunner.post(`/api/partners/verify/${ch}/confirm`, { code: otp.test_code }));
  }
  const southZone = ok(await prodRunner.get('/api/partners/zones')).zones.find((z) => z.name === 'South Delhi');
  ok(await prodRunner.patch('/api/partners/profile', {
    date_of_birth: '1993-07-10', city: 'New Delhi', home_zone_id: southZone.id, language: 'Hindi',
    emergency_name: 'Mahesh Yadav', emergency_phone: '9811660000',
  }));
  ok(await prodRunner.put('/api/partners/vehicle', { type: 'walking' }));
  ok(await prodRunner.post('/api/partners/documents?kind=photo&name=p.png', PNG), 201);
  ok(await prodRunner.post('/api/partners/documents?kind=identity&name=id.png', PNG), 201);
  ok(await prodRunner.put('/api/partners/payout', { holder: 'Suresh Yadav', bank: 'HDFC Bank', account: '50100123456789', ifsc: 'HDFC0000123' }));
  for (const m of ok(await prodRunner.get('/api/partners/config')).training) ok(await prodRunner.post('/api/partners/training', { module: m.key }));
  ok(await prodRunner.post('/api/partners/applications/submit'));

  const detail = ok(await admin.get(`/api/admin/partners/${rReg.code}`)).partner;
  assert.ok(detail.age >= 18);
  for (const doc of detail.documents) ok(await admin.post(`/api/admin/partners/${rReg.code}/documents/${doc.id}/review`, { decision: 'verified' }));
  ok(await admin.post(`/api/admin/partners/${rReg.code}/vehicle-review`, { decision: 'verified' }));
  ok(await admin.post(`/api/admin/partners/${rReg.code}/payout-review`, { decision: 'verified' }));
  ok(await admin.patch(`/api/admin/partners/${rReg.code}/approval`, { decision: 'approve', note: '18+ verified' }));

  // 3) Brand-new real customer places an order from the brand-new real seller (zero demo accounts!)
  const prodCust = makeClient();
  ok(await prodCust.post('/api/customer/register', {
    name: 'Ritika Malhotra', email: 'ritika.prod@example.com', password: 'ProdCustomer#2026',
    pincode: '110016', address: 'E-5 Hauz Khas Market',
  }), 201);
  const shopCat = ok(await prodCust.get(`/api/customer/shops/${sellerCode}`));
  assert.equal(shopCat.products.length, 1);
  const placed = ok(await prodCust.post('/api/customer/orders', {
    items: [{ inventory_id: shopCat.products[0].inventory_id, qty: 1 }], fulfilment: 'pickup',
    address: 'E-5 Hauz Khas Market', pincode: '110016', request_id: 'prod-e2e-1',
  }), 201);
  assert.match(placed.order.code, /^CNB-/);
  test.prodOrderCode = placed.order.code;
});

test('Scenario 14b: Data persistence across server restart', async () => {
  const codeToVerify = test.prodOrderCode;
  await new Promise((resolve) => srv.close(resolve));
  srv = await start();
  base = `http://127.0.0.1:${srv.address().port}`;
  const freshCust = makeClient();
  ok(await freshCust.post('/api/customer/login', { email: 'ritika.prod@example.com', password: 'ProdCustomer#2026' }));
  const reloaded = ok(await freshCust.get(`/api/customer/orders/${codeToVerify}`)).order;
  assert.equal(reloaded.code, codeToVerify, 'order placed before server restart must persist in SQLite');
  assert.equal(reloaded.shops[0].shop, 'Hauz Khas Books');
});
