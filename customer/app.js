// NearBuy customer storefront.
//
// Every shop, product, price and stock number on these screens comes from the server. The only thing kept in the
// browser is the cart itself (which shop's items you picked but have not ordered yet) — orders, addresses and
// notifications are read from the API on every visit.
import '/delivery/session.js';

const root = document.getElementById('app');
const toasts = document.getElementById('toasts');
const CART_KEY = 'nb-customer-cart';

/* ---------- Tiny DOM helper ---------- */
function h(spec, props, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { children.unshift(props); props = null; }
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = `${el.className} ${value}`.trim();
    else if (key === 'html') el.innerHTML = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') el.value = value;
    else if (key === 'disabled' || key === 'checked' || key === 'required') el[key] = Boolean(value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  const add = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(add);
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(add);
  return el;
}
const money = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—');
function toast(text, kind = '') {
  const el = h(`div.toast${kind ? `.${kind}` : ''}`, text);
  toasts.append(el);
  setTimeout(() => el.remove(), 4200);
}
const mount = (node) => { root.replaceChildren(node); window.scrollTo({ top: 0 }); };

/* ---------- API ---------- */
async function api(path, { method = 'GET', body, silent = false } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  if (method !== 'GET') init.headers['X-NearBuy-Request'] = '1';
  const res = await fetch(`/api${path}`, init);
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status; err.fields = data;
    if (!silent) throw err;
    return { ok: false, error: err };
  }
  return data;
}

/* ---------- Session + cart state ---------- */
const state = { me: null, pincode: null, area: null, cart: loadCart(), shops: null, unread: 0 };
function loadCart() {
  try { const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]'); return Array.isArray(raw) ? raw : []; } catch { return []; }
}
function saveCart() { try { localStorage.setItem(CART_KEY, JSON.stringify(state.cart)); } catch { /* storage blocked */ } updateCartBadge(); }
const cartCount = () => state.cart.reduce((n, l) => n + l.qty, 0);
function addToCart(product, shop) {
  const line = state.cart.find((l) => l.inventory_id === product.inventory_id);
  const inCart = line ? line.qty : 0;
  if (inCart + 1 > product.available) { toast(`Only ${product.available} left at ${shop.name}.`, 'bad'); return; }
  if (line) line.qty += 1;
  else state.cart.push({ inventory_id: product.inventory_id, product_code: product.product_code, title: product.title, price: product.price, qty: 1, shop_code: shop.code, shop_name: shop.name });
  saveCart();
  toast(`${product.title} added to cart`, 'ok');
}
function setQty(inventoryId, qty) {
  const line = state.cart.find((l) => l.inventory_id === inventoryId);
  if (!line) return;
  line.qty = Math.max(0, qty);
  if (!line.qty) state.cart = state.cart.filter((l) => l.inventory_id !== inventoryId);
  saveCart();
  render();
}
function updateCartBadge() {
  const badge = document.getElementById('cart-count');
  if (badge) { const n = cartCount(); badge.textContent = n; badge.style.display = n ? '' : 'none'; }
}

/* ---------- Router ---------- */
const parseRoute = () => {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, query] = raw.split('?');
  return { parts: path.split('/').filter(Boolean), query: Object.fromEntries(new URLSearchParams(query || '')) };
};

