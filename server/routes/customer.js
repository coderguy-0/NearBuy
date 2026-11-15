'use strict';
// Customer accounts, the neighbourhood marketplace and checkout.
//
// This module connects a real customer to the systems that already existed: the Seller Hub order ledger and the
// delivery network. It never keeps a second copy of an order — a customer checkout writes one `customer_orders` row
// (the customer's receipt) and one `orders` row per shop, and the shop order is the same record the seller works on.
const { route, reply } = require('../router');
const { get, all, run, tx, insert, nextCode, db, parseJson } = require('../db');
const {
  HttpError, bad, notFound, conflict, nowIso, r2, validate, sha256, randomToken, hashPassword, verifyPassword,
  passwordProblems,
} = require('../lib');
const { sendMail } = require('../mail');

const COOKIE = 'nb_customer_sid';
const SESSION_DAYS = 30;
const MAX_LINES = 40;

/* ---------- Schema ---------- */
function columnExists(table, column) {
  return all(`PRAGMA table_info(${table})`).some((c) => c.name === column);
}
function addColumn(table, column, definition) {
  if (!columnExists(table, column)) run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function ensureSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS customer_profiles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      phone TEXT, address TEXT, area TEXT, city TEXT, state TEXT, pincode TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_orders (
      id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL, payment_method TEXT NOT NULL, payment_status TEXT NOT NULL,
      subtotal REAL NOT NULL, delivery_total REAL NOT NULL DEFAULT 0, total REAL NOT NULL,
      address TEXT, area TEXT, city TEXT, state TEXT, pincode TEXT,
      is_demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_notifications (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS customer_request_keys (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, key)
    );
    CREATE TABLE IF NOT EXISTS customer_addresses (
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      label TEXT NOT NULL DEFAULT 'Home', recipient_name TEXT, phone TEXT,
      address TEXT NOT NULL, landmark TEXT, area TEXT, city TEXT DEFAULT 'New Delhi', state TEXT DEFAULT 'Delhi',
      pincode TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_customer_orders_user ON customer_orders (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_notif_user ON customer_notifications (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_addr_user ON customer_addresses (user_id);
  `);
  // The shop order carries the customer's receipt and the fulfilment that was agreed for that shop.
  addColumn('orders', 'customer_order_id', 'INTEGER');
  addColumn('orders', 'fulfilment', "TEXT NOT NULL DEFAULT 'delivery'");
  addColumn('orders', 'delivery_mode', "TEXT NOT NULL DEFAULT 'network'");
  addColumn('orders', 'collection_code', 'TEXT');
  addColumn('orders', 'collection_code_expires_at', 'TEXT');
  addColumn('customer_orders', 'discount_total', 'REAL NOT NULL DEFAULT 0');
  addColumn('customer_orders', 'promo_code', 'TEXT');
  run('CREATE INDEX IF NOT EXISTS idx_orders_customer_order ON orders (customer_order_id)');
}
ensureSchema();

/* ---------- Sessions ---------- */
function cookieAttributes(ctx, maxAgeSeconds) {
  const wanted = (process.env.SESSION_SAMESITE || (process.env.NODE_ENV === 'production' ? 'lax' : 'none')).toLowerCase();
  const sameSite = wanted === 'none' && ctx.secure ? 'None' : 'Lax';
  const parts = ['Path=/', 'HttpOnly', `SameSite=${sameSite}`];
  if (ctx.secure) parts.push('Secure');
  if (sameSite === 'None') parts.push('Partitioned');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}
const readCookie = (req, name) => {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
};
function createSession(ctx, userId) {
  const token = randomToken(32);
  insert('sessions', {
    token_hash: sha256(token), user_id: userId, created_at: nowIso(), last_seen_at: nowIso(),
    expires_at: new Date(Date.now() + SESSION_DAYS * 86400000).toISOString(),
    user_agent: String(ctx.req.headers['user-agent'] || '').slice(0, 200), ip: ctx.ip,
  });
  ctx.setCookie(`${COOKIE}=${token}; ${cookieAttributes(ctx, SESSION_DAYS * 86400)}`);
  return token;
}
const clearSessionCookie = (ctx) => ctx.setCookie(`${COOKIE}=; ${cookieAttributes(ctx, 0)}`);
function customerFromRequest(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const session = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!session) return null;
  if (session.expires_at < nowIso()) { run('DELETE FROM sessions WHERE id = ?', session.id); return null; }
  if (Date.now() - Date.parse(session.last_seen_at) > 300000) run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', nowIso(), session.id);
  const user = get('SELECT id, email, name, mobile, email_verified_at, created_at FROM users WHERE id = ?', session.user_id);
  if (!user) return null;
  const profile = get('SELECT * FROM customer_profiles WHERE user_id = ?', user.id);
  // A seller-only account has no customer profile; it can still shop, and the profile is created on first use.
  return { session, user, profile: profile || null };
}
/** Guard for routes that need a signed-in customer. */
function requireCustomer(ctx) {
  const customer = customerFromRequest(ctx.req);
  if (!customer) throw new HttpError(401, 'Please sign in to your NearBuy account to continue.', { code: 'unauthenticated' });
  ctx.customer = customer;
  ctx.customerId = customer.user.id;
  return customer;
}
const optionalCustomer = (ctx) => {
  const customer = customerFromRequest(ctx.req);
  if (customer) { ctx.customer = customer; ctx.customerId = customer.user.id; }
  return customer;
};
function ensureProfile(userId) {
  const existing = get('SELECT * FROM customer_profiles WHERE user_id = ?', userId);
  if (existing) return existing;
  insert('customer_profiles', { user_id: userId, created_at: nowIso(), updated_at: nowIso() });
  return get('SELECT * FROM customer_profiles WHERE user_id = ?', userId);
}

/* ---------- Notifications (customer side) ---------- */
function notifyCustomerUser(userId, type, title, body, link) {
  if (!userId) return;
  insert('customer_notifications', { user_id: userId, type, title, body: body || null, link: link || null, created_at: nowIso() });
  try { C().publish(`customer:${userId}`, { kind: 'notification', type, title }); } catch {}
}

/* ---------- Views ---------- */
const shopView = (seller, extra = {}) => ({
  code: seller.code, name: seller.store_name, description: seller.store_description || null,
  category: extra.category || null, rating: extra.rating || null,
  is_open: seller.is_open !== 0, operating_hours: seller.operating_hours || '08:00–22:00',
  service_radius_km: seller.service_radius_km || null, ...extra,
});
function productView(row) {
  const available = Math.max(0, row.on_hand - row.reserved);
  const promo = row.seller_id && row.product_id ? require('./growth').promotionPrice(row.seller_id, row.product_id, row.price) : null;
  const effectivePrice = promo ? promo.price : row.price;
  const compareMrp = promo ? Math.max(row.mrp || 0, row.price) : (row.mrp && row.mrp > row.price ? row.mrp : null);
  return {
    inventory_id: row.inventory_id, product_code: row.product_code, title: row.title, brand: row.brand || null,
    category: row.category, price: effectivePrice, base_price: row.price,
    mrp: compareMrp && compareMrp > effectivePrice ? compareMrp : null,
    promo: promo ? { code: promo.code, name: promo.name, savings: r2(row.price - promo.price) } : null,
    sku: row.sku, unit: row.unit || null, gst_rate: row.gst_rate, available, in_stock: available > 0,
    package: row.package_text || null,
    image: row.upload_id ? `/api/customer/media/${row.upload_id}` : null,
  };
}

/* ---------- Discovery ---------- */
const C = () => require('../delivery/core');

/** Every approved shop whose pickup point is inside a delivery zone that serves this PIN code. */
function serviceableShops(pincode) {
  const zone = pincode ? C().geocode('', pincode) : null;
  const sellers = all(`SELECT s.* FROM sellers s WHERE s.status = 'approved' AND EXISTS (
      SELECT 1 FROM seller_pickup_locations p WHERE p.seller_id = s.id
        AND EXISTS (SELECT 1 FROM inventory i JOIN products pr ON pr.id = i.product_id
                    WHERE i.seller_id = s.id AND pr.status = 'active'))
    ORDER BY s.store_name`);
  return sellers.map((seller) => {
    const pickup = get('SELECT * FROM seller_pickup_locations WHERE seller_id = ? ORDER BY is_default DESC, id LIMIT 1', seller.id);
    const counts = get(`SELECT COUNT(*) AS listed, COALESCE(MIN(pr.price), 0) AS from_price,
        SUM(CASE WHEN (i.on_hand - i.reserved) > 0 THEN 1 ELSE 0 END) AS in_stock_count,
        (SELECT pr2.category FROM products pr2 WHERE pr2.seller_id = s.id AND pr2.status = 'active' GROUP BY pr2.category ORDER BY COUNT(*) DESC LIMIT 1) AS main_category
      FROM inventory i JOIN products pr ON pr.id = i.product_id JOIN sellers s ON s.id = i.seller_id
      WHERE i.seller_id = ? AND pr.status = 'active'`, seller.id);
    let distance_km = null;
    let serviceable = false;
    let delivery_reason = null;
    if (seller.is_open === 0) {
      serviceable = false;
      delivery_reason = 'Currently closed';
    } else if (!zone) serviceable = true;
    else if (pickup && C().geocode(pickup.address, pickup.pincode)) {
      const from = C().geocode(pickup.address, pickup.pincode);
      if (from.zone.id === zone.zone.id) {
        distance_km = r2(C().roadKm(from.lat, from.lng, zone.lat, zone.lng));
        const maxKm = seller.service_radius_km ? Math.min(Number(seller.service_radius_km), from.zone.max_delivery_km) : from.zone.max_delivery_km;
        serviceable = distance_km <= maxKm;
        if (!serviceable) delivery_reason = `Outside ${maxKm} km shop delivery radius`;
      }
    }
    return shopView(seller, {
      area: pickup ? pickup.city : null, pincode: pickup ? pickup.pincode : null, address: pickup ? pickup.address : null,
      distance_km, category: counts.main_category || null,
      products: counts.in_stock_count || counts.listed, total_products: counts.listed,
      from_price: counts.from_price, serviceable, delivery_reason,
      pickup_point: pickup ? pickup.name : null, pickup_available: seller.is_open !== 0,
    });
  });
}

function shopCatalogue(code) {
  const seller = get("SELECT * FROM sellers WHERE code = ? AND status = 'approved'", code);
  if (!seller) throw notFound('Shop');
  const rows = all(`SELECT i.id AS inventory_id, i.seller_id, i.product_id, i.sku, i.on_hand, i.reserved,
      pr.code AS product_code, pr.title, pr.brand, pr.category, pr.price, pr.mrp, pr.gst_rate, pr.package,
      (SELECT pi.upload_id FROM product_images pi WHERE pi.product_id = pr.id ORDER BY pi.is_primary DESC, pi.position LIMIT 1) AS upload_id
    FROM inventory i JOIN products pr ON pr.id = i.product_id
    WHERE i.seller_id = ? AND pr.status = 'active'
    ORDER BY pr.category, pr.title`, seller.id);
  const allProducts = rows.map((r) => productView({ ...r, package_text: null }));
  const products = allProducts.filter((p) => p.available > 0);
  const out_of_stock = allProducts.filter((p) => p.available <= 0);
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const pickup = get('SELECT * FROM seller_pickup_locations WHERE seller_id = ? ORDER BY is_default DESC, id LIMIT 1', seller.id);
  return {
    shop: shopView(seller, {
      area: pickup ? pickup.city : null, pincode: pickup ? pickup.pincode : null, address: pickup ? pickup.address : null,
      pickup_point: pickup ? pickup.name : null,
      products: products.length, categories,
    }),
    products, out_of_stock, categories,
  };
}

/* ---------- Cart pricing ---------- */
const categoryOf = (rows) => (rows.every((r) => r.category === 'Grocery') ? 'grocery' : 'ecommerce');

function loadLines(items) {
  const seen = new Map();
  for (const item of items) {
    const id = Number(item.inventory_id);
    const qty = Number(item.qty);
    if (!Number.isInteger(id)) continue;
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) throw bad('Choose a quantity between 1 and 20 for each product.');
    seen.set(id, (seen.get(id) || 0) + qty);
  }
  if (!seen.size) throw bad('Your cart is empty.');
  if (seen.size > MAX_LINES) throw bad(`A single order can carry up to ${MAX_LINES} products.`);
  const rows = [];
  for (const [id, qty] of seen) {
    const row = get(`SELECT i.id AS inventory_id, i.sku, i.on_hand, i.reserved, i.seller_id, i.product_id, pr.code AS product_code, pr.title,
        pr.category, pr.price, pr.mrp, pr.gst_rate
      FROM inventory i JOIN products pr ON pr.id = i.product_id
      WHERE i.id = ? AND pr.status = 'active'`, id);
    if (!row) throw conflict('One of the products in your cart is no longer available.');
    const available = row.on_hand - row.reserved;
    if (qty > available) throw conflict(`Only ${Math.max(0, available)} × ${row.title} left at this shop. Reduce the quantity to continue.`);
    const promo = require('./growth').promotionPrice(row.seller_id, row.product_id, row.price);
    const unit_price = promo ? promo.price : row.price;
    rows.push({ ...row, qty, base_price: row.price, price: unit_price, promo: promo ? { code: promo.code, name: promo.name } : null });
  }
  return rows;
}

/** Group cart lines per shop and price each shop's delivery or pickup. Nothing is written. */
function priceCart(lines, { pincode, fulfilment = 'delivery', address, perShop = {}, allowMissingAddress = false }) {
  const bySeller = new Map();
  for (const line of lines) {
    if (!bySeller.has(line.seller_id)) bySeller.set(line.seller_id, []);
    bySeller.get(line.seller_id).push(line);
  }
  const shops = [];
  for (const [sellerId, sellerLines] of bySeller) {
    const seller = get("SELECT * FROM sellers WHERE id = ? AND status = 'approved'", sellerId);
    if (!seller) throw conflict('One of the shops in your cart is not accepting orders right now.');
    if (seller.is_open === 0) throw conflict(`${seller.store_name} is currently closed and not accepting orders.`);
    const override = perShop && typeof perShop === 'object' ? (perShop[seller.code] || perShop[sellerId]) : null;
    const mode = ['delivery', 'pickup'].includes(override) ? override : fulfilment;
    const baseSubtotal = r2(sellerLines.reduce((sum, l) => sum + (l.base_price || l.price) * l.qty, 0));
    const subtotal = r2(sellerLines.reduce((sum, l) => sum + l.price * l.qty, 0));
    const discount = r2(Math.max(0, baseSubtotal - subtotal));
    const pickup = get('SELECT * FROM seller_pickup_locations WHERE seller_id = ? ORDER BY is_default DESC, id LIMIT 1', sellerId);
    const shop = {
      seller_id: sellerId, shop_code: seller.code, shop_name: seller.store_name,
      pickup_address: pickup ? `${pickup.address}, ${pickup.city} ${pickup.pincode}` : null,
      lines: sellerLines, base_subtotal: baseSubtotal, discount, subtotal,
      fulfilment: mode, delivery_fee: 0, free_delivery: false, eta_minutes: null, serviceable: true, reason: null,
    };
    if (mode === 'pickup') {
      shop.delivery_fee = 0;
      shop.free_delivery = true;
      shop.eta_minutes = 15;
    } else if (!pincode || !address) {
      if (!allowMissingAddress) throw bad('Add a delivery address and PIN code to see the delivery fee.');
      shop.serviceable = false;
      shop.needs_address = true;
      shop.reason = 'Add your delivery address and PIN code to calculate delivery.';
    } else {
      const E = require('../delivery/engine');
      const svc = E.serviceability(sellerId, address, pincode);
      if (!svc.ok) { shop.serviceable = false; shop.reason = svc.reason; shops.push(shop); continue; }
      const category = categoryOf(sellerLines);
      const fee = C().quoteFee(svc.zone, category, svc.distance);
      shop.delivery_fee = fee.total;
      shop.distance_km = r2(svc.distance);
      shop.zone = svc.zone.name;
      shop.drop_area = svc.to.area;
      shop.eta_minutes = Math.round((E.DEFAULT_PREP[category] || 12) + 8 + C().travelMin(svc.distance, 'two_wheeler') + 5);
      shop.category = category;
      shop.fee_breakdown = fee;
    }
    shops.push(shop);
  }
  return shops;
}

const cartTotals = (shops) => {
  const subtotal = r2(shops.reduce((sum, s) => sum + s.subtotal, 0));
  const discount_total = r2(shops.reduce((sum, s) => sum + (s.discount || 0), 0));
  const delivery_total = r2(shops.reduce((sum, s) => sum + s.delivery_fee, 0));
  return { subtotal, discount_total, delivery_total, total: r2(subtotal + delivery_total) };
};

const PAYMENT_DISCLOSURE = {
  cod: 'Cash on delivery — pay when your order arrives or when you collect it at the shop.',
  prepaid: 'No online payment gateway is connected in this environment. Prepaid orders are marked unconfirmed (pending gateway integration) and no card/UPI charge was processed.',
};

/* ---------- Checkout ---------- */
const RULES = {
  items: { type: 'array', min: 1, max: MAX_LINES, required: true, label: 'products' },
  fulfilment: { enum: ['delivery', 'pickup'], default: 'delivery' },
  per_shop: { type: 'object' },
  payment: { enum: ['cod', 'prepaid'], default: 'cod' },
  address: { max: 200 }, pincode: { format: 'pincode' }, area: { max: 120 }, city: { max: 80 },
  name: { max: 80 }, phone: { format: 'mobile' },
  instructions: { max: 200 },
};

function checkout(ctx) {
  const data = validate(ctx.body, RULES);
  const items = Array.isArray(data.items) ? data.items : [];
  const lines = loadLines(items);
  const profile = ensureProfile(ctx.customerId);
  const fulfilment = data.fulfilment;
  const address = data.address || profile.address;
  const pincode = data.pincode || profile.pincode;
  const name = data.name || ctx.customer.user.name;
  const phone = data.phone || profile.phone || ctx.customer.user.mobile;
  const perShop = data.per_shop && typeof data.per_shop === 'object' ? data.per_shop : {};
  const needsDeliveryAddr = fulfilment === 'delivery' || Object.values(perShop).includes('delivery');
  if (needsDeliveryAddr && (!address || !pincode)) throw bad('Choose a delivery address and PIN code before placing the order.', { address: 'Add a delivery address.' });
  const shops = priceCart(lines, { pincode, fulfilment, address, perShop });
  const blocked = shops.filter((s) => !s.serviceable);
  if (blocked.length) throw conflict(`${blocked[0].shop_name} cannot deliver to ${pincode}: ${blocked[0].reason}`);
  const totals = cartTotals(shops);
  const code = nextCode('CNB', 9000);
  const at = nowIso();
  const paymentStatus = data.payment === 'cod' ? 'cod_pending' : 'unconfirmed_prepaid';
  const codeExp = new Date(Date.now() + C().CONFIG.codeTtlMs()).toISOString();
  const hasDeliveryShop = shops.some((s) => s.fulfilment === 'delivery');
  return tx(() => {
    const { createOrder } = require('./orders');
    const customerOrderId = insert('customer_orders', {
      code, user_id: ctx.customerId, status: 'placed', payment_method: data.payment === 'cod' ? 'Cash on delivery' : 'Prepaid',
      payment_status: paymentStatus, subtotal: totals.subtotal, discount_total: totals.discount_total,
      delivery_total: totals.delivery_total, total: totals.total,
      address: hasDeliveryShop ? address : null, area: data.area || profile.area || null,
      city: data.city || profile.city || null, state: profile.state || 'Delhi',
      pincode: hasDeliveryShop ? pincode : null, is_demo: 0, created_at: at, updated_at: at,
    });
    const placed = [];
    for (const shop of shops) {
      const order = createOrder(shop.seller_id, {
        lines: shop.lines.map((l) => ({ inventoryId: l.inventory_id, qty: l.qty })),
        customer: {
          ref: code, name, phone,
          address: shop.fulfilment === 'pickup' ? null : address, city: data.city || profile.city || 'New Delhi',
          state: profile.state || 'Delhi', pincode: shop.fulfilment === 'pickup' ? null : pincode,
        },
        paymentMethod: data.payment === 'cod' ? 'Cash on delivery' : 'Prepaid',
        paymentStatus,
        isDemo: false, applyPromotions: true,
      });
      const collectionCode = shop.fulfilment === 'pickup' ? C().newCode(4) : null;
      const shipping = shop.fulfilment === 'pickup' ? 0 : shop.delivery_fee;
      run(`UPDATE orders SET customer_order_id = ?, fulfilment = ?, delivery_mode = ?, collection_code = ?, collection_code_expires_at = ?,
          shipping_charge = ?, total = ?, ship_address = COALESCE(?, ship_address), ship_pincode = COALESCE(?, ship_pincode),
          updated_at = ? WHERE id = ?`,
      customerOrderId, shop.fulfilment, shop.fulfilment === 'pickup' ? 'none' : 'network', collectionCode,
      collectionCode ? codeExp : null, shipping, r2(order.subtotal + shipping), shop.fulfilment === 'pickup' ? null : address,
      shop.fulfilment === 'pickup' ? null : pincode, at, order.id);
      if (data.instructions && shop.fulfilment === 'delivery') {
        insert('order_delivery_prefs', {
          order_id: order.id, category: shop.category || 'ecommerce', method: 'immediate', instructions: data.instructions,
          special_handling: 0, quoted_fee: shipping, created_at: at,
        });
      }
      if (shop.fulfilment === 'delivery') {
        // The delivery job is created inside this transaction, so a failure to price or route it cancels the whole order.
        require('../delivery/engine').ensureDelivery(get('SELECT * FROM orders WHERE id = ?', order.id), { strict: true });
      }
      placed.push({ order, shop });
    }
    notifyCustomerUser(ctx.customerId, 'order', `Order ${code} placed`,
      `${shops.length === 1 ? shops[0].shop_name : `${shops.length} shops`} · ₹${totals.total.toLocaleString('en-IN')}`, `/customer/#/orders/${code}`);
    return {
      ok: true,
      order: {
        code, total: totals.total, subtotal: totals.subtotal, discount_total: totals.discount_total,
        delivery_total: totals.delivery_total, payment_status: paymentStatus,
        payment_disclosure: PAYMENT_DISCLOSURE[data.payment],
      },
      shops: placed.map(({ order, shop }) => ({
        shop: shop.shop_name, shop_code: shop.shop_code, order_code: order.code, fulfilment: shop.fulfilment,
        delivery_fee: shop.fulfilment === 'pickup' ? 0 : shop.delivery_fee, total: shop.subtotal,
        collection_code: shop.fulfilment === 'pickup' ? get('SELECT collection_code FROM orders WHERE id = ?', order.id).collection_code : null,
        delivery: get("SELECT code, track_token, status, drop_code AS delivery_code FROM deliveries WHERE order_id = ? AND kind = 'forward'", order.id) || null,
      })),
    };
  });
}

/* ---------- Order views ---------- */
const ORDER_STATUS = { new: 'Placed', pending_confirmation: 'Accepted', processing: 'Preparing', packed: 'Packed', ready_to_ship: 'Ready', shipped: 'Out for delivery', delivered: 'Delivered', cancelled: 'Cancelled' };

function customerOrders(userId) {
  const parents = all('SELECT * FROM customer_orders WHERE user_id = ? ORDER BY id DESC LIMIT 60', userId);
  return parents.map((parent) => customerOrderView(parent, { brief: true }));
}
function findCustomerOrder(userId, code) {
  const parent = get('SELECT * FROM customer_orders WHERE code = ? AND user_id = ?', code, userId);
  if (!parent) throw notFound('Order');
  return parent;
}
function customerOrderView(parent, { brief = false } = {}) {
  const shops = all(`SELECT o.*, s.store_name, s.code AS shop_code FROM orders o JOIN sellers s ON s.id = o.seller_id WHERE o.customer_order_id = ? ORDER BY o.id`, parent.id);
  const rows = shops.map((o) => {
    const delivery = get("SELECT * FROM deliveries WHERE order_id = ? AND kind = 'forward'", o.id);
    const partner = delivery && delivery.partner_id
      ? get('SELECT p.code, u.name, p.rating_sum, p.rating_count, v.type AS vehicle_type FROM delivery_partners p JOIN users u ON u.id = p.user_id LEFT JOIN partner_vehicles v ON v.partner_id = p.id WHERE p.id = ?', delivery.partner_id) : null;
    const items = all('SELECT id, title, qty, unit_price, line_total, product_id FROM order_items WHERE order_id = ? ORDER BY id', o.id);
    const closed = o.status === 'cancelled' || o.status === 'delivered';
    const view = {
      order_code: o.code, shop: o.store_name, shop_code: o.shop_code, status: o.status,
      status_label: ORDER_STATUS[o.status] || o.status, fulfilment: o.fulfilment, delivery_mode: o.delivery_mode,
      payment_method: o.payment_method, payment_status: o.payment_status, subtotal: o.subtotal, shipping: o.shipping_charge,
      total: o.total, placed_at: o.placed_at, delivery_fee: o.shipping_charge, item_count: items.reduce((n, i) => n + i.qty, 0),
      items,
    };
    if (o.fulfilment === 'pickup') {
      view.collection_code = closed ? null : o.collection_code;
      view.collection_code_expires_at = closed ? null : (o.collection_code_expires_at || null);
      view.code_label = 'Collection code';
      view.eta = o.status === 'new' ? 'Waiting for the shop to confirm' : o.status === 'delivered' ? 'Collected' : 'Ready to collect once packed';
    } else if (o.delivery_mode === 'self') {
      view.collection_code = closed ? null : o.collection_code;
      view.collection_code_expires_at = closed ? null : (o.collection_code_expires_at || null);
      view.code_label = 'Delivery code';
      view.eta = o.status === 'new' ? 'Waiting for the shop to confirm' : o.status === 'shipped' ? 'Shop staff is out for delivery' : 'The shop delivers this order itself';
    }
    if (delivery) {
      const S = require('../delivery/schema');
      const vSpec = partner && partner.vehicle_type ? S.VEHICLES[partner.vehicle_type] : null;
      const dlvClosed = S.FINAL.includes(delivery.status);
      view.delivery = {
        code: delivery.code, status: delivery.status,
        status_label: require('../delivery/core').label(delivery.status),
        eta_at: delivery.eta_at,
        delivery_code: dlvClosed ? null : delivery.drop_code,
        delivery_code_expires_at: dlvClosed ? null : (delivery.drop_code_expires_at || null),
        partner: partner ? {
          name: partner.name, code: partner.code,
          vehicle: vSpec ? vSpec.label : null,
          rating: partner.rating_count ? r2(partner.rating_sum / partner.rating_count) : null,
        } : null,
        track_url: `/track/?t=${delivery.track_token}`,
      };
    }
    if (!brief) {
      view.timeline = all('SELECT status, title, note, actor, created_at FROM order_events WHERE order_id = ? ORDER BY id', o.id)
        .map((e) => ({ title: e.title, note: e.note, actor: e.actor, at: e.created_at }));
      if (delivery) {
        view.delivery_timeline = all('SELECT status, note, actor_name, created_at FROM delivery_status_history WHERE delivery_id = ? ORDER BY id', delivery.id)
          .map((e) => ({ status: e.status, note: e.note, actor: e.actor_name, at: e.created_at }));
      }
      view.returns = all('SELECT code, reason, qty, status, refund_status, requested_at FROM returns WHERE order_id = ? ORDER BY id DESC', o.id);
      view.cancellable = o.status === 'new';
      view.returnable = o.status === 'delivered' && !view.returns.length;
    }
    return view;
  });
  const statuses = rows.map((r) => r.status);
  const status = statuses.every((s) => s === 'cancelled') ? 'cancelled'
    : statuses.every((s) => s === 'delivered') ? 'delivered'
      : statuses.some((s) => s === 'cancelled') ? 'partly_cancelled' : 'in_progress';
  return {
    code: parent.code, status, status_label: { cancelled: 'Cancelled', delivered: 'Delivered', partly_cancelled: 'Partly cancelled', in_progress: 'In progress' }[status],
    placed_at: parent.created_at, payment_method: parent.payment_method, payment_status: parent.payment_status,
    payment_disclosure: parent.payment_method === 'Cash on delivery' ? PAYMENT_DISCLOSURE.cod : PAYMENT_DISCLOSURE.prepaid,
    subtotal: parent.subtotal, discount_total: parent.discount_total || 0, delivery_total: parent.delivery_total, total: parent.total,
    address: parent.address ? { line: parent.address, area: parent.area, city: parent.city, pincode: parent.pincode } : null,
    shops: rows,
  };
}

/* ---------- Routes ---------- */
const publicProfile = (customer) => {
  const profile = customer.profile || get('SELECT * FROM customer_profiles WHERE user_id = ?', customer.user.id);
  return {
    name: customer.user.name, email: customer.user.email, mobile: profile && profile.phone ? profile.phone : customer.user.mobile,
    address: profile ? { line: profile.address, area: profile.area, city: profile.city, state: profile.state, pincode: profile.pincode } : null,
    created_at: customer.user.created_at,
  };
};

route('POST', '/api/customer/register', { auth: 'public' }, (ctx) => {
  const { rateLimit } = require('../auth');
  // Shared mobile networks put many neighbours behind one address, so the burst limit does the real work here.
  rateLimit(`cust-reg-minute:${ctx.ip}`, 10, 60000);
  rateLimit(`cust-reg:${ctx.ip}`, 40, 60 * 60000);
  const data = validate(ctx.body, {
    name: { required: true, min: 2, max: 80, label: 'Full name' },
    email: { required: true, max: 160, label: 'Email address' },
    password: { required: true, max: 200, label: 'Password' },
    mobile: { format: 'mobile', label: 'Mobile number' },
    pincode: { format: 'pincode' },
    address: { max: 200 },
  });
  const email = data.email.toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(email)) throw bad('Please correct the highlighted fields.', { email: 'Enter a valid email address.' });
  const problem = passwordProblems(data.password);
  if (problem) throw bad('Please correct the highlighted fields.', { password: problem });
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw conflict('An account with this email address already exists. Sign in instead.');
  const at = nowIso();
  const userId = tx(() => {
    const id = insert('users', { email, password_hash: hashPassword(data.password), name: data.name, mobile: data.mobile || null, created_at: at });
    insert('customer_profiles', {
      user_id: id, phone: data.mobile || null, address: data.address || null, city: 'New Delhi', state: 'Delhi',
      pincode: data.pincode || null, created_at: at, updated_at: at,
    });
    return id;
  });
  createSession(ctx, userId);
  notifyCustomerUser(userId, 'account', 'Welcome to NearBuy', 'Add your delivery address to see the shops that serve you.', '/customer/#/account');
  return reply.created({ ok: true, customer: publicProfile({ user: get('SELECT id, email, name, mobile, created_at FROM users WHERE id = ?', userId), profile: get('SELECT * FROM customer_profiles WHERE user_id = ?', userId) }) });
});

route('POST', '/api/customer/login', { auth: 'public' }, (ctx) => {
  const { rateLimit } = require('../auth');
  rateLimit(`cust-login:${ctx.ip}`, 12, 15 * 60000);
  const data = validate(ctx.body, { email: { required: true, max: 160 }, password: { required: true, max: 200 } });
  const user = get('SELECT * FROM users WHERE email = ?', data.email.toLowerCase());
  if (!user || !user.password_hash || !verifyPassword(data.password, user.password_hash)) {
    throw new HttpError(401, 'That email address and password do not match an account.');
  }
  if (user.suspended_at) throw new HttpError(403, `This account has been suspended${user.suspend_reason ? `: ${user.suspend_reason}` : '.'}`);
  run('UPDATE users SET last_login_at = ? WHERE id = ?', nowIso(), user.id);
  ensureProfile(user.id);
  createSession(ctx, user.id);
  return { ok: true, customer: publicProfile({ user, profile: get('SELECT * FROM customer_profiles WHERE user_id = ?', user.id) }) };
});

route('POST', '/api/customer/logout', { auth: 'public' }, (ctx) => {
  const token = readCookie(ctx.req, COOKIE);
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  clearSessionCookie(ctx);
  return { ok: true };
});

route('GET', '/api/customer/me', { guard: requireCustomer }, (ctx) => {
  ensureProfile(ctx.customerId);
  return { customer: publicProfile(customerFromRequest(ctx.req)), unread: get('SELECT COUNT(*) AS n FROM customer_notifications WHERE user_id = ? AND read_at IS NULL', ctx.customerId).n };
});

route('PATCH', '/api/customer/profile', { guard: requireCustomer }, (ctx) => {
  const data = validate(ctx.body, {
    name: { min: 2, max: 80 }, mobile: { format: 'mobile' }, address: { max: 200 }, area: { max: 120 },
    city: { max: 80 }, state: { max: 80 }, pincode: { format: 'pincode' },
  }, { partial: true });
  ensureProfile(ctx.customerId);
  const patch = {};
  if (data.name) { run('UPDATE users SET name = ? WHERE id = ?', data.name, ctx.customerId); }
  for (const key of ['mobile', 'address', 'area', 'city', 'state', 'pincode']) if (data[key] !== undefined && data[key] !== null) patch[key === 'mobile' ? 'phone' : key] = data[key];
  if (Object.keys(patch).length) {
    patch.updated_at = nowIso();
    run(`UPDATE customer_profiles SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`, ...Object.values(patch), ctx.customerId);
  }
  return { ok: true, customer: publicProfile(customerFromRequest(ctx.req)) };
});

route('GET', '/api/customer/shops', { auth: 'public' }, (ctx) => {
  optionalCustomer(ctx);
  const pincode = ctx.query.pincode || (ctx.customer && ctx.customer.profile ? ctx.customer.profile.pincode : null);
  const shops = serviceableShops(pincode).filter((s) => !ctx.query.q || `${s.name} ${s.description || ''}`.toLowerCase().includes(String(ctx.query.q).toLowerCase()));
  const zone = pincode ? C().geocode('', pincode) : null;
  // A PIN code outside every delivery zone is reported as unserved rather than as a list of shops that cannot deliver.
  const served = zone ? shops.filter((s) => s.serviceable) : (pincode ? [] : shops);
  return {
    pincode: pincode || null, zone: zone ? zone.zone.name : null, area: zone ? zone.area : null,
    serviceable: zone ? zone.zone.status === 'active' : null,
    shops: served, categories: [...new Set(served.map((s) => s.category).filter(Boolean))],
  };
});

route('GET', '/api/customer/shops/:code', { auth: 'public' }, (ctx) => shopCatalogue(ctx.params.code));

/** Safe public product media: serves ONLY uploads attached to an active marketplace product. */
route('GET', '/api/customer/media/:id', { auth: 'public' }, (ctx) => {
  const id = Number(ctx.params.id);
  const row = get(`SELECT u.mime, u.data FROM uploads u
    JOIN product_images pi ON pi.upload_id = u.id
    JOIN products p ON p.id = pi.product_id
    JOIN sellers s ON s.id = p.seller_id
    WHERE u.id = ? AND p.status = 'active' AND s.status = 'approved' LIMIT 1`, id);
  if (!row) throw notFound('Product image');
  return reply.bytes(row.mime, Buffer.from(row.data));
});

/** Cross-shop product discovery, keyword search, filter, and sorting with live inventory. */
route('GET', '/api/customer/products', { auth: 'public' }, (ctx) => {
  optionalCustomer(ctx);
  const pincode = ctx.query.pincode || (ctx.customer && ctx.customer.profile ? ctx.customer.profile.pincode : null);
  const q = String(ctx.query.q || '').trim().toLowerCase();
  const category = String(ctx.query.category || '').trim();
  const onlyInStock = ctx.query.in_stock === '1';
  const sort = String(ctx.query.sort || 'relevance');
  const shops = serviceableShops(pincode);
  const allowedSellers = new Map(shops.filter((s) => !pincode || s.serviceable).map((s) => [s.code, s]));
  const rows = all(`SELECT i.id AS inventory_id, i.seller_id, i.product_id, i.sku, i.on_hand, i.reserved,
      pr.code AS product_code, pr.title, pr.brand, pr.category, pr.price, pr.mrp, pr.gst_rate, pr.description,
      s.code AS shop_code, s.store_name AS shop_name,
      (SELECT pi.upload_id FROM product_images pi WHERE pi.product_id = pr.id ORDER BY pi.is_primary DESC, pi.position LIMIT 1) AS upload_id
    FROM inventory i JOIN products pr ON pr.id = i.product_id JOIN sellers s ON s.id = i.seller_id
    WHERE pr.status = 'active' AND s.status = 'approved'`);
  let list = rows
    .filter((r) => allowedSellers.has(r.shop_code))
    .map((r) => {
      const shop = allowedSellers.get(r.shop_code);
      return {
        ...productView(r),
        shop_code: r.shop_code, shop_name: r.shop_name,
        shop_area: shop.area, shop_distance_km: shop.distance_km, shop_is_open: shop.is_open,
      };
    });
  if (q) list = list.filter((p) => `${p.title} ${p.brand || ''} ${p.category || ''} ${p.shop_name}`.toLowerCase().includes(q));
  if (category) list = list.filter((p) => String(p.category || '').toLowerCase() === category.toLowerCase());
  if (onlyInStock) list = list.filter((p) => p.in_stock);
  if (sort === 'price_asc') list.sort((a, b) => a.price - b.price);
  else if (sort === 'price_desc') list.sort((a, b) => b.price - a.price);
  else if (sort === 'distance') list.sort((a, b) => (a.shop_distance_km ?? 99) - (b.shop_distance_km ?? 99));
  else list.sort((a, b) => (b.in_stock - a.in_stock) || a.title.localeCompare(b.title));
  const categories = [...new Set(list.map((p) => p.category).filter(Boolean))];
  return { pincode: pincode || null, total: list.length, categories, products: list.slice(0, 120) };
});

/** Product detail view with real stock, full description, variants, and cross-shop comparison. */
route('GET', '/api/customer/products/:code', { auth: 'public' }, (ctx) => {
  optionalCustomer(ctx);
  const pr = get(`SELECT pr.*, s.code AS shop_code, s.store_name AS shop_name, s.is_open, s.operating_hours
    FROM products pr JOIN sellers s ON s.id = pr.seller_id
    WHERE pr.code = ? AND pr.status = 'active' AND s.status = 'approved'`, ctx.params.code);
  if (!pr) throw notFound('Product');
  const invRows = all(`SELECT i.id AS inventory_id, i.seller_id, i.product_id, i.sku, i.on_hand, i.reserved,
      v.size, v.colour, COALESCE(v.price, ?) AS price
    FROM inventory i LEFT JOIN product_variants v ON v.id = i.variant_id
    WHERE i.product_id = ? ORDER BY i.id`, pr.price, pr.id);
  const images = all('SELECT upload_id FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, position', pr.id)
    .map((r) => `/api/customer/media/${r.upload_id}`);
  const pickup = get('SELECT * FROM seller_pickup_locations WHERE seller_id = ? ORDER BY is_default DESC, id LIMIT 1', pr.seller_id);
  const primary = invRows[0];
  const base = primary ? productView({
    ...primary, product_code: pr.code, title: pr.title, brand: pr.brand, category: pr.category,
    mrp: pr.mrp, gst_rate: pr.gst_rate, upload_id: all('SELECT upload_id FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, position LIMIT 1', pr.id)[0]?.upload_id || null,
  }) : null;
  const variants = invRows.map((v) => {
    const avail = Math.max(0, v.on_hand - v.reserved);
    const promo = require('./growth').promotionPrice(pr.seller_id, pr.id, v.price);
    return {
      inventory_id: v.inventory_id, sku: v.sku,
      label: [v.size, v.colour].filter(Boolean).join(' · ') || 'Standard',
      price: promo ? promo.price : v.price, base_price: v.price, available: avail, in_stock: avail > 0,
    };
  });
  // Cross-shop comparison: find similar active items in other approved shops.
  const firstWord = String(pr.title || '').split(/\s+/).find((w) => w.length >= 4) || pr.title;
  const others = all(`SELECT i.id AS inventory_id, i.seller_id, i.product_id, i.sku, i.on_hand, i.reserved,
      p2.code AS product_code, p2.title, p2.brand, p2.category, p2.price, p2.mrp, p2.gst_rate,
      s2.code AS shop_code, s2.store_name AS shop_name,
      (SELECT pi.upload_id FROM product_images pi WHERE pi.product_id = p2.id ORDER BY pi.is_primary DESC, pi.position LIMIT 1) AS upload_id
    FROM products p2 JOIN inventory i ON i.product_id = p2.id JOIN sellers s2 ON s2.id = p2.seller_id
    WHERE p2.status = 'active' AND s2.status = 'approved' AND p2.seller_id != ?
      AND (p2.category = ? OR LOWER(p2.title) LIKE ?)
    ORDER BY p2.price ASC LIMIT 8`, pr.seller_id, pr.category, `%${firstWord.toLowerCase()}%`)
    .map((r) => ({ ...productView(r), shop_code: r.shop_code, shop_name: r.shop_name }));
  return {
    product: {
      ...(base || {}),
      code: pr.code, description: pr.description || null,
      highlights: parseJson(pr.highlights, []), specs: parseJson(pr.specs, {}),
      images, variants,
      shop: {
        code: pr.shop_code, name: pr.shop_name, is_open: pr.is_open !== 0, operating_hours: pr.operating_hours || '08:00–22:00',
        area: pickup ? pickup.city : null, address: pickup ? pickup.address : null, pincode: pickup ? pickup.pincode : null,
      },
    },
    compare_offers: others,
  };
});

route('POST', '/api/customer/cart/price', { auth: 'public' }, (ctx) => {
  optionalCustomer(ctx);
  const data = validate(ctx.body, {
    items: { type: 'array', min: 1, max: MAX_LINES, required: true, label: 'products' },
    fulfilment: { enum: ['delivery', 'pickup'], default: 'delivery' },
    per_shop: { type: 'object' },
    address: { max: 200 }, pincode: { format: 'pincode' },
  });
  const profile = ctx.customer ? ensureProfile(ctx.customerId) : {};
  const pincode = data.pincode || profile.pincode;
  const address = data.address || profile.address;
  const lines = loadLines(data.items);
  const perShop = data.per_shop && typeof data.per_shop === 'object' ? data.per_shop : {};
  const shops = priceCart(lines, { pincode, fulfilment: data.fulfilment, address, perShop, allowMissingAddress: true });
  const needsAddress = shops.some((s) => s.needs_address);
  return {
    needs_address: needsAddress,
    shops: shops.map((s) => ({
      shop_code: s.shop_code, shop_name: s.shop_name, pickup_address: s.pickup_address,
      fulfilment: s.fulfilment, base_subtotal: s.base_subtotal, discount: s.discount || 0,
      subtotal: s.subtotal, delivery_fee: s.delivery_fee, distance_km: s.distance_km ?? null,
      serviceable: s.serviceable, reason: s.reason, eta_minutes: s.eta_minutes, free_delivery: s.free_delivery,
      items: s.lines.map((l) => ({
        inventory_id: l.inventory_id, product_code: l.product_code, title: l.title, qty: l.qty,
        price: l.price, base_price: l.base_price || l.price, promo: l.promo || null,
        line_total: r2(l.price * l.qty),
      })),
    })),
    totals: cartTotals(shops),
    payment_disclosure: PAYMENT_DISCLOSURE,
  };
});

/* ---------- Customer saved addresses ---------- */
route('GET', '/api/customer/addresses', { guard: requireCustomer }, (ctx) => ({
  addresses: all('SELECT * FROM customer_addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC', ctx.customerId),
}));
route('POST', '/api/customer/addresses', { guard: requireCustomer }, (ctx) => {
  const data = validate(ctx.body, {
    label: { max: 40, default: 'Home' }, recipient_name: { max: 80 }, phone: { format: 'mobile' },
    address: { required: true, min: 4, max: 200 }, landmark: { max: 120 }, area: { max: 120 },
    city: { max: 80, default: 'New Delhi' }, state: { max: 80, default: 'Delhi' },
    pincode: { required: true, format: 'pincode' }, is_default: { type: 'bool' },
  });
  const at = nowIso();
  const id = tx(() => {
    const count = get('SELECT COUNT(*) AS n FROM customer_addresses WHERE user_id = ?', ctx.customerId).n;
    const makeDefault = data.is_default || count === 0;
    if (makeDefault) run('UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?', ctx.customerId);
    const aid = insert('customer_addresses', {
      user_id: ctx.customerId, label: data.label || 'Home', recipient_name: data.recipient_name || ctx.customer.user.name,
      phone: data.phone || ctx.customer.user.mobile || null, address: data.address, landmark: data.landmark || null,
      area: data.area || null, city: data.city || 'New Delhi', state: data.state || 'Delhi', pincode: data.pincode,
      is_default: makeDefault ? 1 : 0, created_at: at, updated_at: at,
    });
    if (makeDefault) {
      ensureProfile(ctx.customerId);
      run('UPDATE customer_profiles SET address = ?, area = ?, city = ?, state = ?, pincode = ?, updated_at = ? WHERE user_id = ?',
        data.address, data.area || null, data.city || 'New Delhi', data.state || 'Delhi', data.pincode, at, ctx.customerId);
    }
    return aid;
  });
  return reply.created({ ok: true, address: get('SELECT * FROM customer_addresses WHERE id = ?', id) });
});
route('PATCH', '/api/customer/addresses/:id', { guard: requireCustomer }, (ctx) => {
  const id = Number(ctx.params.id);
  const existing = get('SELECT * FROM customer_addresses WHERE id = ? AND user_id = ?', id, ctx.customerId);
  if (!existing) throw notFound('Address');
  const data = validate(ctx.body, {
    label: { max: 40 }, recipient_name: { max: 80 }, phone: { format: 'mobile' },
    address: { min: 4, max: 200 }, landmark: { max: 120 }, area: { max: 120 },
    city: { max: 80 }, state: { max: 80 }, pincode: { format: 'pincode' }, is_default: { type: 'bool' },
  }, { partial: true });
  const at = nowIso();
  tx(() => {
    if (data.is_default) run('UPDATE customer_addresses SET is_default = 0 WHERE user_id = ?', ctx.customerId);
    const patch = { updated_at: at };
    for (const k of ['label', 'recipient_name', 'phone', 'address', 'landmark', 'area', 'city', 'state', 'pincode']) {
      if (data[k] !== undefined && data[k] !== null) patch[k] = data[k];
    }
    if (data.is_default !== undefined) patch.is_default = data.is_default ? 1 : 0;
    run(`UPDATE customer_addresses SET ${Object.keys(patch).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND user_id = ?`, ...Object.values(patch), id, ctx.customerId);
    const updated = get('SELECT * FROM customer_addresses WHERE id = ?', id);
    if (updated.is_default) {
      ensureProfile(ctx.customerId);
      run('UPDATE customer_profiles SET address = ?, area = ?, city = ?, state = ?, pincode = ?, updated_at = ? WHERE user_id = ?',
        updated.address, updated.area, updated.city, updated.state, updated.pincode, at, ctx.customerId);
    }
  });
  return { ok: true, address: get('SELECT * FROM customer_addresses WHERE id = ?', id) };
});
route('DELETE', '/api/customer/addresses/:id', { guard: requireCustomer }, (ctx) => {
  const id = Number(ctx.params.id);
  if (!run('DELETE FROM customer_addresses WHERE id = ? AND user_id = ?', id, ctx.customerId).changes) throw notFound('Address');
  return { ok: true };
});

/* ---------- Password recovery & sessions ---------- */
route('POST', '/api/customer/forgot-password', { auth: 'public' }, (ctx) => {
  const { rateLimit } = require('../auth');
  rateLimit(`cust-forgot:${ctx.ip}`, 8, 15 * 60000);
  const data = validate(ctx.body, { email: { required: true, max: 160 } });
  const user = get('SELECT * FROM users WHERE email = ?', data.email.toLowerCase());
  let resetToken = null;
  if (user) {
    resetToken = randomToken(24);
    insert('auth_tokens', {
      token_hash: sha256(resetToken), user_id: user.id, purpose: 'password_reset',
      expires_at: new Date(Date.now() + 60 * 60000).toISOString(), created_at: nowIso(),
    });
    sendMail({ to: user.email, subject: 'Reset your NearBuy password', body: `Use this code/link to reset your password: ${resetToken}`, kind: 'password_reset' });
  }
  const res = { ok: true, message: 'If an account matches that email, password reset instructions have been recorded in the mail outbox.' };
  if (resetToken && process.env.NODE_ENV !== 'production') res.reset_token = resetToken;
  return res;
});
route('POST', '/api/customer/reset-password', { auth: 'public' }, (ctx) => {
  const data = validate(ctx.body, { token: { required: true, min: 10, max: 120 }, password: { required: true, max: 200 } });
  const prob = passwordProblems(data.password);
  if (prob) throw bad('Please correct the highlighted fields.', { password: prob });
  const row = get("SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = 'password_reset' AND used_at IS NULL", sha256(data.token));
  if (!row || row.expires_at < nowIso()) throw bad('This reset token is invalid or has expired.');
  tx(() => {
    run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(data.password), row.user_id);
    run('UPDATE auth_tokens SET used_at = ? WHERE id = ?', nowIso(), row.id);
    run('DELETE FROM sessions WHERE user_id = ?', row.user_id);
  });
  return { ok: true, message: 'Password updated. You can now sign in with your new password.' };
});
route('POST', '/api/customer/change-password', { guard: requireCustomer }, (ctx) => {
  const data = validate(ctx.body, { current_password: { required: true, max: 200 }, new_password: { required: true, max: 200 } });
  const user = get('SELECT * FROM users WHERE id = ?', ctx.customerId);
  if (!verifyPassword(data.current_password, user.password_hash)) throw bad('Current password is incorrect.', { current_password: 'Incorrect password.' });
  const prob = passwordProblems(data.new_password);
  if (prob) throw bad('Please correct the highlighted fields.', { new_password: prob });
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(data.new_password), ctx.customerId);
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', ctx.customerId, ctx.customer.session.id);
  return { ok: true, message: 'Password updated and other sessions signed out.' };
});
route('GET', '/api/customer/sessions', { guard: requireCustomer }, (ctx) => ({
  sessions: all('SELECT id, user_agent, ip, created_at, last_seen_at, expires_at FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC', ctx.customerId)
    .map((s) => ({ ...s, current: s.id === ctx.customer.session.id })),
}));
route('POST', '/api/customer/sessions/revoke-others', { guard: requireCustomer }, (ctx) => {
  run('DELETE FROM sessions WHERE user_id = ? AND id != ?', ctx.customerId, ctx.customer.session.id);
  return { ok: true, message: 'Signed out all other sessions.' };
});

