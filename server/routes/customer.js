'use strict';
// Customer accounts, the neighbourhood marketplace and checkout.
//
// This module connects a real customer to the systems that already existed: the Seller Hub order ledger and the
// delivery network. It never keeps a second copy of an order — a customer checkout writes one `customer_orders` row
// (the customer's receipt) and one `orders` row per shop, and the shop order is the same record the seller works on.
const { route, reply } = require('../router');
const { get, all, run, tx, insert, nextCode, db } = require('../db');
const {
  HttpError, bad, notFound, conflict, nowIso, r2, validate, sha256, randomToken, hashPassword, verifyPassword,
  passwordProblems,
} = require('../lib');

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
    CREATE INDEX IF NOT EXISTS idx_customer_orders_user ON customer_orders (user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_customer_notif_user ON customer_notifications (user_id, created_at);
  `);
  // The shop order carries the customer's receipt and the fulfilment that was agreed for that shop.
  addColumn('orders', 'customer_order_id', 'INTEGER');
  addColumn('orders', 'fulfilment', "TEXT NOT NULL DEFAULT 'delivery'");
  addColumn('orders', 'delivery_mode', "TEXT NOT NULL DEFAULT 'network'");
  addColumn('orders', 'collection_code', 'TEXT');
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
}

/* ---------- Views ---------- */
const shopView = (seller, extra = {}) => ({
  code: seller.code, name: seller.store_name, description: seller.store_description || null,
  category: extra.category || null, rating: extra.rating || null, ...extra,
});
function productView(row) {
  const available = Math.max(0, row.on_hand - row.reserved);
  return {
    inventory_id: row.inventory_id, product_code: row.product_code, title: row.title, brand: row.brand || null,
    category: row.category, price: row.price, mrp: row.mrp && row.mrp > row.price ? row.mrp : null, sku: row.sku,
    unit: row.unit || null, gst_rate: row.gst_rate, available, package: row.package_text || null,
    image: `/public/assets/discover-${String(row.category || '').toLowerCase()}.jpg`,
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
                    WHERE i.seller_id = s.id AND pr.status = 'active' AND (i.on_hand - i.reserved) > 0))
    ORDER BY s.store_name`);
  return sellers.map((seller) => {
    const pickup = get('SELECT * FROM seller_pickup_locations WHERE seller_id = ? ORDER BY is_default DESC, id LIMIT 1', seller.id);
    const counts = get(`SELECT COUNT(*) AS listed, COALESCE(MIN(pr.price), 0) AS from_price
      FROM inventory i JOIN products pr ON pr.id = i.product_id
      WHERE i.seller_id = ? AND pr.status = 'active' AND (i.on_hand - i.reserved) > 0`, seller.id);
    let distance_km = null;
    let serviceable = false;
    if (!zone) serviceable = true;
    else if (pickup && C().geocode(pickup.address, pickup.pincode)) {
      const from = C().geocode(pickup.address, pickup.pincode);
      if (from.zone.id === zone.zone.id) {
        distance_km = r2(C().roadKm(from.lat, from.lng, zone.lat, zone.lng));
        serviceable = distance_km <= from.zone.max_delivery_km;
      }
    }
    return shopView(seller, {
      area: pickup ? pickup.city : null, pincode: pickup ? pickup.pincode : null, distance_km,
      products: counts.listed, from_price: counts.from_price, serviceable,
      pickup_point: pickup ? pickup.name : null,
    });
  });
}

function shopCatalogue(code) {
  const seller = get("SELECT * FROM sellers WHERE code = ? AND status = 'approved'", code);
  if (!seller) throw notFound('Shop');
  const rows = all(`SELECT i.id AS inventory_id, i.sku, i.on_hand, i.reserved, pr.code AS product_code, pr.title, pr.brand,
      pr.category, pr.price, pr.mrp, pr.gst_rate, pr.package
    FROM inventory i JOIN products pr ON pr.id = i.product_id
    WHERE i.seller_id = ? AND pr.status = 'active' AND (i.on_hand - i.reserved) > 0
    ORDER BY pr.category, pr.title`, seller.id);
  const products = rows.map((r) => productView({ ...r, package_text: null }));
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const pickup = get('SELECT * FROM seller_pickup_locations WHERE seller_id = ? ORDER BY is_default DESC, id LIMIT 1', seller.id);
  return {
    shop: shopView(seller, {
      area: pickup ? pickup.city : null, pincode: pickup ? pickup.pincode : null, address: pickup ? pickup.address : null,
      products: products.length, categories,
    }),
    products, categories,
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
    const row = get(`SELECT i.id AS inventory_id, i.sku, i.on_hand, i.reserved, i.seller_id, pr.code AS product_code, pr.title,
        pr.category, pr.price, pr.mrp, pr.gst_rate
      FROM inventory i JOIN products pr ON pr.id = i.product_id
      WHERE i.id = ? AND pr.status = 'active'`, id);
    if (!row) throw conflict('One of the products in your cart is no longer available.');
    const available = row.on_hand - row.reserved;
    if (qty > available) throw conflict(`Only ${Math.max(0, available)} × ${row.title} left at this shop. Reduce the quantity to continue.`);
    rows.push({ ...row, qty });
  }
  return rows;
}