/* ---------- Header + shell ---------- */
function header(active) {
  const links = [
    ['/shops', 'Shops'], ['/orders', 'My orders'], ['/account', 'Account'],
  ];
  return h('header.top', h('div.wrap.top__bar',
    h('a.brand', { href: '#/' }, h('img', { src: '/delivery/logo.svg', alt: '' }), 'NearBuy'),
    h('a.loc', { href: '#/account', title: 'Change your delivery area' },
      h('span.loc__dot'), state.pincode ? h('span', h('b', state.pincode), ' ', state.area || '') : h('span', 'Set your area')),
    h('label.search', h('span', '🔍'), h('input', { type: 'search', placeholder: 'Search shops and products', value: '', onKeydown: (e) => { if (e.key === 'Enter') { location.hash = `#/shops?q=${encodeURIComponent(e.currentTarget.value)}`; } } })),
    h('nav.top__links',
      links.map(([href, label]) => h(`a.tlink${active === href ? '.on' : ''}`, { href: `#${href}` }, label)),
      state.me
        ? h('a.tlink', { href: '#/account' }, `Hi, ${state.me.name.split(' ')[0]}`)
        : h('a.tlink', { href: '#/login' }, 'Sign in'),
      h('button.cart-btn', { type: 'button', onClick: () => { location.hash = '#/cart'; } }, '🛒 Cart', h('span.count', { id: 'cart-count' }, String(cartCount()))))));
}
const footer = () => h('footer', h('div.wrap',
  h('div', h('b', 'NearBuy'), ' · Neighbourhood commerce, delivered by the shop or a verified delivery partner.'),
  h('div.row', h('a', { href: '/seller/' }, 'Sell on NearBuy'), h('a', { href: '/runner/' }, 'Deliver with NearBuy'), h('a', { href: '/help/' }, 'Help'))));

function shell(active, ...content) {
  updateCartBadge();
  return h('div', header(active), h('main', ...content), footer());
}
const loading = (label = 'Loading…') => h('div.wrap.loading', h('span.spinner'), label);
const alertBox = (kind, text) => h(`div.banner${kind ? `.${kind}` : ''}`, text);

/* ---------- Views ---------- */
async function ensureShops() {
  if (state.shops) return state.shops;
  const data = await api(`/customer/shops${state.pincode ? `?pincode=${state.pincode}` : ''}`);
  state.shops = data;
  if (data.pincode) { state.pincode = data.pincode; state.area = data.area; }
  return data;
}

function shopCard(shop) {
  return h('a.shop', { href: `#/shop/${shop.code}` },
    h('div.shop__top',
      h('div.shop__mark', shop.name.slice(0, 1)),
      h('div.grow', h('h3', shop.name), h('div.small.muted', shop.description || 'Neighbourhood shop'))),
    h('div.shop__meta',
      h('span.pill', `${shop.products} products`),
      h('span.pill.orange', `from ${money(shop.from_price)}`),
      shop.distance_km !== null && shop.distance_km !== undefined ? h('span.pill', `${shop.distance_km} km`) : null,
      h('span.pill.green', 'Delivery available')));
}

const HOW_IT_WORKS = [
  ['1', 'Pick a local shop', 'Every product belongs to a real shop with live stock.'],
  ['2', 'Choose delivery or pickup', 'Home delivery by the shop or a NearBuy partner — or collect it free.'],
  ['3', 'Track every step', 'The shop accepts, packs and hands over. You see each update live.'],
];

function viewHome() {
  const pincodeInput = h('input', { placeholder: 'Enter your PIN code, e.g. 110016', inputmode: 'numeric', maxlength: '6', value: state.pincode || '' });
  const submit = async () => {
    const value = pincodeInput.value.replace(/\D/g, '').slice(0, 6);
    if (value.length !== 6) { toast('Enter a 6-digit PIN code.', 'bad'); return; }
    await loadShops(value, true);
    render();
  };
  const hero = h('section.hero', h('div.wrap',
    h('h1', 'Your neighbourhood market, at your door in minutes.'),
    h('p', 'Order from the shops around the corner — groceries, stationery, daily essentials. Choose home delivery or free collection at the shop counter.'),
    h('div.pin-form', pincodeInput, h('button', { type: 'button', onClick: submit }, 'Check shops')),
    h('div.hero__chips',
      h('div.hero__chip', '🏪 ', h('b', 'Local shops'), ' only'),
      h('div.hero__chip', '🛵 ', h('b', 'Verified'), ' delivery partners'),
      h('div.hero__chip', '🏬 ', h('b', 'Free'), ' store pickup'))));

  const heading = h('div.section-title',
    h('h2', state.pincode ? `Shops in ${state.area || state.pincode}` : 'Shops near you'),
    h('span.small.muted', state.pincode ? `${(state.shops && state.shops.shops.length) || 0} open now` : 'Set a PIN code to see delivery'));
  const clearArea = h('button.btn.sm', { type: 'button', onClick: () => { state.pincode = null; state.area = null; state.shops = null; render(); } }, 'Change area');
  const titleRow = h('div.row.between', heading, state.pincode ? clearArea : null);

  const shops = state.shops ? state.shops.shops : [];
  const shopList = state.shops && !shops.length
    ? h('div.empty', h('h3', 'No shops serve this PIN code yet'), h('p', 'NearBuy is launching neighbourhood by neighbourhood. Try 110016 for the Hauz Khas market.'))
    : h('div.shop-grid', shops.map(shopCard));

  const how = h('div.section-title', h('h2', 'How NearBuy works'));
  const steps = h('div.shop-grid', HOW_IT_WORKS.map(([n, title, text]) =>
    h('div.card', h('div.card__body.stack.sm', h('div.pill.blue', `Step ${n}`), h('h3', title), h('p.small.muted', text)))));

  return shell('/shops', h('div.stack.lg', hero, h('div.wrap.stack.lg', titleRow, shopList, how, steps)));
}