/* A double tap or a retried request must not place two orders: the same key returns the first answer. */
route('POST', '/api/customer/orders', { guard: requireCustomer }, (ctx) => {
  const key = String(ctx.body.request_id || ctx.req.headers['idempotency-key'] || '').slice(0, 80);
  if (key) {
    const seen = get('SELECT response FROM customer_request_keys WHERE user_id = ? AND key = ?', ctx.customerId, key);
    if (seen) return reply.created({ ...JSON.parse(seen.response), repeated: true });
    const first = checkout(ctx);
    run('INSERT OR IGNORE INTO customer_request_keys (user_id, key, response, created_at) VALUES (?, ?, ?, ?)', ctx.customerId, key, JSON.stringify(first), nowIso());
    return reply.created(first);
  }
  return reply.created(checkout(ctx));
});

route('GET', '/api/customer/orders', { guard: requireCustomer }, (ctx) => ({ orders: customerOrders(ctx.customerId) }));

route('GET', '/api/customer/orders/:code', { guard: requireCustomer }, (ctx) => ({ order: customerOrderView(findCustomerOrder(ctx.customerId, ctx.params.code)) }));

route('POST', '/api/customer/orders/:code/cancel', { guard: requireCustomer }, (ctx) => {
  const parent = findCustomerOrder(ctx.customerId, ctx.params.code);
  const data = validate(ctx.body, { reason: { max: 200 } });
  return tx(() => {
    const shops = all('SELECT * FROM orders WHERE customer_order_id = ?', parent.id);
    // The shop's acceptance is the point of no return: after it, only the shop (or operations) can cancel.
    const open = shops.filter((o) => o.status === 'new');
    if (!open.length) throw conflict('The shop has already accepted this order. Contact the shop to cancel it.');
    const { applyOrderAction } = require('./orders');
    for (const order of open) {
      applyOrderAction({
        sellerId: order.seller_id, user: { id: ctx.customerId, name: `${ctx.customer.user.name} (customer)` }, system: false,
        actor: ctx.customer.user.name,
      }, order, 'cancel', { reason: 'Customer requested cancellation', note: data.reason || undefined });
    }
    run("UPDATE customer_orders SET status = 'cancelled', updated_at = ? WHERE id = ?", nowIso(), parent.id);
    notifyCustomerUser(ctx.customerId, 'order', `Order ${parent.code} cancelled`, 'Your order was cancelled before the shop started preparing it.', `/customer/#/orders/${parent.code}`);
    return { ok: true, order: customerOrderView(findCustomerOrder(ctx.customerId, parent.code)) };
  });
});