/** Group cart lines per shop and price each shop's delivery or pickup. Nothing is written. */
function priceCart(lines, { pincode, fulfilment = 'delivery', address }) {
  const bySeller = new Map();
  for (const line of lines) {
    if (!bySeller.has(line.seller_id)) bySeller.set(line.seller_id, []);
    bySeller.get(line.seller_id).push(line);
  }
  const shops = [];
  for (const [sellerId, sellerLines] of bySeller) {
    const seller = get("SELECT * FROM sellers WHERE id = ? AND status = 'approved'", sellerId);
    if (!seller) throw conflict('One of the shops in your cart is not accepting orders right now.');
    const subtotal = r2(sellerLines.reduce((sum, l) => sum + l.price * l.qty, 0));
    const shop = { seller_id: sellerId, shop_code: seller.code, shop_name: seller.store_name, lines: sellerLines, subtotal, fulfilment, delivery_fee: 0, free_delivery: false, eta_minutes: null, serviceable: true, reason: null };
    if (fulfilment === 'pickup') {
      shop.delivery_fee = 0;
      shop.free_delivery = true;
      shop.eta_minutes = 15;
    } else {
      if (!pincode || !address) throw bad('Add a delivery address and PIN code to see the delivery fee.');
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
  const delivery_total = r2(shops.reduce((sum, s) => sum + s.delivery_fee, 0));
  return { subtotal, delivery_total, total: r2(subtotal + delivery_total) };
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
  if (fulfilment === 'delivery' && (!address || !pincode)) throw bad('Choose a delivery address and PIN code before placing the order.', { address: 'Add a delivery address.' });
  const perShop = data.per_shop && typeof data.per_shop === 'object' ? data.per_shop : {};
  const shops = priceCart(lines, { pincode, fulfilment, address });
  const blocked = shops.filter((s) => !s.serviceable);
  if (blocked.length) throw conflict(`${blocked[0].shop_name} cannot deliver to ${pincode}: ${blocked[0].reason}`);
  // A per-shop override lets the customer collect one shop's items and have another shop deliver.
  for (const shop of shops) {
    const override = perShop[shop.shop_code] || perShop[shop.seller_id];
    if (override && override !== shop.fulfilment && ['delivery', 'pickup'].includes(override)) {
      if (override === 'delivery' && fulfilment === 'pickup') {
        const E = require('../delivery/engine');
        const svc = E.serviceability(shop.seller_id, address, pincode);
        if (!svc.ok) throw conflict(`${shop.shop_name} cannot deliver to ${pincode}: ${svc.reason}`);
      }
      shop.fulfilment = override;
      if (override === 'pickup') { shop.delivery_fee = 0; shop.eta_minutes = 15; shop.free_delivery = true; }
    }
  }
  const totals = cartTotals(shops);
  const code = nextCode('CNB', 9000);
  const at = nowIso();
  return tx(() => {
    const { createOrder } = require('./orders');
    const customerOrderId = insert('customer_orders', {
      code, user_id: ctx.customerId, status: 'placed', payment_method: data.payment === 'cod' ? 'Cash on delivery' : 'Prepaid',
      payment_status: data.payment === 'cod' ? 'cod_pending' : 'paid', subtotal: totals.subtotal,
      delivery_total: totals.delivery_total, total: totals.total,
      address: fulfilment === 'delivery' ? address : null, area: data.area || profile.area || null,
      city: data.city || profile.city || null, state: profile.state || 'Delhi',
      pincode: fulfilment === 'delivery' ? pincode : null, is_demo: 0, created_at: at, updated_at: at,
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
        isDemo: false, applyPromotions: true,
      });
      const collectionCode = shop.fulfilment === 'pickup' ? C().newCode(4) : null;
      const shipping = shop.fulfilment === 'pickup' ? 0 : shop.delivery_fee;
      run(`UPDATE orders SET customer_order_id = ?, fulfilment = ?, delivery_mode = ?, collection_code = ?,
          shipping_charge = ?, total = ?, ship_address = COALESCE(?, ship_address), ship_pincode = COALESCE(?, ship_pincode),
          updated_at = ? WHERE id = ?`,
      customerOrderId, shop.fulfilment, shop.fulfilment === 'pickup' ? 'none' : 'network', collectionCode,
      shipping, r2(order.subtotal + shipping), shop.fulfilment === 'pickup' ? null : address,
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
      ok: true, order: { code, total: totals.total, subtotal: totals.subtotal, delivery_total: totals.delivery_total },
      shops: placed.map(({ order, shop }) => ({
        shop: shop.shop_name, shop_code: shop.shop_code, order_code: order.code, fulfilment: shop.fulfilment,
        delivery_fee: shop.fulfilment === 'pickup' ? 0 : shop.delivery_fee, total: shop.subtotal,
        collection_code: shop.fulfilment === 'pickup' ? get('SELECT collection_code FROM orders WHERE id = ?', order.id).collection_code : null,
        delivery: get("SELECT code, track_token, status FROM deliveries WHERE order_id = ? AND kind = 'forward'", order.id) || null,
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
      ? get('SELECT p.code, u.name, p.rating_sum, p.rating_count FROM delivery_partners p JOIN users u ON u.id = p.user_id WHERE p.id = ?', delivery.partner_id) : null;
    const items = all('SELECT title, qty, unit_price, line_total FROM order_items WHERE order_id = ? ORDER BY id', o.id);
    const view = {
      order_code: o.code, shop: o.store_name, shop_code: o.shop_code, status: o.status,
      status_label: ORDER_STATUS[o.status] || o.status, fulfilment: o.fulfilment, delivery_mode: o.delivery_mode,
      payment_method: o.payment_method, payment_status: o.payment_status, subtotal: o.subtotal, shipping: o.shipping_charge,
      total: o.total, placed_at: o.placed_at, delivery_fee: o.shipping_charge, item_count: items.reduce((n, i) => n + i.qty, 0),
      items,
    };
    if (o.fulfilment === 'pickup') {
      view.collection_code = o.status === 'cancelled' || o.status === 'delivered' ? null : o.collection_code;
      view.code_label = 'Collection code';
      view.eta = o.status === 'new' ? 'Waiting for the shop to confirm' : o.status === 'delivered' ? 'Collected' : 'Ready to collect once packed';
    } else if (o.delivery_mode === 'self') {
      // The shop is delivering itself, so the customer's code is what confirms the hand-over.
      view.collection_code = o.status === 'cancelled' || o.status === 'delivered' ? null : o.collection_code;
      view.code_label = 'Delivery code';
      view.eta = o.status === 'new' ? 'Waiting for the shop to confirm' : 'The shop delivers this order itself';
    }
    if (delivery) {
      view.delivery = {
        code: delivery.code, status: delivery.status,
        status_label: require('../delivery/core').label(delivery.status),
        eta_at: delivery.eta_at, partner: partner ? { name: partner.name, code: partner.code } : null,
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
      view.cancellable = o.status === 'new';
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
    subtotal: parent.subtotal, delivery_total: parent.delivery_total, total: parent.total,
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

route('POST', '/api/customer/cart/price', { auth: 'public' }, (ctx) => {
  optionalCustomer(ctx);
  const data = validate(ctx.body, {
    items: { type: 'array', min: 1, max: MAX_LINES, required: true, label: 'products' },
    fulfilment: { enum: ['delivery', 'pickup'], default: 'delivery' },
    address: { max: 200 }, pincode: { format: 'pincode' },
  });
  const profile = ctx.customer ? ensureProfile(ctx.customerId) : {};
  const pincode = data.pincode || profile.pincode;
  const address = data.address || profile.address;
  const lines = loadLines(data.items);
  const shops = data.fulfilment === 'delivery' && (!pincode || !address) ? [] : priceCart(lines, { pincode, fulfilment: data.fulfilment, address });
  return {
    needs_address: data.fulfilment === 'delivery' && (!pincode || !address),
    shops: shops.map((s) => ({
      shop_code: s.shop_code, shop_name: s.shop_name, subtotal: s.subtotal, delivery_fee: s.delivery_fee,
      serviceable: s.serviceable, reason: s.reason, eta_minutes: s.eta_minutes, free_delivery: s.free_delivery,
      items: s.lines.map((l) => ({ inventory_id: l.inventory_id, title: l.title, qty: l.qty, price: l.price, line_total: r2(l.price * l.qty) })),
    })),
    totals: cartTotals(shops),
  };
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

route('GET', '/api/customer/notifications', { guard: requireCustomer }, (ctx) => ({
  notifications: all('SELECT * FROM customer_notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50', ctx.customerId)
    .map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: Boolean(n.read_at), at: n.created_at })),
  unread: get('SELECT COUNT(*) AS n FROM customer_notifications WHERE user_id = ? AND read_at IS NULL', ctx.customerId).n,
}));

route('POST', '/api/customer/notifications/read', { guard: requireCustomer }, (ctx) => {
  run('UPDATE customer_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', nowIso(), ctx.customerId);
  return { ok: true };
});

module.exports = { ensureSchema, customerFromRequest, notifyCustomerUser, customerOrderView, ORDER_STATUS };