async function loadShops(pincode, force = false) {
  const data = await api(`/customer/shops?pincode=${pincode}`);
  if (!data.zone) { toast(`We do not deliver to ${pincode} yet.`, 'bad'); return; }
  if (!data.serviceable) { toast(`Delivery in ${data.zone} is paused right now.`, 'bad'); return; }
  state.shops = data; state.pincode = data.pincode; state.area = data.area;
  if (force && state.me) api('/customer/profile', { method: 'PATCH', body: { pincode: data.pincode } }).catch(() => {});
}

async function viewShop(code) {
  const data = await api(`/customer/shops/${code}`);
  const cats = ['All', ...data.categories];
  const active = new URLSearchParams(location.hash.split('?')[1] || '').get('cat') || 'All';
  const products = active === 'All' ? data.products : data.products.filter((p) => p.category === active);
  const body = h('div.stack.lg',
    h('div.wrap.stack.lg',
      h('a.small', { href: '#/shops' }, '← All shops'),
      h('section.shop-hero', h('div.shop-hero__mark', data.shop.name.slice(0, 1)),
        h('div.grow.stack.sm', h('h1', data.shop.name), h('p.small.muted', data.shop.description || ''),
          h('div.row', h('span.pill.green', 'Open now'), h('span.pill', `${data.shop.products} products in stock`), data.shop.address ? h('span.pill', data.shop.address) : null))),
      h('div.cats', cats.map((c) => h(`button.chip${c === active ? '.on' : ''}`, { type: 'button', onClick: () => { location.hash = `#/shop/${code}?cat=${encodeURIComponent(c)}`; } }, c))),
      products.length
        ? h('div.product-grid', products.map((p) => h('div.product',
          h('div.product__title', p.title),
          h('div.product__price', h('b', money(p.price)), p.mrp ? h('s', money(p.mrp)) : null),
          h('div.row', h('span.pill', p.category || 'General'), p.brand ? h('span.pill', p.brand) : null),
          h('div.product__stock', p.available > 5 ? `${p.available} in stock` : `Only ${p.available} left`),
          h('button.btn.orange.block', { type: 'button', disabled: p.available <= 0, onClick: () => addToCart(p, data.shop) }, 'Add to cart'))))
        : h('div.empty', h('h3', 'Nothing here yet'), h('p', 'This shop has no products in this category right now.'))));
  return shell('/shops', body);
}