route('POST', '/api/customer/orders/:code/shops/:orderCode/return', { guard: requireCustomer }, (ctx) => {
  const parent = findCustomerOrder(ctx.customerId, ctx.params.code);
  const order = get('SELECT * FROM orders WHERE code = ? AND customer_order_id = ?', ctx.params.orderCode, parent.id);
  if (!order) throw notFound('Shop order');
  if (order.status !== 'delivered') throw conflict('Returns can only be requested after the order is delivered.');
  const { createReturn, RETURN_REASONS } = require('./orders');
  const data = validate(ctx.body, {
    reason: { required: true, enum: RETURN_REASONS, label: 'Return reason' },
    description: { max: 400 },
    qty: { type: 'int', min: 1, max: 20 },
    order_item_id: { type: 'int' },
  });
  const item = data.order_item_id
    ? get('SELECT * FROM order_items WHERE id = ? AND order_id = ?', data.order_item_id, order.id)
    : get('SELECT * FROM order_items WHERE order_id = ? ORDER BY id LIMIT 1', order.id);
  if (!item) throw notFound('Order item');
  const qty = Math.min(item.qty, data.qty || item.qty);
  if (get('SELECT 1 FROM returns WHERE order_id = ? AND order_item_id = ?', order.id, item.id)) {
    throw conflict('A return request already exists for this item.');
  }
  const ret = tx(() => createReturn(order.seller_id, {
    order, item, qty, reason: data.reason, description: data.description || 'Customer return request via NearBuy.', isDemo: false,
  }));
  notifyCustomerUser(ctx.customerId, 'return', `Return ${ret.code} requested`, `Your return request for ${item.title} was sent to the shop.`, `/customer/#/orders/${parent.code}`);
  C().publish([`seller:${order.seller_id}`, 'admin'], { kind: 'return', code: ret.code });
  return reply.created({ ok: true, return: ret, order: customerOrderView(findCustomerOrder(ctx.customerId, parent.code)) });
});

