'use strict';
// Demo marketplace shops.
//
// The Seller Hub seed creates one approved seller. A neighbourhood marketplace needs several shops inside the same
// delivery zone, otherwise "discover nearby shops" and a multi-shop checkout cannot be exercised at all. This module
// adds two more served shops (stationery and a general store) with their own catalogue, stock and pickup points.
// Everything it writes is flagged DEMO DATA and it never runs in production.
const { get, run, tx, insert, nextCode } = require('./db');
const { nowIso, hashPassword, encrypt } = require('./lib');
const { moveStock } = require('./stock');
const { ensureWarehouse } = require('./routes/catalog');

const DEMO_PASSWORD = 'Customer123!';

const SHOPS = [
  {
    email: 'stationery@nearbuy.demo', owner: 'Anil Kapoor', store_name: 'Kapoor Stationery House',
    business_name: 'Kapoor Stationery House', description: 'Notebooks, pens, art supplies and school essentials from the market lane.',
    phone: '9811022300', pincode: '110016', address: '7 Aurobindo Market, Hauz Khas', category: 'Stationery',
    products: [
      ['Classmate Ruled Notebook 172 Pages', 'STN-NB-01', 65, 90, 'Grocery', 240, [21, 15, 2]],
      ['Gel Pen Pack of 5 (Blue)', 'STN-PEN-02', 120, 150, 'Grocery', 90, [17, 6, 2]],
      ['A4 Drawing Sheets 50 Pack', 'STN-DRW-03', 180, 240, 'Grocery', 320, [30, 21, 1]],
      ['School Geometry Box', 'STN-GEO-04', 210, 260, 'Grocery', 260, [24, 10, 4]],
    ],
  },
  {
    email: 'general@nearbuy.demo', owner: 'Sunita Yadav', store_name: 'Yadav General Store',
    business_name: 'Yadav General Store', description: 'Daily essentials, cleaning supplies and household basics around the corner.',
    phone: '9812233400', pincode: '110016', address: '31 Hauz Khas Village Road, New Delhi', category: 'General store',
    products: [
      ['Detergent Powder 1 kg', 'GEN-DET-01', 210, 260, 'Grocery', 980, [26, 17, 9]],
      ['Dishwash Bar Pack of 4', 'GEN-DSH-02', 96, 120, 'Grocery', 410, [19, 9, 4]],
      ['Toilet Cleaner 500 ml', 'GEN-TLT-03', 145, 185, 'Grocery', 520, [24, 8, 8]],
      ['Garbage Bags Medium 30 Pieces', 'GEN-GBG-04', 130, 165, 'Grocery', 230, [22, 15, 3]],
    ],
  },
];

const seededAlready = () => SHOPS.every((s) => get('SELECT 1 FROM users WHERE email = ?', s.email));