async function viewCart() {
  if (!state.cart.length) {
    return shell('/cart', h('div.wrap', h('div.empty', h('h3', 'Your cart is empty'), h('p', 'Add items from a nearby shop and they will appear here.'), h('a.btn.primary', { href: '#/shops' }, 'Browse shops'))));
  }
  const shopCodes = [...new Set(state.cart.map((l) => l.shop_code))];
  const fulfilment = state.fulfilment || 'delivery';
  const address = state.address || (state.me && state.me.address) || { line: '', pincode: state.pincode || '', area: '' };
  const quote = await api('/customer/cart/price', { method: 'POST', body: { items: state.cart.map((l) => ({ inventory_id: l.inventory_id, qty: l.qty })), fulfilment, address: address.line, pincode: address.pincode } });
  const shopNames = new Map(quote.shops.map((s) => [s.shop_code, s.shop_name]));
  const totals = quote.totals;

  const addressCard = h('div.card', h('div.card__body',
    h('div.row.between', h('h2', 'Delivery address'), h('span.pill.blue', fulfilment === 'pickup' ? 'Not needed for pickup' : 'Needed')),
    h('div.field-grid', h('div.field', h('label', 'House / flat and street'),
      h('input', { value: address.line || '', placeholder: 'H-12 Hauz Khas Enclave', onInput: (e) => { address.line = e.target.value; } })),
      h('div.field', h('label', 'PIN code'), h('input', { value: address.pincode || '', maxlength: '6', inputmode: 'numeric', placeholder: '110016', onInput: (e) => { address.pincode = e.target.value.replace(/\D/g, ''); } }))),
    quote.needs_address ? h('div.small.muted', 'Enter your address and PIN code to see the delivery fee for each shop.') : null));

  // One request id per checkout attempt: a double tap or a retry returns the same order instead of making two.
  const requestId = `co-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const place = h('button.btn.orange.block', { type: 'button' }, `Place order · ${money(totals.total)}`);
  place.addEventListener('click', async () => {
    place.disabled = true; place.textContent = 'Placing your order…';
    try {
      const res = await api('/customer/orders', { method: 'POST', body: {
        items: state.cart.map((l) => ({ inventory_id: l.inventory_id, qty: l.qty })), fulfilment,
        address: address.line, pincode: address.pincode, payment: 'cod',
        name: state.me ? state.me.name : undefined, request_id: requestId,
      } });
      state.cart = []; saveCart();
      toast(`Order ${res.order.code} placed`, 'ok');
      location.hash = `#/orders/${res.order.code}`;
    } catch (err) {
      toast(err.message, 'bad');
      place.disabled = false; place.textContent = `Place order · ${money(totals.total)}`;
    }
  });

  const body = h('div.wrap.stack.lg',
    h('div.section-title', h('h2', 'Your cart'), h('span.small.muted', `${cartCount()} item${cartCount() === 1 ? '' : 's'} from ${shopCodes.length} shop${shopCodes.length === 1 ? '' : 's'}`)),
    h('div.two-col',
      h('div.stack',
        quote.shops.map((shop) => h('div.card',
          h('div.card__head', h('div.shop__mark', { style: 'width:34px;height:34px;font-size:13px;border-radius:9px' }, shop.shop_name.slice(0, 1)), h('h2', shop.shop_name), h('span.pill', `${shop.items.length} item${shop.items.length === 1 ? '' : 's'}`)),
          h('div.card__body',
            shop.items.map((item) => h('div.cart-line',
              h('div.grow', h('div.strong', item.title), h('div.small.muted', `${money(item.price)} each`)),
              h('div.qty', h('button', { type: 'button', onClick: () => setQty(item.inventory_id, item.qty - 1) }, '−'), h('span', String(item.qty)), h('button', { type: 'button', onClick: () => setQty(item.inventory_id, item.qty + 1) }, '+')),
              h('b', { style: 'min-width:74px;text-align:right' }, money(item.line_total)))),
            h('div.money', h('span.muted', 'Shop subtotal'), h('b', money(shop.subtotal))),
            h('div.money', h('span.muted', shop.free_delivery ? 'Store pickup' : 'Delivery fee'), h('b', shop.free_delivery ? 'Free' : money(shop.delivery_fee))),
            !shop.serviceable ? alertBox('warn', shop.reason) : null,
            shop.eta_minutes ? h('div.small.muted', `Estimated ${shop.free_delivery ? 'ready for collection' : 'delivery'} in about ${shop.eta_minutes} minutes.`) : null))),
        !quote.needs_address && quote.shops.some((s) => !s.serviceable) ? alertBox('bad', 'One of these shops cannot deliver to your PIN code. Choose store pickup or change the address.') : null),
      h('div.stack',
        h('div.card', h('div.card__body',
          h('div.row.between', h('h2', 'How to receive it'), null),
          h('div.seg', { style: 'margin:12px 0' },
            h(`button${fulfilment === 'delivery' ? '.on' : ''}`, { type: 'button', onClick: () => { state.fulfilment = 'delivery'; render(); } }, 'Home delivery'),
            h(`button${fulfilment === 'pickup' ? '.on' : ''}`, { type: 'button', onClick: () => { state.fulfilment = 'pickup'; render(); } }, 'Store pickup')),
          h('p.small.muted', fulfilment === 'pickup' ? 'Collect from each shop counter. Store pickup is always free — the shop will tell you when it is ready and you will get a collection code.' : 'The shop packs your order and either delivers it directly or hands it to a verified NearBuy delivery partner.'))),
        addressCard,
        h('div.card', h('div.card__body.stack.sm',
          h('h2', 'Order summary'),
          h('div.money', h('span.muted', 'Items'), h('b', money(totals.subtotal))),
          h('div.money', h('span.muted', fulfilment === 'pickup' ? 'Pickup' : 'Delivery'), h('b', totals.delivery_total ? money(totals.delivery_total) : 'Free')),
          h('div.money.total', h('span', 'Total'), h('b', money(totals.total))),
          h('div.small.muted', 'Pay cash when you receive the order. No card details are stored.'),
          place,
          state.me ? null : h('a.btn.block', { href: '#/login' }, 'Sign in to place the order')))
      )));
  return shell('/cart', body);
}

