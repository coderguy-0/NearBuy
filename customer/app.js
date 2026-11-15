// NearBuy Customer Storefront — connected to the unified NearBuy backend.
// Every shop, stock count, price, promotion, delivery quote, order, return, and tracking update comes from the server.
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, attrs = {}, ...children) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return n;
};
const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const initials = (name) => String(name || 'NB').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

async function api(method, path, body) {
  const headers = { 'X-NearBuy-Client': 'customer' };
  if (method !== 'GET' && method !== 'HEAD') headers['X-NearBuy-Request'] = '1';
  const opts = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status; err.fields = data && data.fields;
    throw err;
  }
  return data;
}

function toast(msg, kind = '') {
  const box = $('#toasts');
  if (!box) return;
  const item = el('div', { class: `toast ${kind}` }, msg);
  box.append(item);
  setTimeout(() => item.remove(), 4200);
}

/* ---------- Cart (client-side UI draft; stock & totals always validated by the server) ---------- */
const CART_KEY = 'nearbuy_cart_v2';
function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((i) => Number.isInteger(i.inventory_id) && i.qty > 0) : [];
  } catch { return []; }
}
function saveCart(items) { localStorage.setItem(CART_KEY, JSON.stringify(items)); }
const cartCount = () => state.cart.reduce((n, i) => n + i.qty, 0);
function addToCart(product, shop, delta = 1) {
  const max = Math.max(0, Number(product.available || 0));
  if (max <= 0) { toast(`${product.title} is currently out of stock.`, 'bad'); return; }
  const idx = state.cart.findIndex((i) => i.inventory_id === product.inventory_id);
  const cur = idx > -1 ? state.cart[idx].qty : 0;
  const next = cur + delta;
  if (next > max) { toast(`Only ${max} left at ${shop.name}.`, 'bad'); return; }
  if (next <= 0) { if (idx > -1) state.cart.splice(idx, 1); }
  else if (idx > -1) state.cart[idx].qty = next;
  else state.cart.push({ inventory_id: product.inventory_id, product_code: product.product_code, qty: next, title: product.title, price: product.price, shop_code: shop.code, shop_name: shop.name });
  saveCart(state.cart);
  renderHeader();
  if (delta > 0) toast(`Added ${product.title} to your cart`, 'ok');
}
function setCartQty(inventoryId, next) {
  const idx = state.cart.findIndex((i) => i.inventory_id === inventoryId);
  if (idx === -1) return;
  if (next <= 0) state.cart.splice(idx, 1);
  else state.cart[idx].qty = Math.min(20, next);
  saveCart(state.cart);
  renderHeader();
}

/* ---------- App state & SSE ---------- */
const state = {
  customer: null,
  unread: 0,
  pincode: localStorage.getItem('nearbuy_pincode') || '110016',
  cart: loadCart(),
  fulfilment: 'delivery',
  perShop: {},
  payment: 'cod',
  draftAddress: '',
  draftInstructions: '',
  sse: null,
  checkoutKey: null,
};

function connectRealtime() {
  if (state.sse) { state.sse.close(); state.sse = null; }
  if (!state.customer) return;
  try {
    const es = new EventSource('/api/realtime?portal=customer');
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data || '{}');
        if (msg.kind === 'ping') return;
        state.unread += 1;
        renderHeader();
        if (msg.title) toast(msg.title, 'ok');
        else if (msg.kind === 'order' || msg.kind === 'delivery') toast('Your order status was updated.', 'ok');
        const hash = location.hash.slice(1) || '/';
        if (hash.startsWith('/orders') || hash.startsWith('/notifications')) route();
      } catch {}
    };
    state.sse = es;
  } catch {}
}

async function refreshSession() {
  try {
    const me = await api('GET', '/api/customer/me');
    state.customer = me.customer;
    state.unread = me.unread || 0;
    if (me.customer.address && me.customer.address.pincode) {
      state.pincode = me.customer.address.pincode;
      localStorage.setItem('nearbuy_pincode', state.pincode);
    }
    if (me.customer.address && me.customer.address.line && !state.draftAddress) {
      state.draftAddress = me.customer.address.line;
    }
    connectRealtime();
  } catch {
    state.customer = null;
    state.unread = 0;
    if (state.sse) { state.sse.close(); state.sse = null; }
  }
}

/* ---------- Header & Shell ---------- */
function renderHeader() {
  const header = $('header.hdr');
  if (!header) return;
  const searchInput = el('input', { type: 'search', placeholder: 'Search groceries, stationery, daily essentials or shops…', 'aria-label': 'Search products and shops' });
  const searchForm = el('form', {
    class: 'search',
    onsubmit: (e) => {
      e.preventDefault();
      const q = searchInput.value.trim();
      location.hash = q ? `#/search?q=${encodeURIComponent(q)}` : '#/search';
    },
  },
  searchInput,
  el('button', { type: 'submit', class: 'btn sm primary' }, 'Search'));

  const inner = el('div', { class: 'wrap hdr__in' },
    el('a', { class: 'brand', href: '#/' },
      el('img', { src: '/delivery/logo.svg', alt: '', width: 32, height: 32 }),
      el('span', {}, 'Near', el('em', {}, 'Buy')),
    ),
    el('button', { class: 'pin-btn', type: 'button', onclick: openPinPrompt, title: 'Change delivery PIN code' },
      el('span', { class: 'dot' }),
      el('span', {}, state.pincode ? `PIN ${state.pincode}` : 'Set PIN code'),
    ),
    searchForm,
    el('nav', { class: 'nav' },
      el('a', { href: '#/' }, 'Shops'),
      el('a', { href: '#/search' }, 'Products'),
      el('a', { href: '#/orders' }, 'My orders'),
      el('a', { href: '#/cart' }, 'Cart', cartCount() ? el('span', { class: 'count' }, cartCount()) : null),
      state.customer
        ? [
          el('a', { href: '#/notifications' }, 'Alerts', state.unread ? el('span', { class: 'count' }, state.unread) : null),
          el('a', { href: '#/account' }, state.customer.name.split(' ')[0]),
        ]
        : el('a', { href: '#/login', class: 'btn sm primary' }, 'Sign in'),
    ),
  );
  header.replaceChildren(inner);
}

function openPinPrompt() {
  const next = window.prompt('Enter your 6-digit delivery PIN code (Delhi neighbourhood zones, e.g. 110016):', state.pincode || '');
  if (!next) return;
  const clean = next.trim();
  if (!/^\d{6}$/.test(clean)) { toast('Enter a 6-digit PIN code.', 'bad'); return; }
  state.pincode = clean;
  localStorage.setItem('nearbuy_pincode', clean);
  renderHeader();
  route();
}

function renderShell(mainNode) {
  const root = $('#app');
  if (!root.firstChild) {
    root.append(
      el('header', { class: 'hdr' }),
      el('main', { id: 'view' }),
      el('footer', {},
        el('div', { class: 'wrap' },
          el('div', {}, el('strong', { style: 'color:#fff' }, 'NearBuy'), ' — Neighbourhood commerce across your local shops.'),
          el('div', { class: 'row' },
            el('a', { href: '/' }, 'Main site'),
            el('a', { href: '/seller/' }, 'Seller Hub'),
            el('a', { href: '/runner/' }, 'NearBuy Runner'),
            el('a', { href: '/control-tower/' }, 'Operations'),
          ),
        ),
      ),
    );
  }
  renderHeader();
  $('#view').replaceChildren(mainNode);
  window.scrollTo(0, 0);
}

const loading = (text = 'Loading…') => el('div', { class: 'wrap loading' }, el('span', { class: 'spinner' }), text);