route('POST', '/api/customer/orders/:code/shops/:orderCode/refresh-code', { guard: requireCustomer }, (ctx) => {
  const parent = findCustomerOrder(ctx.customerId, ctx.params.code);
  const order = get('SELECT * FROM orders WHERE code = ? AND customer_order_id = ?', ctx.params.orderCode, parent.id);
  if (!order) throw notFound('Shop order');
  if (['delivered', 'cancelled'].includes(order.status)) throw conflict('Order is already closed.');
  const delivery = get("SELECT * FROM deliveries WHERE order_id = ? AND kind = 'forward' AND status != 'cancelled'", order.id);
  if (delivery) {
    const refreshed = require('../delivery/engine').refreshDeliveryCode(delivery, 'drop', { type: 'customer', userId: ctx.customerId, name: ctx.customer.user.name });
    return { ok: true, delivery_code: refreshed.code, expires_at: refreshed.expires_at };
  }
  const code = C().newCode(4);
  const exp = new Date(Date.now() + C().CONFIG.codeTtlMs()).toISOString();
  run('UPDATE orders SET collection_code = ?, collection_code_expires_at = ?, updated_at = ? WHERE id = ?', code, exp, nowIso(), order.id);
  return { ok: true, collection_code: code, expires_at: exp };
});