async function viewOrders() {
  if (!state.me) return shell('/orders', h('div.wrap', h('div.empty', h('h3', 'Sign in to see your orders'), h('p', 'Your orders, collection codes and delivery updates live in your NearBuy account.'), h('a.btn.primary', { href: '#/login' }, 'Sign in'))));
  const data = await api('/customer/orders');
  const body = h('div.wrap.stack',
    h('div.section-title', h('h2', 'My orders'), h('span.small.muted', `${data.orders.length} order${data.orders.length === 1 ? '' : 's'}`)),
    data.orders.length ? data.orders.map((o) => h('a.order-card', { href: `#/orders/${o.code}`, style: 'display:block;text-decoration:none' },
      h('div.order-card__head',
        h('div.grow', h('b', o.code), h('div.small.muted', `${when(o.placed_at)} · ${o.shops.length} shop${o.shops.length === 1 ? '' : 's'}`)),
        h('span', { class: `pill ${o.status === 'delivered' ? 'green' : o.status === 'cancelled' ? 'red' : 'blue'}` }, o.status_label),
        h('b', money(o.total))),
      o.shops.map((s) => h('div.order-shop',
        h('div.order-shop__head', h('b.strong', s.shop), h('span.pill', s.fulfilment === 'pickup' ? 'Store pickup' : s.delivery && s.delivery.partner ? `Partner: ${s.delivery.partner.name}` : 'Home delivery'), h('span.pill', s.status_label), h('span.small.muted', `${s.item_count} item(s) · ${money(s.total)}`))))) )
      : h('div.empty', h('h3', 'No orders yet'), h('p', 'Order from a nearby shop and follow it here, step by step.'), h('a.btn.primary', { href: '#/shops' }, 'Browse shops')));
  return shell('/orders', body);
}