function productCard(p, shopObj) {
  const inCart = state.cart.find((i) => i.inventory_id === p.inventory_id);
  const shop = shopObj || { code: p.shop_code, name: p.shop_name };
  const thumb = el('a', { class: 'product__thumb', href: `#/product/${encodeURIComponent(p.product_code)}` },
    p.image ? el('img', { src: p.image, alt: p.title, loading: 'lazy' }) : el('span', {}, initials(p.title)),
  );
  const stockLabel = !p.in_stock || p.available <= 0
    ? el('span', { class: 'pill bad' }, 'Out of stock')
    : el('span', { class: 'product__stock' }, `${p.available} in stock${p.shop_name && !shopObj ? ` · ${p.shop_name}` : ''}${p.shop_distance_km != null ? ` (${p.shop_distance_km} km)` : ''}`);
  let cta;
  if (!p.in_stock || p.available <= 0) {
    cta = el('button', { class: 'btn block', type: 'button', disabled: true }, 'Out of stock');
  } else if (inCart) {
    cta = el('div', { class: 'qty', style: 'margin-top:auto;justify-content:space-between;width:100%' },
      el('button', { type: 'button', onclick: () => { addToCart(p, shop, -1); route(); } }, '−'),
      el('span', {}, `${inCart.qty} in cart`),
      el('button', { type: 'button', onclick: () => { addToCart(p, shop, 1); route(); } }, '+'),
    );
  } else {
    cta = el('button', { class: 'btn primary block', type: 'button', onclick: () => { addToCart(p, shop, 1); route(); } }, 'Add to cart');
  }
  return el('article', { class: 'product' },
    thumb,
    el('div', { class: 'row' },
      el('span', { class: 'badge' }, p.category || 'Local'),
      p.promo ? el('span', { class: 'pill orange' }, `Save ${inr(p.promo.savings)}`) : null,
    ),
    el('a', { class: 'product__title', href: `#/product/${encodeURIComponent(p.product_code)}` }, p.title),
    el('div', { class: 'product__price' },
      el('b', {}, inr(p.price)),
      p.mrp ? el('s', {}, inr(p.mrp)) : null,
    ),
    stockLabel,
    cta,
  );
}