route('POST', '/api/customer/orders/:code/issue', { guard: requireCustomer }, (ctx) => {
  const parent = findCustomerOrder(ctx.customerId, ctx.params.code);
  const S = require('../delivery/schema');
  const data = validate(ctx.body, {
    order_code: { max: 40 },
    category: { required: true, enum: Object.keys(S.COMPLAINT_CATEGORIES), label: 'Issue category' },
    subject: { required: true, min: 4, max: 120 },
    description: { required: true, min: 10, max: 600 },
  });
  const shopOrder = data.order_code
    ? get('SELECT * FROM orders WHERE code = ? AND customer_order_id = ?', data.order_code, parent.id)
    : get('SELECT * FROM orders WHERE customer_order_id = ? ORDER BY id LIMIT 1', parent.id);
  const delivery = shopOrder ? get("SELECT * FROM deliveries WHERE order_id = ? AND kind = 'forward'", shopOrder.id) : null;
  const at = nowIso();
  const code = nextCode('CMP', 4000);
  tx(() => {
    const tid = insert('delivery_tickets', {
      code, raised_by: 'customer', delivery_id: delivery ? delivery.id : null,
      partner_id: delivery ? delivery.partner_id : null, seller_id: shopOrder ? shopOrder.seller_id : null,
      category: data.category, subject: `${parent.code}: ${data.subject}`, description: data.description,
      priority: data.category === 'missing_parcel' || data.category === 'partner_conduct' ? 'high' : 'normal',
      status: 'open', created_at: at, updated_at: at,
    });
    insert('delivery_ticket_messages', {
      ticket_id: tid, author_type: 'customer', author_name: `${ctx.customer.user.name} (${ctx.customer.user.email})`, body: data.description, created_at: at,
    });
    C().notifyAdmin('complaint', `Customer issue ${code}: ${parent.code}`, data.subject, delivery ? delivery.id : null);
    if (shopOrder) {
      require('../db').notify(shopOrder.seller_id, 'order', `Customer issue ${code} on ${shopOrder.code}`, data.subject, `/seller/orders/${shopOrder.code}`);
    }
  });
  return reply.created({ ok: true, code, message: `Support issue ${code} logged with NearBuy operations.` });
});

route('GET', '/api/customer/notifications', { guard: requireCustomer }, (ctx) => ({
  notifications: all('SELECT * FROM customer_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', ctx.customerId)
    .map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: Boolean(n.read_at), at: n.created_at })),
  unread: get('SELECT COUNT(*) AS n FROM customer_notifications WHERE user_id = ? AND read_at IS NULL', ctx.customerId).n,
}));

route('POST', '/api/customer/notifications/read', { guard: requireCustomer }, (ctx) => {
  run('UPDATE customer_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), ctx.customerId);
  return { ok: true };
});
route('POST', '/api/customer/notifications/:id/read', { guard: requireCustomer }, (ctx) => {
  run('UPDATE customer_notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL', nowIso(), Number(ctx.params.id), ctx.customerId);
  return { ok: true };
});

module.exports = { ensureSchema, customerFromRequest, notifyCustomerUser, customerOrderView, ORDER_STATUS };