async function viewOrder(code) {
  if (!state.me) { location.hash = '#/login'; return loading(); }
  const { order } = await api(`/customer/orders/${code}`);
  const stepLabel = { new: 'Placed', pending_confirmation: 'Accepted by the shop', processing: 'Preparing', packed: 'Packed', ready_to_ship: 'Ready', shipped: 'On the way', delivered: 'Delivered', cancelled: 'Cancelled' };
  const flow = ['new', 'pending_confirmation', 'processing', 'packed', 'ready_to_ship', 'shipped', 'delivered'];
  const body = h('div.wrap.stack.lg',
    h('a.small', { href: '#/orders' }, '← All orders'),
    h('div.row.between',
      h('div', h('h1', `Order ${order.code}`), h('div.small.muted', `Placed ${when(order.placed_at)} · ${order.payment_method}`)),
      h('span', { class: `pill ${order.status === 'delivered' ? 'green' : order.status === 'cancelled' ? 'red' : 'blue'}`, style: 'font-size:13px;padding:7px 13px' }, order.status_label)),
    order.shops.map((shop) => {
      const at = flow.indexOf(shop.status);
      return h('div.card',
        h('div.card__head', h('div.grow', h('h2', shop.shop), h('div.small.muted', `${shop.item_count} item(s) · ${shop.fulfilment === 'pickup' ? 'Store pickup · free' : 'Home delivery'} · ${money(shop.total)}`)),
          h('span', { class: `pill ${shop.status === 'delivered' ? 'green' : shop.status === 'cancelled' ? 'red' : 'blue'}` }, shop.status_label)),
        h('div.card__body.stack',
          h('div', shop.items.map((i) => h('div.row.between.small', h('span', `${i.qty} × ${i.title}`), h('b', money(i.line_total))))),
          shop.collection_code
            ? h('div.stack.sm',
              h('div.small.strong', shop.code_label === 'Delivery code' ? 'Read this delivery code to the shop when they arrive' : 'Show this collection code at the shop counter'),
              h('div.code-box', String(shop.collection_code).split('').join(' ')),
              h('div.tiny.muted', 'The shop confirms this code before the order is closed. Do not share it before the hand-over.'))
            : null,
          shop.delivery && shop.delivery.partner
            ? alertBox('ok', [`Delivery partner: ${shop.delivery.partner.name}.`, h('a', { href: shop.delivery.track_url, target: '_blank', rel: 'noopener' }, ' Open live tracking →')])
            : shop.fulfilment === 'delivery' && ['new', 'pending_confirmation', 'processing'].includes(shop.status)
              ? alertBox('', 'Waiting for the shop to pack this order. A delivery partner is assigned once it is ready.') : null,
          h('div.steps', flow.map((key, i) => h(`div.step${i < at ? '.done' : i === at ? (shop.status === 'delivered' ? '.done' : '.now') : ''}`,
            h('div.step__dot'), h('div.step__text', h('b', stepLabel[key]), i === at ? h('span', 'Current step') : null)))),
          shop.cancellable ? h('div.row', h('button.btn.sm', { type: 'button', onClick: async () => {
            if (!confirm('Cancel this shop order? The shop has not started preparing it yet.')) return;
            try { await api(`/customer/orders/${order.code}/cancel`, { method: 'POST', body: {} }); toast('Order cancelled', 'ok'); render(); }
            catch (err) { toast(err.message, 'bad'); }
          } }, 'Cancel this shop order')) : null,
          shop.timeline && shop.timeline.length ? h('details', h('summary.small.muted', 'Order history'), h('ul.tl', { style: 'margin-top:10px' }, shop.timeline.map((e) => h('li', h('div', h('b', e.title), h('div', h('span', when(e.at), e.note ? ` · ${e.note}` : ''))))))) : null));
    }),
    order.address ? h('div.card', h('div.card__body', h('h2', 'Delivery address'), h('p.small.muted', `${order.address.line}, ${order.address.city || ''} ${order.address.pincode}`))) : null,
    h('div.card', h('div.card__body',
      h('div.money', h('span.muted', 'Items'), h('b', money(order.subtotal))),
      h('div.money', h('span.muted', 'Delivery'), h('b', order.delivery_total ? money(order.delivery_total) : 'Free')),
      h('div.money.total', h('span', 'Total'), h('b', money(order.total))),
      h('div.tiny.muted', { style: 'margin-top:8px' }, 'This is the receipt for every shop in your order. Each shop fulfils its own items.'))));
  return shell('/orders', body);
}