function createShop(shop, at, zone) {
  const userId = insert('users', {
    email: shop.email, password_hash: hashPassword(DEMO_PASSWORD), name: shop.owner, mobile: shop.phone,
    email_verified_at: at, created_at: at,
  });
  const sellerId = insert('sellers', {
    code: nextCode('SLR', 5000), owner_user_id: userId, store_name: shop.store_name, business_name: shop.business_name,
    business_type: 'Sole proprietorship', status: 'approved',
    status_note: 'DEMO DATA: sample shop created as approved for the marketplace demonstration.',
    onboarding_submitted_at: at, store_description: shop.description, contact_email: shop.email, contact_phone: shop.phone,
    created_at: at,
  });
  insert('seller_team_members', { seller_id: sellerId, user_id: userId, role: 'owner', status: 'active', created_at: at });
  insert('seller_business_profiles', {
    seller_id: sellerId, legal_name: shop.business_name, business_type: 'Sole proprietorship',
    gstin: null, pan_enc: encrypt('DEMOPAN01'), pan_last4: 'AN01', address: shop.address, city: 'New Delhi',
    state: 'Delhi', pincode: shop.pincode, updated_at: at,
  });
  insert('seller_pickup_locations', {
    seller_id: sellerId, name: `${shop.store_name} counter`, contact_person: shop.owner, mobile: shop.phone,
    address: shop.address, city: 'New Delhi', state: 'Delhi', pincode: shop.pincode, is_default: 1, created_at: at,
  });
  insert('seller_bank_accounts', {
    seller_id: sellerId, holder_name: shop.business_name, bank_name: 'Demo Bank of India',
    account_enc: encrypt(`0000${sellerId}123456`), account_last4: '3456', ifsc: 'DEMO0000001',
    verification_status: 'unverified', updated_at: at,
  });
  run('UPDATE sellers SET package_settings = ? WHERE id = ?', JSON.stringify({
    default_weight_g: 500, default_length_cm: 25, default_width_cm: 20, default_height_cm: 10,
    packaging_type: 'Paper bag', fragile_handling: false,
  }), sellerId);
  const warehouse = ensureWarehouse(sellerId);
  for (const [title, sku, price, mrp, category, weight, [onHand, safety, dispatch]] of shop.products) {
    const productId = insert('products', {
      seller_id: sellerId, code: nextCode('PRD', 10000), title, category, description: `${title}. Sold by ${shop.store_name}.`,
      highlights: JSON.stringify([]), sku, specs: JSON.stringify({}), attributes: JSON.stringify({}), mrp, price,
      gst_rate: 5, package: JSON.stringify({ weight_g: weight, length_cm: 20, width_cm: 15, height_cm: 6 }),
      dispatch_days: dispatch, warehouse_id: warehouse.id, status: 'active', is_demo: 1, created_at: at, updated_at: at,
    });
    const inventoryId = insert('inventory', {
      seller_id: sellerId, product_id: productId, warehouse_id: warehouse.id, sku,
      on_hand: 0, reserved: 0, safety_stock: safety, updated_at: at,
    });
    moveStock(sellerId, inventoryId, {
      onHandDelta: onHand, kind: 'initial', reason: 'DEMO DATA: opening stock for the marketplace demonstration.',
      ref: 'demo-seed', actor: 'System', quiet: true,
    });
  }
  return sellerId;
}

const DEMO_CUSTOMER = { email: 'customer@nearbuy.demo', password: 'Customer123!', name: 'Priya Nair', mobile: '9810011122', address: 'H-12 Hauz Khas Enclave', pincode: '110016' };

/** One demo customer, so the storefront can be tried without registering. Never needed to shop. */
function seedDemoCustomer() {
  if (get('SELECT 1 FROM users WHERE email = ?', DEMO_CUSTOMER.email)) return false;
  const at = nowIso();
  tx(() => {
    const userId = insert('users', {
      email: DEMO_CUSTOMER.email, password_hash: hashPassword(DEMO_CUSTOMER.password), name: DEMO_CUSTOMER.name,
      mobile: DEMO_CUSTOMER.mobile, email_verified_at: at, created_at: at,
    });
    insert('customer_profiles', {
      user_id: userId, phone: DEMO_CUSTOMER.mobile, address: DEMO_CUSTOMER.address, area: 'Hauz Khas',
      city: 'New Delhi', state: 'Delhi', pincode: DEMO_CUSTOMER.pincode, created_at: at, updated_at: at,
    });
  });
  return true;
}

/** Add the demo shops once. Safe to call on every boot. */
function seedMarketplace() {
  const wanted = process.env.SEED_DEMO ? process.env.SEED_DEMO === '1' : process.env.NODE_ENV !== 'production';
  if (!wanted) return false;
  if (!get("SELECT 1 FROM service_zones WHERE status = 'active'")) return false;
  let created = false;
  if (!seededAlready()) {
    const at = nowIso();
    tx(() => { for (const shop of SHOPS) if (!get('SELECT 1 FROM users WHERE email = ?', shop.email)) createShop(shop, at); });
    console.log(`[nearbuy] Demo marketplace shops created (${SHOPS.map((s) => s.store_name).join(', ')}). Sign-in ${SHOPS[0].email} / ${DEMO_PASSWORD}. All records are flagged DEMO DATA.`);
    created = true;
  }
  if (seedDemoCustomer()) {
    console.log(`[nearbuy] Demo customer created (${DEMO_CUSTOMER.email} / ${DEMO_CUSTOMER.password}).`);
    created = true;
  }
  return created;
}

module.exports = { seedMarketplace, DEMO_MARKETPLACE_SHOPS: SHOPS, DEMO_SHOP_PASSWORD: DEMO_PASSWORD, DEMO_CUSTOMER };