/* ---------- Home / Discovery ---------- */
async function viewHome() {
  renderShell(loading('Checking neighbourhood shops near you…'));
  try {
    const [shopData, prodData] = await Promise.all([
      api('GET', `/api/customer/shops${state.pincode ? `?pincode=${encodeURIComponent(state.pincode)}` : ''}`),
      api('GET', `/api/customer/products?in_stock=1${state.pincode ? `&pincode=${encodeURIComponent(state.pincode)}` : ''}`),
    ]);
    const banner = el('section', { class: 'hero' },
      el('div', { class: 'wrap hero__in' },
        el('div', { class: 'hero__copy' },
          el('h1', {}, 'Neighbourhood shops, ', el('em', {}, 'live inventory')),
          el('p', {}, 'Order groceries, stationery and daily essentials from verified shops nearby. Choose home delivery or free store pickup — never silently switched.'),
          el('div', { class: 'hero__meta' },
            shopData.zone
              ? el('span', { class: 'pill ok' }, `Serving ${shopData.area || shopData.pincode} · ${shopData.zone}`)
              : state.pincode ? el('span', { class: 'pill warn' }, `PIN ${state.pincode} is outside current delivery zones`) : null,
            el('button', { class: 'btn sm', type: 'button', onclick: openPinPrompt }, 'Change PIN code'),
            el('a', { class: 'btn sm orange', href: '#/search' }, 'Browse all products'),
          ),
        ),
      ),
    );

    const wrap = el('div', { class: 'wrap' });
    if (state.pincode && shopData.serviceable === false) {
      wrap.append(el('div', { class: 'banner warn', style: 'margin-top:20px' },
        `Delivery is currently paused for ${shopData.zone || state.pincode}. You can still browse or switch PIN codes.`));
    }
    if (!shopData.shops.length) {
      wrap.append(el('div', { class: 'empty', style: 'margin-top:24px' },
        el('h3', {}, state.pincode ? `No shops currently deliver to PIN ${state.pincode}` : 'No shops found'),
        el('p', {}, 'NearBuy currently operates in South Delhi neighbourhood zones (try 110016, 110017, 110024 or 110048) or open a shop in Seller Hub.'),
        el('div', { class: 'row', style: 'justify-content:center' },
          el('button', { class: 'btn primary', type: 'button', onclick: () => { state.pincode = '110016'; localStorage.setItem('nearbuy_pincode', '110016'); renderHeader(); route(); } }, 'Try South Delhi (110016)'),
          el('a', { class: 'btn', href: '/seller/' }, 'List your shop'),
        ),
      ));
    } else {
      wrap.append(
        el('div', { class: 'sec-head' },
          el('div', {}, el('h2', {}, 'Shops near you'), el('p', {}, `${shopData.shops.length} active neighbourhood shop${shopData.shops.length === 1 ? '' : 's'} with real-time stock`)),
        ),
        el('div', { class: 'shop-grid' }, ...shopData.shops.map((s) =>
          el('a', { class: 'shop', href: `#/shop/${encodeURIComponent(s.code)}` },
            el('div', { class: 'shop__top' },
              el('div', { class: 'shop__mark' }, initials(s.name)),
              el('div', {},
                el('div', { class: 'row' },
                  el('h3', {}, s.name),
                  el('span', { class: `pill ${s.is_open ? 'ok' : 'bad'}` }, s.is_open ? 'Open' : 'Closed'),
                ),
                el('p', { class: 'muted' }, [s.category, s.area, s.distance_km != null ? `${s.distance_km} km away` : null].filter(Boolean).join(' · ')),
              ),
            ),
            s.description ? el('p', { class: 'shop__desc' }, s.description) : null,
            el('div', { class: 'shop__meta' },
              el('span', {}, `${s.products} items in stock`),
              el('span', {}, s.from_price ? `From ${inr(s.from_price)}` : ''),
              el('span', {}, 'Free store pickup'),
            ),
          ))),
      );

      if (prodData.products && prodData.products.length) {
        wrap.append(
          el('div', { class: 'sec-head' },
            el('div', {}, el('h2', {}, 'Available nearby right now'), el('p', {}, 'Live shelf stock across your local shops — click any item to compare shops or add to cart')),
            el('a', { class: 'btn sm', href: '#/search' }, 'See all →'),
          ),
          el('div', { class: 'product-grid' }, ...prodData.products.slice(0, 8).map((p) => productCard(p))),
        );
      }
    }
    renderShell(el('div', {}, banner, wrap));
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Cross-Shop Search & Browse ---------- */
async function viewSearch(queryString) {
  const params = new URLSearchParams(queryString || '');
  const q = params.get('q') || '';
  const category = params.get('category') || '';
  const sort = params.get('sort') || 'relevance';
  const inStockOnly = params.get('in_stock') === '1';
  renderShell(loading('Searching nearby shops…'));
  try {
    const qs = new URLSearchParams();
    if (state.pincode) qs.set('pincode', state.pincode);
    if (q) qs.set('q', q);
    if (category) qs.set('category', category);
    if (sort) qs.set('sort', sort);
    if (inStockOnly) qs.set('in_stock', '1');
    const data = await api('GET', `/api/customer/products?${qs.toString()}`);

    const updateFilter = (patch) => {
      const next = new URLSearchParams({ q, category, sort, ...(inStockOnly ? { in_stock: '1' } : {}), ...patch });
      for (const [k, v] of [...next.entries()]) if (!v) next.delete(k);
      location.hash = `#/search?${next.toString()}`;
    };

    const qInput = el('input', { type: 'search', value: q, placeholder: 'Filter by product name, brand, or shop…', style: 'min-width:220px;flex:1' });
    const sortSel = el('select', { onchange: (e) => updateFilter({ sort: e.target.value }) },
      el('option', { value: 'relevance', selected: sort === 'relevance' }, 'Sort: Relevance'),
      el('option', { value: 'price_asc', selected: sort === 'price_asc' }, 'Price: Low to High'),
      el('option', { value: 'price_desc', selected: sort === 'price_desc' }, 'Price: High to Low'),
      el('option', { value: 'distance', selected: sort === 'distance' }, 'Nearest shop first'),
    );
    const stockCheck = el('label', { class: 'row', style: 'font-size:13px;cursor:pointer' },
      el('input', { type: 'checkbox', checked: inStockOnly, onchange: (e) => updateFilter({ in_stock: e.target.checked ? '1' : '' }) }),
      'In stock only',
    );

    const wrap = el('div', { class: 'wrap', style: 'padding-top:24px' },
      el('div', { class: 'sec-head', style: 'margin-top:0' },
        el('div', {},
          el('h1', {}, q ? `Results for “${q}”` : 'Browse neighbourhood products'),
          el('p', {}, `${data.total} product${data.total === 1 ? '' : 's'} across served shops${state.pincode ? ` for PIN ${state.pincode}` : ''}`),
        ),
        el('a', { class: 'btn sm', href: '#/' }, '← All shops'),
      ),
      el('form', {
        class: 'card row', style: 'padding:14px;margin-bottom:16px',
        onsubmit: (e) => { e.preventDefault(); updateFilter({ q: qInput.value.trim() }); },
      },
      qInput,
      sortSel,
      stockCheck,
      el('button', { class: 'btn primary sm', type: 'submit' }, 'Apply'),
      ),
      el('div', { class: 'cats' },
        el('button', { class: `chip ${!category ? 'on' : ''}`, type: 'button', onclick: () => updateFilter({ category: '' }) }, 'All categories'),
        ...(data.categories || []).map((c) => el('button', { class: `chip ${category === c ? 'on' : ''}`, type: 'button', onclick: () => updateFilter({ category: c }) }, c)),
      ),
      data.products.length
        ? el('div', { class: 'product-grid' }, ...data.products.map((p) => productCard(p)))
        : el('div', { class: 'empty' },
          el('h3', {}, 'No matching products'),
          el('p', {}, 'Try clearing filters, searching a different term, or switching PIN code.'),
          el('button', { class: 'btn primary', type: 'button', onclick: () => { location.hash = '#/search'; } }, 'Reset search'),
        ),
    );
    renderShell(wrap);
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Shop Page ---------- */
async function viewShop(code, selectedCat = '') {
  renderShell(loading('Loading shop catalogue…'));
  try {
    const data = await api('GET', `/api/customer/shops/${encodeURIComponent(code)}`);
    const shop = data.shop;
    const filtered = selectedCat ? data.products.filter((p) => p.category === selectedCat) : data.products;

    const wrap = el('div', { class: 'wrap', style: 'padding-top:22px' },
      el('a', { href: '#/', class: 'muted', style: 'font-size:13px' }, '← Back to all shops'),
      el('div', { class: 'shop-hero', style: 'margin-top:12px' },
        el('div', { class: 'shop-hero__mark' }, initials(shop.name)),
        el('div', {},
          el('div', { class: 'row' },
            el('h1', {}, shop.name),
            el('span', { class: `pill ${shop.is_open ? 'ok' : 'bad'}` }, shop.is_open ? 'Open now' : 'Currently closed'),
          ),
          el('p', { class: 'muted' }, [shop.address, shop.area, shop.pincode, `Hours: ${shop.operating_hours}`].filter(Boolean).join(' · ')),
          shop.description ? el('p', { style: 'margin-top:6px' }, shop.description) : null,
          el('div', { class: 'row', style: 'margin-top:8px' },
            el('span', { class: 'pill ok' }, 'Free store pickup (₹0)'),
            el('span', { class: 'pill' }, 'Home delivery available'),
          ),
        ),
      ),
      data.categories.length > 1 ? el('div', { class: 'cats' },
        el('button', { class: `chip ${!selectedCat ? 'on' : ''}`, type: 'button', onclick: () => viewShop(code, '') }, `All (${data.products.length})`),
        ...data.categories.map((c) => el('button', { class: `chip ${selectedCat === c ? 'on' : ''}`, type: 'button', onclick: () => viewShop(code, c) }, c)),
      ) : null,
      filtered.length
        ? el('div', { class: 'product-grid' }, ...filtered.map((p) => productCard(p, shop)))
        : el('div', { class: 'empty' }, el('h3', {}, 'No items in stock in this category')),
      data.out_of_stock && data.out_of_stock.length
        ? el('section', { style: 'margin-top:30px' },
          el('h3', { style: 'margin-bottom:12px;color:var(--muted)' }, `Currently out of stock (${data.out_of_stock.length})`),
          el('div', { class: 'product-grid' }, ...data.out_of_stock.map((p) => productCard(p, shop))),
        )
        : null,
    );
    renderShell(wrap);
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Product Detail & Cross-Shop Comparison ---------- */
async function viewProduct(code) {
  renderShell(loading('Loading product details…'));
  try {
    const data = await api('GET', `/api/customer/products/${encodeURIComponent(code)}`);
    const p = data.product;
    let selectedVariant = p.variants && p.variants[0] ? p.variants[0] : { inventory_id: p.inventory_id, label: 'Standard', price: p.price, available: p.available, in_stock: p.in_stock };

    const wrap = el('div', { class: 'wrap', style: 'padding-top:22px' });
    const renderBody = () => {
      wrap.replaceChildren(
        el('div', { class: 'row', style: 'margin-bottom:14px;font-size:13px' },
          el('a', { href: '#/' }, 'Shops'),
          el('span', { class: 'muted' }, '/'),
          el('a', { href: `#/shop/${encodeURIComponent(p.shop.code)}` }, p.shop.name),
          el('span', { class: 'muted' }, '/'),
          el('span', { class: 'muted' }, p.title),
        ),
        el('div', { class: 'pdp' },
          el('div', { class: 'pdp__media' },
            p.images && p.images[0] ? el('img', { src: p.images[0], alt: p.title }) : el('span', {}, initials(p.title)),
          ),
          el('div', { class: 'stack' },
            el('div', { class: 'row' },
              el('span', { class: 'badge' }, p.category),
              p.brand ? el('span', { class: 'pill' }, p.brand) : null,
              el('span', { class: `pill ${selectedVariant.in_stock ? 'ok' : 'bad'}` }, selectedVariant.in_stock ? `${selectedVariant.available} in stock` : 'Out of stock'),
            ),
            el('h1', {}, p.title),
            el('div', { class: 'product__price' },
              el('b', { style: 'font-size:26px' }, inr(selectedVariant.price)),
              p.mrp && p.mrp > selectedVariant.price ? el('s', {}, inr(p.mrp)) : null,
              el('span', { class: 'muted', style: 'font-size:12px' }, `Incl. ${p.gst_rate}% GST`),
            ),
            p.variants && p.variants.length > 1
              ? el('div', {},
                el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:6px' }, 'Choose option:'),
                el('div', { class: 'row' }, ...p.variants.map((v) => el('button', {
                  type: 'button',
                  class: `chip ${v.inventory_id === selectedVariant.inventory_id ? 'on' : ''}`,
                  onclick: () => { selectedVariant = v; renderBody(); },
                }, `${v.label} · ${inr(v.price)}`))),
              )
              : null,
            el('div', { class: 'card pad stack' },
              el('div', { class: 'row', style: 'justify-content:space-between' },
                el('div', {},
                  el('strong', {}, p.shop.name),
                  el('div', { class: 'muted', style: 'font-size:12.5px' }, [p.shop.address, p.shop.area, p.shop.pincode].filter(Boolean).join(', ')),
                ),
                el('a', { class: 'btn sm', href: `#/shop/${encodeURIComponent(p.shop.code)}` }, 'Visit shop'),
              ),
              el('div', { class: 'row' },
                el('span', { class: 'pill ok' }, 'Free store pickup (₹0)'),
                el('span', { class: 'pill' }, 'Home delivery via shop or NearBuy Runner'),
              ),
              selectedVariant.in_stock
                ? el('div', { class: 'row' },
                  el('button', {
                    class: 'btn primary', type: 'button',
                    onclick: () => addToCart({ ...p, inventory_id: selectedVariant.inventory_id, price: selectedVariant.price, available: selectedVariant.available, in_stock: true }, p.shop, 1),
                  }, 'Add to cart'),
                  el('a', { class: 'btn orange', href: '#/cart' }, 'Go to cart'),
                )
                : el('div', { class: 'banner warn' }, 'This item is currently out of stock at this shop. Check similar offers below or browse other local shops.'),
            ),
            p.description ? el('div', {}, el('h3', { style: 'margin-bottom:6px' }, 'About this item'), el('p', { class: 'muted' }, p.description)) : null,
            p.highlights && p.highlights.length ? el('ul', { style: 'padding-left:18px;color:var(--muted);font-size:13.5px' }, ...p.highlights.map((h) => el('li', {}, h))) : null,
          ),
        ),
        data.compare_offers && data.compare_offers.length
          ? el('section', { style: 'margin-top:34px' },
            el('h2', { style: 'margin-bottom:12px' }, 'Compare at other nearby shops'),
            el('div', { class: 'product-grid' }, ...data.compare_offers.map((o) => productCard(o))),
          )
          : null,
      );
    };
    renderBody();
    renderShell(wrap);
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Cart & Multi-Shop Checkout ---------- */
async function viewCart() {
  if (!state.cart.length) {
    renderShell(el('div', { class: 'wrap', style: 'padding:40px 0' },
      el('div', { class: 'empty' },
        el('h2', {}, 'Your cart is empty'),
        el('p', {}, 'Add groceries, stationery or essentials from one or more local shops. NearBuy splits multi-shop carts cleanly into per-shop orders.'),
        el('a', { class: 'btn primary', href: '#/' }, 'Browse nearby shops'),
      ),
    ));
    return;
  }
  renderShell(loading('Checking live stock and delivery quotes…'));
  let savedAddresses = [];
  if (state.customer) {
    try { savedAddresses = (await api('GET', '/api/customer/addresses')).addresses || []; } catch {}
  }
  const addressLine = state.draftAddress || (state.customer && state.customer.address && state.customer.address.line) || (savedAddresses[0] && savedAddresses[0].address) || '';
  const pincode = state.pincode || (state.customer && state.customer.address && state.customer.address.pincode) || (savedAddresses[0] && savedAddresses[0].pincode) || '110016';
  state.draftAddress = addressLine;

  let quote = null;
  let quoteErr = null;
  try {
    quote = await api('POST', '/api/customer/cart/price', {
      items: state.cart.map((i) => ({ inventory_id: i.inventory_id, qty: i.qty })),
      fulfilment: state.fulfilment,
      per_shop: state.perShop,
      address: addressLine || undefined,
      pincode: /^\d{6}$/.test(pincode) ? pincode : undefined,
    });
  } catch (err) {
    quoteErr = err.message;
  }

  const addrInput = el('input', { type: 'text', value: addressLine, placeholder: 'House/Flat no., Street, Locality (e.g. H-12 Hauz Khas Enclave)' });
  const pinInput = el('input', { type: 'text', value: pincode, maxlength: 6, placeholder: '6-digit PIN code' });
  const instrInput = el('input', { type: 'text', value: state.draftInstructions, placeholder: 'Optional delivery note (e.g. Ring bell twice)' });

  const applyAddress = () => {
    state.draftAddress = addrInput.value.trim();
    const p = pinInput.value.trim();
    if (/^\d{6}$/.test(p)) { state.pincode = p; localStorage.setItem('nearbuy_pincode', p); }
    state.draftInstructions = instrInput.value.trim();
    renderHeader();
    viewCart();
  };

  const left = el('div', { class: 'stack' },
    quoteErr ? el('div', { class: 'banner bad' }, quoteErr) : null,
    el('div', { class: 'card pad stack' },
      el('div', { class: 'row', style: 'justify-content:space-between' },
        el('div', {}, el('h3', {}, 'Default fulfilment'), el('p', { class: 'muted', style: 'font-size:12.5px' }, 'You can also override delivery vs. free pickup per shop below.')),
        el('div', { class: 'seg' },
          el('button', { class: state.fulfilment === 'delivery' ? 'on' : '', type: 'button', onclick: () => { state.fulfilment = 'delivery'; state.perShop = {}; viewCart(); } }, 'Home delivery'),
          el('button', { class: state.fulfilment === 'pickup' ? 'on' : '', type: 'button', onclick: () => { state.fulfilment = 'pickup'; state.perShop = {}; viewCart(); } }, 'Free store pickup (₹0)'),
        ),
      ),
      savedAddresses.length
        ? el('div', { class: 'row' },
          el('span', { class: 'muted', style: 'font-size:12px' }, 'Saved addresses:'),
          ...savedAddresses.map((a) => el('button', {
            type: 'button', class: 'chip',
            onclick: () => { state.draftAddress = a.address; state.pincode = a.pincode; localStorage.setItem('nearbuy_pincode', a.pincode); viewCart(); },
          }, `${a.label} (${a.pincode})`)),
        )
        : null,
      el('div', { class: 'field-grid' },
        el('div', { class: 'field' }, el('label', {}, 'Delivery address'), addrInput),
        el('div', { class: 'field' }, el('label', {}, 'Delivery PIN code'), pinInput),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Delivery instructions'), instrInput),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm primary', type: 'button', onclick: applyAddress }, 'Update address & recalculate quote'),
      ),
    ),
    ...(quote && quote.shops ? quote.shops.map((s) =>
      el('div', { class: 'card pad stack' },
        el('div', { class: 'row', style: 'justify-content:space-between' },
          el('div', {},
            el('h3', {}, s.shop_name),
            el('span', { class: 'muted', style: 'font-size:12px' },
              s.fulfilment === 'pickup'
                ? `Free store pickup · ${s.pickup_address || 'Shop counter'}`
                : s.serviceable ? `Delivery · ${s.distance_km != null ? `${s.distance_km} km · ` : ''}~${s.eta_minutes} min · ${inr(s.delivery_fee)}` : (s.reason || 'Not serviceable'),
            ),
          ),
          el('div', { class: 'seg' },
            el('button', { class: s.fulfilment === 'delivery' ? 'on' : '', type: 'button', onclick: () => { state.perShop[s.shop_code] = 'delivery'; viewCart(); } }, 'Delivery'),
            el('button', { class: s.fulfilment === 'pickup' ? 'on' : '', type: 'button', onclick: () => { state.perShop[s.shop_code] = 'pickup'; viewCart(); } }, 'Pickup ₹0'),
          ),
        ),
        !s.serviceable ? el('div', { class: 'banner warn' }, `${s.reason || 'Delivery unavailable for this address.'} You can enter a served address above or explicitly choose Free Store Pickup for this shop.`) : null,
        ...s.items.map((it) =>
          el('div', { class: 'cart-line' },
            el('div', { style: 'flex:1' },
              el('strong', {}, it.title),
              el('div', { class: 'muted', style: 'font-size:12px' }, `${inr(it.price)} each${it.promo ? ` · ${it.promo.name}` : ''}`),
            ),
            el('div', { class: 'qty' },
              el('button', { type: 'button', onclick: () => { setCartQty(it.inventory_id, it.qty - 1); viewCart(); } }, '−'),
              el('span', {}, it.qty),
              el('button', { type: 'button', onclick: () => { setCartQty(it.inventory_id, it.qty + 1); viewCart(); } }, '+'),
            ),
            el('strong', { style: 'min-width:68px;text-align:right' }, inr(it.line_total)),
          )),
        el('div', { class: 'money' }, el('span', {}, 'Shop subtotal'), el('b', {}, inr(s.subtotal))),
        s.discount > 0 ? el('div', { class: 'money', style: 'color:var(--green)' }, el('span', {}, 'Promotion savings'), el('b', {}, `−${inr(s.discount)}`)) : null,
        el('div', { class: 'money' }, el('span', {}, s.fulfilment === 'pickup' ? 'Store pickup fee' : 'Delivery fee'), el('b', {}, s.fulfilment === 'pickup' ? 'FREE (₹0)' : inr(s.delivery_fee))),
      )) : []),
  );

  const canPlace = Boolean(state.customer && quote && quote.shops.length && quote.shops.every((s) => s.serviceable));
  const placeBtn = el('button', {
    class: 'btn orange block', type: 'button', disabled: !canPlace,
    onclick: async () => {
      if (!state.customer) { location.hash = '#/login?next=/cart'; return; }
      placeBtn.disabled = true; placeBtn.textContent = 'Placing order…';
      try {
        if (!state.checkoutKey) state.checkoutKey = `chk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const placed = await api('POST', '/api/customer/orders', {
          items: state.cart.map((i) => ({ inventory_id: i.inventory_id, qty: i.qty })),
          fulfilment: state.fulfilment,
          per_shop: state.perShop,
          payment: state.payment,
          address: addrInput.value.trim() || undefined,
          pincode: pinInput.value.trim() || undefined,
          instructions: instrInput.value.trim() || undefined,
          request_id: state.checkoutKey,
        });
        state.cart = []; saveCart([]);
        state.perShop = {};
        state.checkoutKey = null;
        renderHeader();
        toast(`Order ${placed.order.code} placed!`, 'ok');
        location.hash = `#/orders/${placed.order.code}`;
      } catch (err) {
        toast(err.message, 'bad');
        placeBtn.disabled = false; placeBtn.textContent = `Place order · ${inr(quote ? quote.totals.total : 0)}`;
      }
    },
  }, state.customer ? `Place order · ${inr(quote ? quote.totals.total : 0)}` : 'Sign in to place order');

  const right = el('aside', { class: 'card pad stack', style: 'position:sticky;top:82px' },
    el('h3', {}, 'Order summary'),
    quote ? [
      el('div', { class: 'money' }, el('span', {}, 'Items subtotal'), el('b', {}, inr(quote.totals.subtotal))),
      quote.totals.discount_total > 0 ? el('div', { class: 'money', style: 'color:var(--green)' }, el('span', {}, 'Total savings'), el('b', {}, `−${inr(quote.totals.discount_total)}`)) : null,
      el('div', { class: 'money' }, el('span', {}, 'Delivery charges'), el('b', {}, quote.totals.delivery_total ? inr(quote.totals.delivery_total) : 'FREE')),
      el('div', { class: 'money total' }, el('span', {}, 'Total payable'), el('b', {}, inr(quote.totals.total))),
    ] : null,
    el('div', { class: 'field', style: 'margin-top:8px' },
      el('label', {}, 'Payment method'),
      el('div', { class: 'seg', style: 'width:100%' },
        el('button', { class: state.payment === 'cod' ? 'on' : '', style: 'flex:1', type: 'button', onclick: () => { state.payment = 'cod'; viewCart(); } }, 'Cash on delivery'),
        el('button', { class: state.payment === 'prepaid' ? 'on' : '', style: 'flex:1', type: 'button', onclick: () => { state.payment = 'prepaid'; viewCart(); } }, 'Prepaid (demo)'),
      ),
    ),
    el('div', { class: 'banner', style: 'font-size:12px;color:var(--muted)' },
      state.payment === 'cod'
        ? 'Pay in cash when your delivery arrives or when you collect your order at the shop.'
        : 'No online payment gateway is connected yet. Prepaid orders are marked unconfirmed (pending gateway) — no card or UPI charge is processed.',
    ),
    state.customer
      ? placeBtn
      : el('a', { class: 'btn primary block', href: '#/login?next=/cart' }, 'Sign in or create account to checkout'),
  );

  renderShell(el('div', { class: 'wrap', style: 'padding-top:24px' },
    el('div', { class: 'sec-head', style: 'margin-top:0' }, el('h1', {}, 'Your cart'), el('a', { class: 'btn sm', href: '#/' }, 'Continue shopping')),
    el('div', { class: 'grid-2' }, left, right),
  ));
}

/* ---------- Orders List ---------- */
async function viewOrders() {
  if (!state.customer) { location.hash = '#/login?next=/orders'; return; }
  renderShell(loading('Loading your orders…'));
  try {
    const data = await api('GET', '/api/customer/orders');
    const wrap = el('div', { class: 'wrap', style: 'padding-top:24px' },
      el('div', { class: 'sec-head', style: 'margin-top:0' },
        el('div', {}, el('h1', {}, 'My orders'), el('p', {}, 'Live order progress, verification codes, and tracking links across every shop.')),
        el('a', { class: 'btn sm primary', href: '#/' }, 'Shop again'),
      ),
      data.orders.length
        ? el('div', { class: 'stack' }, ...data.orders.map((o) =>
          el('div', { class: 'order-card' },
            el('div', { class: 'order-card__head' },
              el('strong', {}, o.code),
              el('span', { class: `pill ${o.status === 'delivered' ? 'ok' : o.status === 'cancelled' ? 'bad' : 'warn'}` }, o.status_label),
              el('span', { class: 'muted', style: 'font-size:12.5px' }, fmtTime(o.placed_at)),
              el('span', { style: 'margin-left:auto;font-weight:700' }, inr(o.total)),
              el('a', { class: 'btn sm primary', href: `#/orders/${encodeURIComponent(o.code)}` }, 'View details & codes'),
            ),
            ...o.shops.map((s) =>
              el('div', { class: 'order-shop' },
                el('div', { class: 'order-shop__head' },
                  el('strong', {}, s.shop),
                  el('span', { class: 'badge' }, s.fulfilment === 'pickup' ? 'Free pickup' : (s.delivery_mode === 'self' ? 'Shop delivery' : 'NearBuy Runner')),
                  el('span', { class: 'pill' }, s.delivery ? s.delivery.status_label : s.status_label),
                  s.collection_code ? el('span', { class: 'pill orange' }, `${s.code_label}: ${s.collection_code}`) : null,
                  s.delivery && s.delivery.delivery_code ? el('span', { class: 'pill orange' }, `Delivery OTP: ${s.delivery.delivery_code}`) : null,
                ),
                el('div', { class: 'items-mini' }, s.items.map((i) => `${i.qty} × ${i.title}`).join(' · ')),
              )),
          )))
        : el('div', { class: 'empty' },
          el('h3', {}, 'No orders yet'),
          el('p', {}, 'When you order from a neighbourhood shop, you can follow every step live right here.'),
          el('a', { class: 'btn primary', href: '#/' }, 'Browse nearby shops'),
        ),
    );
    renderShell(wrap);
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Order Detail ---------- */
const RETURN_REASONS = ['Damaged in transit', 'Item not as described', 'Wrong item delivered', 'Size or fit issue', 'Defective or not working', 'Quality not as expected', 'No longer needed'];
const ISSUE_CATS = { delayed: 'Delayed delivery', missing_parcel: 'Missing parcel', incorrect_delivery: 'Incorrect delivery', partner_conduct: 'Partner conduct complaint', seller_handover: 'Seller handover complaint', refund: 'Refund or replacement request', other: 'Other issue' };

async function viewOrderDetail(code) {
  if (!state.customer) { location.hash = `#/login?next=/orders/${code}`; return; }
  renderShell(loading('Loading live order status…'));
  try {
    const o = (await api('GET', `/api/customer/orders/${encodeURIComponent(code)}`)).order;
    const anyCancellable = o.shops.some((s) => s.cancellable);

    const cancelOrder = async () => {
      const reason = window.prompt('Reason for cancellation (optional):', 'Changed my mind');
      if (reason === null) return;
      try {
        await api('POST', `/api/customer/orders/${encodeURIComponent(code)}/cancel`, { reason });
        toast('Order cancelled and stock released.', 'ok');
        viewOrderDetail(code);
      } catch (err) { toast(err.message, 'bad'); }
    };

    const refreshCode = async (orderCode) => {
      try {
        await api('POST', `/api/customer/orders/${encodeURIComponent(code)}/shops/${encodeURIComponent(orderCode)}/refresh-code`, {});
        toast('Generated a fresh 4-digit verification code.', 'ok');
        viewOrderDetail(code);
      } catch (err) { toast(err.message, 'bad'); }
    };

    const openReturnForm = (shopRow, container) => {
      const reasonSel = el('select', {}, ...RETURN_REASONS.map((r) => el('option', { value: r }, r)));
      const descIn = el('textarea', { rows: 2, placeholder: 'Describe the issue briefly…' });
      const form = el('form', {
        class: 'card pad stack', style: 'background:#fafbff;margin-top:8px',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('POST', `/api/customer/orders/${encodeURIComponent(code)}/shops/${encodeURIComponent(shopRow.order_code)}/return`, {
              reason: reasonSel.value, description: descIn.value.trim(),
            });
            toast('Return request sent to the shop.', 'ok');
            viewOrderDetail(code);
          } catch (err) { toast(err.message, 'bad'); }
        },
      },
      el('strong', {}, `Request return for ${shopRow.shop}`),
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reasonSel),
      el('div', { class: 'field' }, el('label', {}, 'Notes'), descIn),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm primary', type: 'submit' }, 'Submit return request'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => form.remove() }, 'Cancel'),
      ));
      container.replaceChildren(form);
    };

    const issueBox = el('div');
    const openIssueForm = () => {
      const catSel = el('select', {}, ...Object.entries(ISSUE_CATS).map(([k, v]) => el('option', { value: k }, v)));
      const subjIn = el('input', { type: 'text', required: true, placeholder: 'Short summary of your issue' });
      const descIn = el('textarea', { rows: 3, required: true, placeholder: 'Share details so NearBuy operations and the shop can resolve this quickly…' });
      const form = el('form', {
        class: 'card pad stack', style: 'margin-top:12px',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const res = await api('POST', `/api/customer/orders/${encodeURIComponent(code)}/issue`, {
              category: catSel.value, subject: subjIn.value.trim(), description: descIn.value.trim(),
            });
            toast(res.message, 'ok');
            issueBox.replaceChildren(el('div', { class: 'banner ok', style: 'margin-top:12px' }, res.message));
          } catch (err) { toast(err.message, 'bad'); }
        },
      },
      el('h3', {}, 'Report a delivery or order issue'),
      el('div', { class: 'field' }, el('label', {}, 'Category'), catSel),
      el('div', { class: 'field' }, el('label', {}, 'Subject'), subjIn),
      el('div', { class: 'field' }, el('label', {}, 'Description'), descIn),
      el('div', { class: 'row' },
        el('button', { class: 'btn sm primary', type: 'submit' }, 'Send to support'),
        el('button', { class: 'btn sm', type: 'button', onclick: () => issueBox.replaceChildren() }, 'Cancel'),
      ));
      issueBox.replaceChildren(form);
    };

    const wrap = el('div', { class: 'wrap', style: 'padding-top:24px' },
      el('a', { href: '#/orders', class: 'muted', style: 'font-size:13px' }, '← All orders'),
      el('div', { class: 'sec-head', style: 'margin-top:10px' },
        el('div', {},
          el('div', { class: 'row' },
            el('h1', {}, `Order ${o.code}`),
            el('span', { class: `pill ${o.status === 'delivered' ? 'ok' : o.status === 'cancelled' ? 'bad' : 'warn'}` }, o.status_label),
          ),
          el('p', {}, `Placed ${fmtTime(o.placed_at)} · ${o.payment_method} (${o.payment_status.replace(/_/g, ' ')})`),
        ),
        el('div', { class: 'row' },
          anyCancellable ? el('button', { class: 'btn sm', type: 'button', onclick: cancelOrder }, 'Cancel order') : null,
          el('button', { class: 'btn sm', type: 'button', onclick: openIssueForm }, 'Need help / Report issue'),
        ),
      ),
      o.payment_disclosure ? el('div', { class: 'banner', style: 'margin-bottom:14px;font-size:12.5px' }, o.payment_disclosure) : null,
      issueBox,
      el('div', { class: 'stack', style: 'margin-top:14px' },
        ...o.shops.map((s) => {
          const retSlot = el('div');
          const activeCode = s.delivery && s.delivery.delivery_code ? s.delivery.delivery_code : s.collection_code;
          const activeCodeLabel = s.delivery && s.delivery.delivery_code ? 'Delivery OTP (share with runner at handover)' : `${s.code_label || 'Verification code'} (share with shop at handover)`;
          return el('div', { class: 'order-card' },
            el('div', { class: 'order-card__head' },
              el('strong', {}, s.shop),
              el('span', { class: 'muted', style: 'font-size:12px' }, s.order_code),
              el('span', { class: 'badge' }, s.fulfilment === 'pickup' ? 'Free store pickup (₹0)' : (s.delivery_mode === 'self' ? 'Delivered by shop' : 'NearBuy Runner delivery')),
              el('span', { class: `pill ${s.status === 'delivered' ? 'ok' : s.status === 'cancelled' ? 'bad' : 'warn'}`, style: 'margin-left:auto' }, s.delivery ? s.delivery.status_label : s.status_label),
            ),
            el('div', { class: 'order-shop' },
              activeCode ? el('div', { class: 'row', style: 'justify-content:space-between;align-items:center' },
                el('div', {},
                  el('div', { class: 'muted', style: 'font-size:12px;margin-bottom:4px' }, activeCodeLabel),
                  el('div', { class: 'code-box', style: 'display:inline-block' }, activeCode),
                ),
                el('button', { class: 'btn sm', type: 'button', onclick: () => refreshCode(s.order_code) }, 'Refresh code'),
              ) : null,
              s.delivery ? el('div', { class: 'row', style: 'justify-content:space-between;background:#f8faff;padding:10px 12px;border-radius:10px;border:1px solid var(--line)' },
                el('div', {},
                  el('strong', {}, s.delivery.partner ? `Assigned runner: ${s.delivery.partner.name}` : 'Waiting for runner assignment'),
                  el('div', { class: 'muted', style: 'font-size:12px' }, [
                    s.delivery.code,
                    s.delivery.partner && s.delivery.partner.vehicle ? s.delivery.partner.vehicle : null,
                    s.delivery.partner && s.delivery.partner.rating ? `★ ${s.delivery.partner.rating}` : null,
                    s.delivery.eta_at ? `ETA ${fmtTime(s.delivery.eta_at)}` : null,
                  ].filter(Boolean).join(' · ')),
                ),
                el('a', { class: 'btn sm primary', href: s.delivery.track_url, target: '_blank', rel: 'noopener' }, 'Open live tracking'),
              ) : null,
              el('div', { class: 'stack', style: 'gap:4px' },
                ...s.items.map((it) => el('div', { class: 'money' }, el('span', {}, `${it.qty} × ${it.title}`), el('b', {}, inr(it.line_total)))),
                el('div', { class: 'money', style: 'border-top:1px solid var(--line);padding-top:6px' },
                  el('span', {}, s.fulfilment === 'pickup' ? 'Pickup fee' : 'Delivery fee'),
                  el('b', {}, s.delivery_fee ? inr(s.delivery_fee) : 'FREE'),
                ),
              ),
              s.returns && s.returns.length
                ? el('div', { class: 'banner' }, ...s.returns.map((r) => el('div', {}, `Return ${r.code}: ${r.status} · Refund: ${r.refund_status} (${r.reason})`)))
                : null,
              s.returnable
                ? el('div', {}, el('button', { class: 'btn sm', type: 'button', onclick: () => openReturnForm(s, retSlot) }, 'Request return / replacement'))
                : null,
              retSlot,
              s.timeline && s.timeline.length ? el('details', {},
                el('summary', { style: 'cursor:pointer;font-size:12.5px;color:var(--navy);font-weight:650' }, `Order timeline (${s.timeline.length} events)`),
                el('ul', { class: 'tl', style: 'margin-top:8px' }, ...s.timeline.map((ev) =>
                  el('li', {}, el('div', {}, el('b', {}, ev.title), ' ', el('span', {}, `${fmtTime(ev.at)}${ev.note ? ` — ${ev.note}` : ''}`))))),
              ) : null,
            ),
          );
        }),
      ),
      el('div', { class: 'card pad', style: 'margin-top:16px' },
        el('div', { class: 'money' }, el('span', {}, 'Subtotal'), el('b', {}, inr(o.subtotal))),
        o.discount_total > 0 ? el('div', { class: 'money', style: 'color:var(--green)' }, el('span', {}, 'Savings'), el('b', {}, `−${inr(o.discount_total)}`)) : null,
        el('div', { class: 'money' }, el('span', {}, 'Delivery total'), el('b', {}, o.delivery_total ? inr(o.delivery_total) : 'FREE')),
        el('div', { class: 'money total' }, el('span', {}, 'Order total'), el('b', {}, inr(o.total))),
      ),
    );
    renderShell(wrap);
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Notifications ---------- */
async function viewNotifications() {
  if (!state.customer) { location.hash = '#/login?next=/notifications'; return; }
  renderShell(loading('Loading notifications…'));
  try {
    const data = await api('GET', '/api/customer/notifications');
    state.unread = data.unread || 0;
    renderHeader();
    const wrap = el('div', { class: 'wrap', style: 'padding-top:24px' },
      el('div', { class: 'sec-head', style: 'margin-top:0' },
        el('div', {}, el('h1', {}, 'Notifications'), el('p', {}, `${data.unread} unread`)),
        data.unread ? el('button', {
          class: 'btn sm primary', type: 'button',
          onclick: async () => { await api('POST', '/api/customer/notifications/read', {}); state.unread = 0; renderHeader(); viewNotifications(); },
        }, 'Mark all read') : null,
      ),
      data.notifications.length
        ? el('div', { class: 'card' }, ...data.notifications.map((n) =>
          el('div', { class: `notif-row ${n.read ? '' : 'unread'}` },
            el('div', {},
              el('strong', {}, n.title),
              n.body ? el('p', { class: 'muted', style: 'font-size:13px;margin-top:2px' }, n.body) : null,
              el('div', { class: 'muted', style: 'font-size:11.5px;margin-top:4px' }, fmtTime(n.at)),
            ),
            el('div', { class: 'row' },
              n.link ? el('a', { class: 'btn sm', href: n.link }, 'Open') : null,
              !n.read ? el('button', {
                class: 'btn sm ghost', type: 'button',
                onclick: async () => { await api('POST', `/api/customer/notifications/${n.id}/read`, {}); viewNotifications(); },
              }, 'Mark read') : null,
            ),
          )))
        : el('div', { class: 'empty' }, el('h3', {}, 'No notifications yet')),
    );
    renderShell(wrap);
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Account, Saved Addresses, Security ---------- */
async function viewAccount() {
  if (!state.customer) { location.hash = '#/login?next=/account'; return; }
  renderShell(loading('Loading your account…'));
  try {
    const [meRes, addrRes, sessRes] = await Promise.all([
      api('GET', '/api/customer/me'),
      api('GET', '/api/customer/addresses'),
      api('GET', '/api/customer/sessions'),
    ]);
    state.customer = meRes.customer;
    const c = state.customer;
    const a = c.address || {};

    const nameIn = el('input', { value: c.name || '' });
    const mobIn = el('input', { value: c.mobile || '', placeholder: '10-digit mobile number' });
    const addrIn = el('input', { value: a.line || '', placeholder: 'Flat / House, Street' });
    const areaIn = el('input', { value: a.area || '', placeholder: 'Neighbourhood / Locality' });
    const cityIn = el('input', { value: a.city || 'New Delhi' });
    const pinIn = el('input', { value: a.pincode || state.pincode || '', maxlength: 6 });

    const profileForm = el('form', {
      class: 'card pad stack',
      onsubmit: async (e) => {
        e.preventDefault();
        try {
          const res = await api('PATCH', '/api/customer/profile', {
            name: nameIn.value.trim(),
            mobile: mobIn.value.trim() || undefined,
            address: addrIn.value.trim() || undefined,
            area: areaIn.value.trim() || undefined,
            city: cityIn.value.trim() || undefined,
            pincode: pinIn.value.trim() || undefined,
          });
          state.customer = res.customer;
          if (pinIn.value.trim().length === 6) { state.pincode = pinIn.value.trim(); localStorage.setItem('nearbuy_pincode', state.pincode); }
          state.draftAddress = addrIn.value.trim();
          renderHeader();
          toast('Profile saved.', 'ok');
        } catch (err) { toast(err.message, 'bad'); }
      },
    },
    el('h3', {}, 'Profile & default address'),
    el('div', { class: 'field-grid' },
      el('div', { class: 'field' }, el('label', {}, 'Full name'), nameIn),
      el('div', { class: 'field' }, el('label', {}, 'Mobile number'), mobIn),
    ),
    el('div', { class: 'field' }, el('label', {}, 'Address line'), addrIn),
    el('div', { class: 'field-grid' },
      el('div', { class: 'field' }, el('label', {}, 'Locality / Area'), areaIn),
      el('div', { class: 'field' }, el('label', {}, 'PIN code'), pinIn),
    ),
    el('div', { class: 'field' }, el('label', {}, 'City'), cityIn),
    el('div', { class: 'row' },
      el('button', { class: 'btn primary', type: 'submit' }, 'Save profile'),
      el('button', {
        class: 'btn', type: 'button',
        onclick: async () => { await api('POST', '/api/customer/logout', {}); state.customer = null; state.unread = 0; if (state.sse) state.sse.close(); renderHeader(); location.hash = '#/'; toast('Signed out.'); },
      }, 'Sign out'),
    ));

    // Saved addresses book
    const newLabel = el('input', { placeholder: 'Home / Office', value: 'Home' });
    const newAddr = el('input', { placeholder: 'Flat / House, Street, Locality', required: true });
    const newPin = el('input', { placeholder: '110016', maxlength: 6, required: true });
    const addrBook = el('div', { class: 'card pad stack' },
      el('h3', {}, 'Saved addresses'),
      ...(addrRes.addresses.length
        ? addrRes.addresses.map((ad) => el('div', { class: `addr-card ${ad.is_default ? 'def' : ''}` },
          el('div', {},
            el('div', { class: 'row' }, el('strong', {}, ad.label), ad.is_default ? el('span', { class: 'pill ok' }, 'Default') : null),
            el('div', { class: 'muted', style: 'font-size:13px' }, `${ad.address}, ${ad.city || 'New Delhi'} ${ad.pincode}`),
          ),
          el('div', { class: 'row' },
            !ad.is_default ? el('button', { class: 'btn sm', type: 'button', onclick: async () => { await api('PATCH', `/api/customer/addresses/${ad.id}`, { is_default: true }); viewAccount(); } }, 'Make default') : null,
            el('button', { class: 'btn sm', type: 'button', onclick: async () => { await api('DELETE', `/api/customer/addresses/${ad.id}`); viewAccount(); } }, 'Remove'),
          ),
        ))
        : [el('p', { class: 'muted', style: 'font-size:13px' }, 'No saved addresses yet.')]),
      el('form', {
        class: 'stack', style: 'border-top:1px solid var(--line);padding-top:12px',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            await api('POST', '/api/customer/addresses', { label: newLabel.value.trim() || 'Home', address: newAddr.value.trim(), pincode: newPin.value.trim(), is_default: true });
            toast('Address added.', 'ok');
            viewAccount();
          } catch (err) { toast(err.message, 'bad'); }
        },
      },
      el('strong', { style: 'font-size:13px' }, 'Add a new address'),
      el('div', { class: 'field-grid' },
        el('div', { class: 'field' }, el('label', {}, 'Label'), newLabel),
        el('div', { class: 'field' }, el('label', {}, 'PIN code'), newPin),
      ),
      el('div', { class: 'field' }, el('label', {}, 'Full address'), newAddr),
      el('button', { class: 'btn sm primary', type: 'submit', style: 'justify-self:start' }, 'Add saved address')),
    );

    // Password & sessions
    const curPw = el('input', { type: 'password', required: true, placeholder: 'Current password' });
    const newPw = el('input', { type: 'password', required: true, placeholder: 'New password (min 10 chars, mixed case + number)' });
    const secCard = el('div', { class: 'card pad stack' },
      el('h3', {}, 'Password & active sessions'),
      el('form', {
        class: 'stack',
        onsubmit: async (e) => {
          e.preventDefault();
          try {
            const res = await api('POST', '/api/customer/change-password', { current_password: curPw.value, new_password: newPw.value });
            toast(res.message, 'ok');
            curPw.value = ''; newPw.value = '';
          } catch (err) { toast(err.message, 'bad'); }
        },
      },
      el('div', { class: 'field-grid' },
        el('div', { class: 'field' }, el('label', {}, 'Current password'), curPw),
        el('div', { class: 'field' }, el('label', {}, 'New password'), newPw),
      ),
      el('button', { class: 'btn sm primary', type: 'submit', style: 'justify-self:start' }, 'Change password')),
      el('div', { style: 'border-top:1px solid var(--line);padding-top:12px' },
        el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:8px' },
          el('strong', { style: 'font-size:13px' }, `Active sessions (${sessRes.sessions.length})`),
          sessRes.sessions.length > 1 ? el('button', {
            class: 'btn sm', type: 'button',
            onclick: async () => { await api('POST', '/api/customer/sessions/revoke-others', {}); toast('Signed out other devices.', 'ok'); viewAccount(); },
          }, 'Sign out other devices') : null,
        ),
        ...sessRes.sessions.map((s) => el('div', { class: 'muted', style: 'font-size:12px;padding:4px 0' },
          `${s.current ? '● This device' : '○ Device'} · Last active ${fmtTime(s.last_seen_at)}`)),
      ),
    );

    renderShell(el('div', { class: 'wrap', style: 'padding-top:24px' },
      el('h1', { style: 'margin-bottom:16px' }, 'Your account'),
      el('div', { class: 'stack' }, profileForm, addrBook, secCard),
    ));
  } catch (err) {
    renderShell(el('div', { class: 'wrap', style: 'padding:32px 0' }, el('div', { class: 'banner bad' }, err.message)));
  }
}

/* ---------- Auth Screens (Login, Register, Forgot/Reset Password) ---------- */
function viewLogin(nextHash = '/') {
  const emailIn = el('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const pwIn = el('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: 'Your password' });
  const errBox = el('div');

  const form = el('form', {
    class: 'auth__card',
    onsubmit: async (e) => {
      e.preventDefault(); errBox.replaceChildren();
      try {
        await api('POST', '/api/customer/login', { email: emailIn.value.trim(), password: pwIn.value });
        await refreshSession();
        toast('Welcome back to NearBuy!', 'ok');
        location.hash = `#${nextHash.startsWith('/') ? nextHash : '/'}`;
      } catch (err) { errBox.replaceChildren(el('div', { class: 'banner bad', style: 'margin-bottom:12px' }, err.message)); }
    },
  },
  el('h1', {}, 'Sign in to NearBuy'),
  el('p', { class: 'muted', style: 'margin-bottom:16px' }, 'Order from your local shops and track deliveries live.'),
  errBox,
  el('div', { class: 'field' }, el('label', {}, 'Email address'), emailIn),
  el('div', { class: 'field' }, el('label', {}, 'Password'), pwIn),
  el('button', { class: 'btn primary block', type: 'submit' }, 'Sign in'),
  el('div', { class: 'auth__alt' },
    el('a', { href: '#/forgot-password' }, 'Forgot password?'),
    ' · ',
    el('a', { href: `#/register?next=${encodeURIComponent(nextHash)}` }, 'Create a new account'),
  ),
  el('div', { class: 'banner', style: 'margin-top:16px;font-size:12px;color:var(--muted)' },
    el('strong', {}, 'Optional demo account: '), 'customer@nearbuy.demo / Customer123! (or register your own real account above).'));
  renderShell(el('div', { class: 'auth' }, form));
}

function viewRegister(nextHash = '/') {
  const nameIn = el('input', { type: 'text', required: true, placeholder: 'Full name' });
  const emailIn = el('input', { type: 'email', required: true, placeholder: 'you@example.com' });
  const mobIn = el('input', { type: 'tel', placeholder: '10-digit mobile number' });
  const pinIn = el('input', { type: 'text', maxlength: 6, value: state.pincode || '110016', placeholder: '6-digit PIN code' });
  const addrIn = el('input', { type: 'text', placeholder: 'House/Flat, Street, Area' });
  const pwIn = el('input', { type: 'password', required: true, placeholder: 'Min 10 characters with letters & numbers' });
  const errBox = el('div');

  const form = el('form', {
    class: 'auth__card',
    onsubmit: async (e) => {
      e.preventDefault(); errBox.replaceChildren();
      try {
        await api('POST', '/api/customer/register', {
          name: nameIn.value.trim(), email: emailIn.value.trim(), password: pwIn.value,
          mobile: mobIn.value.trim() || undefined, pincode: pinIn.value.trim() || undefined, address: addrIn.value.trim() || undefined,
        });
        await refreshSession();
        toast('Account created! Welcome to NearBuy.', 'ok');
        location.hash = `#${nextHash.startsWith('/') ? nextHash : '/'}`;
      } catch (err) { errBox.replaceChildren(el('div', { class: 'banner bad', style: 'margin-bottom:12px' }, err.message)); }
    },
  },
  el('h1', {}, 'Create your NearBuy account'),
  el('p', { class: 'muted', style: 'margin-bottom:16px' }, 'Independent customer account with real database persistence.'),
  errBox,
  el('div', { class: 'field' }, el('label', {}, 'Full name'), nameIn),
  el('div', { class: 'field' }, el('label', {}, 'Email address'), emailIn),
  el('div', { class: 'field-grid' },
    el('div', { class: 'field' }, el('label', {}, 'Mobile number'), mobIn),
    el('div', { class: 'field' }, el('label', {}, 'PIN code'), pinIn),
  ),
  el('div', { class: 'field' }, el('label', {}, 'Delivery address (optional)'), addrIn),
  el('div', { class: 'field' }, el('label', {}, 'Password'), pwIn),
  el('button', { class: 'btn primary block', type: 'submit' }, 'Create account'),
  el('div', { class: 'auth__alt' }, 'Already have an account? ', el('a', { href: `#/login?next=${encodeURIComponent(nextHash)}` }, 'Sign in')));
  renderShell(el('div', { class: 'auth' }, form));
}

function viewForgotPassword() {
  const emailIn = el('input', { type: 'email', required: true, placeholder: 'you@example.com' });
  const msgBox = el('div');
  const form = el('form', {
    class: 'auth__card',
    onsubmit: async (e) => {
      e.preventDefault(); msgBox.replaceChildren();
      try {
        const res = await api('POST', '/api/customer/forgot-password', { email: emailIn.value.trim() });
        msgBox.replaceChildren(el('div', { class: 'banner ok', style: 'margin-bottom:12px' },
          res.message,
          res.reset_token ? el('div', { style: 'margin-top:8px' }, el('a', { href: `#/reset-password?token=${encodeURIComponent(res.reset_token)}` }, 'Continue with dev reset token →')) : null));
      } catch (err) { msgBox.replaceChildren(el('div', { class: 'banner bad', style: 'margin-bottom:12px' }, err.message)); }
    },
  },
  el('h1', {}, 'Reset your password'),
  el('p', { class: 'muted', style: 'margin-bottom:16px' }, 'Enter your email address to generate a password reset token.'),
  msgBox,
  el('div', { class: 'field' }, el('label', {}, 'Email address'), emailIn),
  el('button', { class: 'btn primary block', type: 'submit' }, 'Request reset link'),
  el('div', { class: 'auth__alt' }, el('a', { href: '#/login' }, 'Back to sign in')));
  renderShell(el('div', { class: 'auth' }, form));
}

function viewResetPassword(qs) {
  const params = new URLSearchParams(qs || '');
  const tokIn = el('input', { type: 'text', required: true, value: params.get('token') || '', placeholder: 'Reset token' });
  const pwIn = el('input', { type: 'password', required: true, placeholder: 'New password (min 10 chars)' });
  const msgBox = el('div');
  const form = el('form', {
    class: 'auth__card',
    onsubmit: async (e) => {
      e.preventDefault(); msgBox.replaceChildren();
      try {
        const res = await api('POST', '/api/customer/reset-password', { token: tokIn.value.trim(), password: pwIn.value });
        toast(res.message, 'ok');
        location.hash = '#/login';
      } catch (err) { msgBox.replaceChildren(el('div', { class: 'banner bad', style: 'margin-bottom:12px' }, err.message)); }
    },
  },
  el('h1', {}, 'Choose a new password'),
  msgBox,
  el('div', { class: 'field' }, el('label', {}, 'Reset token'), tokIn),
  el('div', { class: 'field' }, el('label', {}, 'New password'), pwIn),
  el('button', { class: 'btn primary block', type: 'submit' }, 'Update password'));
  renderShell(el('div', { class: 'auth' }, form));
}

/* ---------- Router ---------- */
function route() {
  const raw = location.hash.slice(1) || '/';
  const [path, qs = ''] = raw.split('?');
  const params = new URLSearchParams(qs);
  if (path === '/' || path === '') return viewHome();
  if (path === '/search') return viewSearch(qs);
  if (path.startsWith('/shop/')) return viewShop(decodeURIComponent(path.slice(6)));
  if (path.startsWith('/product/')) return viewProduct(decodeURIComponent(path.slice(9)));
  if (path === '/cart') return viewCart();
  if (path === '/orders') return viewOrders();
  if (path.startsWith('/orders/')) return viewOrderDetail(decodeURIComponent(path.slice(8)));
  if (path === '/notifications') return viewNotifications();
  if (path === '/account') return viewAccount();
  if (path === '/login') return viewLogin(params.get('next') || '/');
  if (path === '/register') return viewRegister(params.get('next') || '/');
  if (path === '/forgot-password') return viewForgotPassword();
  if (path === '/reset-password') return viewResetPassword(qs);
  return viewHome();
}

window.addEventListener('hashchange', route);
(async () => {
  await refreshSession();
  route();
})();