function viewAuth(mode) {
  const fields = {};
  const errors = h('div');
  const submit = h(`button.btn.orange.block${mode === 'register' ? '' : ''}`, { type: 'button' }, mode === 'register' ? 'Create my account' : 'Sign in');
  const run = async () => {
    submit.disabled = true; submit.textContent = 'Please wait…';
    errors.replaceChildren();
    try {
      const body = mode === 'register'
        ? { name: fields.name.value, email: fields.email.value, password: fields.password.value, mobile: fields.mobile.value || undefined, pincode: fields.pincode && fields.pincode.value || undefined, address: fields.address && fields.address.value || undefined }
        : { email: fields.email.value, password: fields.password.value };
      const res = await api(`/customer/${mode === 'register' ? 'register' : 'login'}`, { method: 'POST', body });
      state.me = res.customer;
      if (res.customer.address && res.customer.address.pincode) { state.pincode = res.customer.address.pincode; }
      state.shops = null;
      toast(`Welcome, ${res.customer.name.split(' ')[0]}`, 'ok');
      const back = new URLSearchParams(location.search).get('next') || '#/shops';
      location.hash = back;
    } catch (err) {
      errors.replaceChildren(alertBox('bad', err.message));
      if (err.fields) errors.append(h('div.small.muted', 'Check the highlighted fields.'));
      submit.disabled = false; submit.textContent = mode === 'register' ? 'Create my account' : 'Sign in';
    }
  };
  submit.addEventListener('click', run);
  const field = (key, label, attrs = {}) => { const input = h('input', { ...attrs, onKeydown: (e) => { if (e.key === 'Enter') run(); } }); fields[key] = input; return h('div.field', h('label', label), input); };
  const body = h('div.auth', h('div.auth__card.stack',
    h('div', h('h1', mode === 'register' ? 'Create your NearBuy account' : 'Sign in to NearBuy'),
      h('p.small.muted', mode === 'register' ? 'One account for shopping, order history and delivery updates.' : 'Use the email address you signed up with.')),
    errors,
    mode === 'register' ? field('name', 'Full name', { placeholder: 'Priya Nair', autocomplete: 'name' }) : null,
    field('email', 'Email address', { type: 'email', placeholder: 'you@example.com', autocomplete: 'email' }),
    field('password', 'Password', { type: 'password', placeholder: mode === 'register' ? 'At least 8 characters' : 'Your password', autocomplete: mode === 'register' ? 'new-password' : 'current-password' }),
    mode === 'register' ? field('mobile', 'Mobile number (optional)', { placeholder: '98100 11122', inputmode: 'numeric', autocomplete: 'tel' }) : null,
    mode === 'register' ? h('div.field-grid', field('pincode', 'PIN code (optional)', { placeholder: '110016', maxlength: '6', inputmode: 'numeric' }), field('address', 'Address (optional)', { placeholder: 'H-12 Hauz Khas Enclave' })) : null,
    submit,
    h('p.auth__alt', mode === 'register'
      ? ['Already have an account? ', h('a', { href: '#/login' }, 'Sign in')]
      : ['New to NearBuy? ', h('a', { href: '#/register' }, 'Create an account')])));
  return shell('', body);
}

async function viewAccount() {
  if (!state.me) return viewAuth('login');
  const profile = state.me;
  const address = profile.address || { line: '', area: '', city: '', pincode: '' };
  const fields = {};
  const save = h('button.btn.primary', { type: 'button' }, 'Save changes');
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const res = await api('/customer/profile', { method: 'PATCH', body: {
        name: fields.name.value, mobile: fields.mobile.value || undefined, address: fields.address.value || undefined,
        pincode: fields.pincode.value || undefined, city: fields.city.value || undefined,
      } });
      state.me = res.customer; state.shops = null;
      toast('Profile saved', 'ok');
    } catch (err) { toast(err.message, 'bad'); }
    save.disabled = false;
  });
  const notifications = await api('/customer/notifications').catch(() => ({ notifications: [], unread: 0 }));
  const profileCard = h('div.card',
    h('div.card__head', h('h2', 'Profile and delivery address')),
    h('div.card__body',
      h('div.field', h('label', 'Full name'), h('input', { value: profile.name, onInput: (e) => { fields.name = e.target; } })),
      h('div.field-grid',
        h('div.field', h('label', 'Mobile number'), h('input', { value: profile.mobile || '', onInput: (e) => { fields.mobile = e.target; } })),
        h('div.field', h('label', 'PIN code'), h('input', { value: address.pincode || '', maxlength: '6', onInput: (e) => { fields.pincode = e.target; } }))),
      h('div.field', h('label', 'Address'), h('input', { value: address.line || '', onInput: (e) => { fields.address = e.target; } })),
      h('div.field', h('label', 'City'), h('input', { value: address.city || 'New Delhi', onInput: (e) => { fields.city = e.target; } })),
      h('div.row', save, h('span.small.muted', `Signed in as ${profile.email}`))));
  const notificationList = notifications.notifications.length
    ? h('ul.tl', notifications.notifications.map((n) => h('li', h('div', h('b', n.title), h('div.small.muted', `${when(n.at)}${n.body ? ` · ${n.body}` : ''}`)))))
    : h('p.small.muted', 'Order updates will appear here.');
  const notificationsCard = h('div.card',
    h('div.card__head', h('h2', 'Notifications'), h('span.pill', `${notifications.unread} new`)),
    h('div.card__body', notificationList));
  const explainCard = h('div.card', h('div.card__body.stack.sm',
    h('h2', 'How NearBuy fulfils your order'),
    h('p.small.muted', 'Each shop in your order decides how it delivers: it may deliver itself, or hand the package to a verified NearBuy delivery partner. You always see which shop chose what, and the delivery code that confirms receipt.')));
  const helpCard = h('div.card', h('div.card__body.stack.sm',
    h('h2', 'Need help?'),
    h('p.small.muted', 'Report a problem on any order from its page, or contact the shop through the tracking link of its delivery.'),
    h('a.btn.block', { href: '#/orders' }, 'Go to my orders')));
  const title = h('div.row.between',
    h('h1', 'Your account'),
    h('button.btn.sm', { type: 'button', onClick: async () => {
      await api('/customer/logout', { method: 'POST', body: {} });
      state.me = null; state.cart = []; saveCart(); location.hash = '#/';
    } }, 'Sign out'));
  const body = h('div.wrap.stack.lg',
    title,
    h('div.two-col',
      h('div.stack', profileCard, notificationsCard),
      h('div.stack', explainCard, helpCard)));
  return shell('/account', body);
}

/* ---------- Render ---------- */
let busy = false;
async function render() {
  if (busy) return;
  busy = true;
  const { parts, query } = parseRoute();
  try {
    let node;
    if (!parts.length) { mount(shell('', loading())); node = viewHome(); await ensureShops().catch(() => {}); node = viewHome(); }
    else if (parts[0] === 'shops') { node = await (async () => { await ensureShops().catch(() => {}); return viewHome(); })(); }
    else if (parts[0] === 'shop') { mount(shell('', loading())); node = await viewShop(parts[1]); }
    else if (parts[0] === 'cart') { mount(shell('', loading())); node = await viewCart(); }
    else if (parts[0] === 'orders' && !parts[1]) { mount(shell('', loading())); node = await viewOrders(); }
    else if (parts[0] === 'orders' && parts[1]) { mount(shell('', loading())); node = await viewOrder(parts[1]); }
    else if (parts[0] === 'account') { mount(shell('', loading())); node = await viewAccount(); }
    else if (parts[0] === 'login') node = viewAuth('login');
    else if (parts[0] === 'register') node = viewAuth('register');
    else node = viewHome();
    mount(await node);
  } catch (err) {
    mount(shell('', h('div.wrap', err.status === 401
      ? h('div.empty', h('h3', 'Please sign in'), h('p', err.message), h('a.btn.primary', { href: '#/login' }, 'Sign in'))
      : h('div.empty', h('h3', 'Something went wrong'), h('p', err.message), h('button.btn', { type: 'button', onClick: () => render() }, 'Try again')))));
  } finally { busy = false; }
}

/* ---------- Boot ---------- */
(async () => {
  try {
    const me = await api('/customer/me', { silent: true });
    if (me && me.customer) { state.me = me.customer; state.unread = me.unread || 0; if (me.customer.address && me.customer.address.pincode) state.pincode = state.pincode || me.customer.address.pincode; }
  } catch { /* signed out */ }
  window.addEventListener('hashchange', () => render());
  render();
})();
