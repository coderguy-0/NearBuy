// Seller Hub → Local Deliveries & Find a NearBuy Runner marketplace.
import { h, icon, api, can, reload, toast, field, formModal, modal, busy, banner, badge, statusBadge, demoTag, pageHead, card, tabs, emptyState, kv, timeline, inr, fmtDateTime } from './core.js';

const TABS = [
  ['new', 'New orders'], ['preparing', 'Preparing'], ['ready', 'Ready for pickup'],
  ['handed_over', 'Handed over'], ['completed', 'Completed'], ['returns', 'Returns'], ['issues', 'Issues'],
];
const ACTIVE_STATUSES = ['awaiting_assignment', 'searching_partner', 'offer_sent', 'reassignment_required'];
const VEHICLE_FILTER = [
  ['all', 'All vehicles'],
  ['walking', 'Walking'],
  ['bicycle', 'Bicycle'],
  ['ev_two_wheeler', 'Electric 2W'],
  ['two_wheeler', 'Two-wheeler'],
  ['three_wheeler', '3W Cargo'],
];

const pill = (d) => statusBadge(d.status, d.status_label);
const rowMeta = (d) => `${d.category_label} · ${d.distance_km} km · ${d.payment_type === 'cod' ? `Cash on delivery ${inr(d.cod_amount)}` : 'Prepaid'}`;

let es;
function subscribe(onChange) {
  if (es) es.close();
  es = new EventSource('/api/realtime?portal=seller');
  es.onmessage = (e) => { try { if (JSON.parse(e.data).kind !== 'ping') onChange(); } catch {} };
  window.addEventListener('beforeunload', () => es && es.close(), { once: true });
}

/* ---------- Privacy-safe SVG Neighbourhood Map (shop + approximate customer + coarse ~300m runners) ---------- */
function runnerSvgMap(delivery, candidates) {
  const pts = [];
  if (delivery.pickup_point) pts.push({ ...delivery.pickup_point, kind: 'shop', label: 'Your shop' });
  if (delivery.drop_point) pts.push({ ...delivery.drop_point, kind: 'drop', label: delivery.drop_area || 'Customer area' });
  const runners = candidates.filter((c) => c.approx_location);
  runners.forEach((c) => pts.push({ ...c.approx_location, kind: c.eligible ? 'eligible' : 'busy', label: `${c.code} (${c.name.split(' ')[0]})`, code: c.code }));
  if (!pts.length) return null;

  const lats = pts.map((p) => p.lat);
  const lngs = pts.map((p) => p.lng);
  const minLat = Math.min(...lats) - 0.008;
  const maxLat = Math.max(...lats) + 0.008;
  const minLng = Math.min(...lngs) - 0.01;
  const maxLng = Math.max(...lngs) + 0.01;
  const W = 560; const H = 190;
  const x = (lng) => Math.round(((lng - minLng) / Math.max(0.0001, maxLng - minLng)) * (W - 72) + 36);
  const y = (lat) => Math.round(H - (((lat - minLat) / Math.max(0.0001, maxLat - minLat)) * (H - 54) + 27));

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Privacy-safe map showing shop pickup point, customer area and approximate nearby runner positions');
  svg.style.cssText = 'width:100%;height:190px;background:#f7f9fc;border:1px solid #dfe5f0;border-radius:10px;display:block';

  const ns = (t, attrs = {}, text = null) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', t);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };
  // Subtle grid lines
  for (let gx = 80; gx < W; gx += 80) svg.append(ns('line', { x1: gx, y1: 0, x2: gx, y2: H, stroke: '#e8edf5', 'stroke-width': 1 }));
  for (let gy = 48; gy < H; gy += 48) svg.append(ns('line', { x1: 0, y1: gy, x2: W, y2: gy, stroke: '#e8edf5', 'stroke-width': 1 }));

  const shopPt = pts.find((p) => p.kind === 'shop');
  const dropPt = pts.find((p) => p.kind === 'drop');
  if (shopPt && dropPt) {
    svg.append(ns('line', { x1: x(shopPt.lng), y1: y(shopPt.lat), x2: x(dropPt.lng), y2: y(dropPt.lat), stroke: '#0f263b', 'stroke-dasharray': '5 4', 'stroke-width': 1.6, opacity: 0.45 }));
  }
  for (const p of pts) {
    const px = x(p.lng); const py = y(p.lat);
    const fill = p.kind === 'shop' ? '#0f263b' : p.kind === 'drop' ? '#e86f33' : p.kind === 'eligible' ? '#1f7a4c' : '#9aa4b5';
    const r = p.kind === 'shop' || p.kind === 'drop' ? 7 : 6;
    if (p.kind === 'eligible') svg.append(ns('circle', { cx: px, cy: py, r: 12, fill: '#1f7a4c', opacity: 0.14 }));
    svg.append(ns('circle', { cx: px, cy: py, r, fill, stroke: '#fff', 'stroke-width': 2 }));
    svg.append(ns('text', { x: px + 10, y: py + 4, fill: '#182436', 'font-size': 11, 'font-family': 'sans-serif', 'font-weight': p.kind === 'shop' ? 700 : 500 }, p.label));
  }
  return h('div.stack.sm',
    svg,
    h('div.row.wrap.tiny.muted',
      h('span', '● Navy: Your shop'), h('span', '· ● Orange: Customer approx. area'),
      h('span', '· ● Green: Eligible runner (~300m privacy zone)'), h('span', '· ● Grey: Unavailable')));
}

/* ---------- Find a Runner Marketplace Modal ---------- */
async function openFindRunner(deliveryCode) {
  let stateData = await api(`/seller/deliveries/${deliveryCode}/candidates`);
  let onlyEligible = false;
  let vehicleFilter = 'all';
  let sortBy = 'score';
  let editingParcel = false;
  let countdownTimer = null;

  const container = h('div.stack');
  const { close } = modal({ title: `Find a NearBuy Runner · ${deliveryCode}`, subtitle: 'Compare verified 18+ local partners, review parcel fit, and send an atomic appointment offer.', wide: true, body: container });
  const cleanup = () => { if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; } };

  async function refresh() {
    stateData = await api(`/seller/deliveries/${deliveryCode}/candidates`);
    draw();
  }

  function draw() {
    cleanup();
    const d = stateData.delivery;
    const allCands = stateData.candidates || [];
    let visible = allCands.filter((c) => (!onlyEligible || c.eligible) && (vehicleFilter === 'all' || c.vehicle_type === vehicleFilter));
    if (sortBy === 'distance') visible.sort((a, b) => (a.pickup_km ?? 99) - (b.pickup_km ?? 99));
    else if (sortBy === 'eta') visible.sort((a, b) => (a.trip_eta_min ?? 99) - (b.trip_eta_min ?? 99));
    else if (sortBy === 'rating') visible.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    else visible.sort((a, b) => (b.eligible - a.eligible) || ((b.score ?? -1) - (a.score ?? -1)));

    const nodes = [];
    // Pending offer banner with live countdown + cancel button
    if (d.pending_offer) {
      const countdownEl = h('b', '');
      const updateTimer = () => {
        const secs = Math.max(0, Math.round((Date.parse(d.pending_offer.expires_at) - Date.now()) / 1000));
        countdownEl.textContent = secs > 0 ? `${secs}s remaining` : 'Expired — refreshing…';
        if (secs === 0) { cleanup(); refresh().catch(() => {}); }
      };
      updateTimer();
      countdownTimer = setInterval(updateTimer, 1000);
      nodes.push(banner('warn', h('div.row.between.wrap',
        h('div', h('b', `Offer sent to ${d.pending_offer.partner_name} (${d.pending_offer.partner_code}). `), 'Waiting for runner response — ', countdownEl),
        can('orders.write') ? h('button.btn.sm', { type: 'button', onClick: (e) => busy(e.currentTarget, async () => {
          await api(`/seller/deliveries/${deliveryCode}/cancel-offer`, { method: 'POST', body: {} });
          toast('Pending offer cancelled. You can appoint another runner.', 'info');
          await refresh();
        }) }, 'Cancel offer') : null)));
    }

    // Delivery & parcel summary bar
    nodes.push(h('div.card', h('div.card-body.stack.sm',
      h('div.row.between.wrap',
        h('div',
          h('b', `${d.pickup_name} → ${d.drop_area || 'Customer'}`),
          h('div.small.muted', `${d.category} · ${d.distance_km} km · ${d.package_count} pkg · ${d.weight_kg} kg${d.special_handling ? ' · Fragile/Special' : ''} · Runner payout ${inr(d.earning)}`),
        ),
        can('orders.write') && d.open ? h('button.btn.sm', { type: 'button', onClick: () => { editingParcel = !editingParcel; draw(); } }, editingParcel ? 'Close parcel editor' : 'Edit parcel details') : null,
      ),
      editingParcel ? (() => {
        const pkgIn = h('input.input', { type: 'number', min: 1, max: 50, value: d.package_count || 1 });
        const wtIn = h('input.input', { type: 'number', min: 50, max: 150000, value: d.weight_g || 500 });
        const specIn = h('input', { type: 'checkbox', checked: Boolean(d.special_handling) });
        const noteIn = h('input.input', { type: 'text', value: d.pickup_instructions || '', placeholder: 'Pickup note for runner (e.g. Gate 2 counter)' });
        return h('div.stack.sm', { style: { borderTop: '1px solid #e5e8f0', paddingTop: '10px' } },
          h('div.form-grid',
            h('label.field', h('span.label', 'Package count'), pkgIn),
            h('label.field', h('span.label', 'Weight (grams)'), wtIn),
            h('label.field.full', h('span.label', 'Pickup instructions'), noteIn),
            h('label.row', specIn, h('span.small', 'Requires special / fragile handling')),
          ),
          h('div.row', h('button.btn.sm.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, async () => {
            await api(`/seller/deliveries/${deliveryCode}/parcel`, { method: 'PATCH', body: { package_count: Number(pkgIn.value), weight_g: Number(wtIn.value), special_handling: specIn.checked, pickup_instructions: noteIn.value.trim() } });
            editingParcel = false;
            toast('Parcel details saved and runner suitability recalculated.', 'success');
            await refresh();
          }) }, 'Save parcel details')));
      })() : null,
    )));

    // Privacy-safe map
    const mapNode = runnerSvgMap(d, allCands);
    if (mapNode) nodes.push(mapNode);

    // Filter & sort bar
    const vehSel = h('select.input', { style: { width: 'auto' }, onChange: (e) => { vehicleFilter = e.target.value; draw(); } },
      VEHICLE_FILTER.map(([k, l]) => h('option', { value: k, selected: vehicleFilter === k }, l)));
    const sortSel = h('select.input', { style: { width: 'auto' }, onChange: (e) => { sortBy = e.target.value; draw(); } },
      [['score', 'Sort: Best match'], ['distance', 'Nearest to shop'], ['eta', 'Fastest total ETA'], ['rating', 'Highest rated']].map(([k, l]) => h('option', { value: k, selected: sortBy === k }, l)));
    const eligToggle = h('label.row.small', { style: { cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: onlyEligible, onChange: (e) => { onlyEligible = e.target.checked; draw(); } }),
      `Eligible only (${stateData.eligible_count}/${allCands.length})`);

    nodes.push(h('div.row.between.wrap',
      h('div.row.wrap', vehSel, sortSel, eligToggle),
      h('button.btn.sm', { type: 'button', onClick: (e) => busy(e.currentTarget, refresh) }, 'Refresh live availability'),
    ));

    // No-runner-available fallback banner (never silently converts customer delivery into store pickup!)
    if (!stateData.eligible_count && d.open) {
      nodes.push(banner('warn', h('div.row.between.wrap',
        h('div', h('b', 'No eligible runner available right now. '), 'Your order stays open safely — wait & retry, or switch to Deliver Myself (customer home delivery is never converted to store pickup).'),
        d.order_code && can('orders.write') ? h('button.btn.sm.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, async () => {
          await api(`/seller/orders/${d.order_code}/fulfilment`, { method: 'POST', body: { mode: 'self' } });
          toast('Switched order to Deliver Myself. Complete delivery with the customer\'s 4-digit code.', 'success');
          cleanup(); close(); reload();
        }) }, 'Switch to Deliver Myself') : null)));
    }

    // Runner cards
    if (!visible.length) {
      nodes.push(emptyState({ ico: 'users', title: 'No runners match these filters', text: 'Clear filters or refresh live availability.' }));
    } else {
      nodes.push(h('div.list', visible.map((c) => h('div.list-row', { style: { alignItems: 'flex-start' } },
        h('div.grow.stack.sm',
          h('div.row.wrap',
            h('b.strong', c.name),
            h('span.tiny.muted', c.code),
            badge(c.vehicle || 'No vehicle', ''),
            c.eligible ? badge('Eligible now', 'green') : badge(c.online ? 'Not eligible' : 'Offline', 'amber'),
            c.fits_parcel ? badge(`Fits ${d.weight_kg} kg (max ${c.max_kg} kg)`, 'blue') : c.max_kg ? badge(`Max ${c.max_kg} kg / ${c.max_km} km`, 'red') : null,
          ),
          h('div.small.muted', [
            c.pickup_km !== null ? `${c.pickup_km} km from shop` : 'Location unavailable',
            c.pickup_eta_min !== null ? `Pickup ~${c.pickup_eta_min} min` : null,
            `Total ETA ~${c.trip_eta_min} min`,
            c.rating ? `★ ${c.rating}` : 'New runner',
            `${c.deliveries_done} completed`,
            `Payout ${inr(c.earning)}`,
          ].filter(Boolean).join(' · ')),
          c.reasons && c.reasons.length ? h('div.tiny.muted', `Unavailable reason: ${c.reasons.join('; ')}`) : null,
        ),
        c.eligible && can('orders.write') && !d.pending_offer
          ? h('button.btn.sm.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, async () => {
            try {
              const r = await api(`/seller/deliveries/${deliveryCode}/appoint`, { method: 'POST', body: { partner_code: c.code } });
              toast(r.message, 'success');
              await refresh();
              reload();
            } catch (err) { toast(err.message, 'error'); await refresh(); }
          }) }, 'Appoint runner')
          : null,
      ))));
    }
    container.replaceChildren(...nodes);
  }

  draw();
}

export async function deliveries(ctx) {
  const tab = ctx.query.tab || 'new';
  const data = await api('/seller/deliveries');
  const rows = data.board[tab] || [];
  subscribe(() => { if (location.pathname.startsWith('/seller/deliveries')) reload(); });
  const cov = data.coverage;

  return h('div.stack',
    pageHead({
      title: 'Local deliveries', subtitle: 'Prepare packed orders, find and appoint a NearBuy runner, verify pickup handover, and track deliveries live.',
      trail: ['Deliveries'],
      actions: [
        data.test_tools ? h('button.btn.primary', { type: 'button', onClick: () => openTestOrder(data) }, icon('plus', 'sm'), 'Create test delivery') : null,
        h('button.btn', { type: 'button', onClick: () => reload() }, 'Refresh'),
      ],
    }),
    banner(cov.ok ? '' : 'warn', cov.message),
    h('div.card',
      tabs(TABS.map(([key, label]) => ({ key, label, count: (data.board[key] || []).length })), tab, (key) => `/seller/deliveries?tab=${key}`),
      rows.length ? h('div.list', rows.map((d) => h('div.list-row',
        h('div.grow',
          h('div.row.wrap', h('a.strong', { href: `/seller/deliveries/${d.code}` }, d.code), h('a.small.muted', { href: `/seller/orders/${d.order_code}` }, d.order_code), pill(d), demoTag(d.is_demo)),
          h('div.small.muted', `${d.drop.name} · ${d.drop.area || d.drop.address} · ${rowMeta(d)}`),
          d.partner ? h('div.small', `Assigned runner: ${d.partner.name} (${d.partner.code})${d.partner.vehicle ? ` · ${d.partner.vehicle}` : ''}${d.eta_at ? ` · ETA ${fmtDateTime(d.eta_at)}` : ''}`) : h('div.small.muted', 'No runner assigned yet'),
          d.pickup_pin ? h('div.small', 'Pickup handover PIN: ', h('b.mono', d.pickup_pin)) : null),
        h('div.row.wrap',
          data.can_write && ACTIVE_STATUSES.includes(d.status) ? h('button.btn.sm.primary', { type: 'button', onClick: () => openFindRunner(d.code) }, 'Find a runner') : null,
          data.can_write && d.order_status === 'new' ? h('button.btn.sm.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, () => step(d.code, 'prepare')) }, 'Accept & prepare') : null,
          data.can_write && !d.ready_at && d.order_status !== 'new' && !['delivered', 'returned_to_seller', 'cancelled'].includes(d.status) ? h('button.btn.sm.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, () => step(d.code, 'ready')) }, 'Ready for pickup') : null,
          h('a.btn.sm', { href: `/seller/deliveries/${d.code}` }, 'Details')))))
        : emptyState({ ico: 'truck', title: 'Nothing in this tab', text: tab === 'new' ? 'New customer delivery orders appear here automatically as soon as customers check out.' : 'Deliveries move across tabs automatically as you prepare them and partners deliver.' })));
}

async function step(code, which) {
  try {
    const r = await api(`/seller/deliveries/${code}/${which}`, { method: 'POST', body: {} });
    toast(which === 'prepare' ? `Order accepted. Preparing (${r.delivery.prep_minutes} min).` : `Ready for pickup. Share PIN ${r.delivery.pickup_pin} with the runner.`, 'success', 6000);
    reload();
  } catch (err) { toast(err.message, 'error'); }
}

export async function deliveryDetail(ctx) {
  const { delivery: d } = await api(`/seller/deliveries/${ctx.params.code}`);
  const write = can('orders.write');
  subscribe(() => { if (location.pathname === `/seller/deliveries/${d.code}`) reload(); });
  const closed = ['delivered', 'returned_to_seller', 'cancelled'].includes(d.status);

  const actions = [];
  if (write && ACTIVE_STATUSES.includes(d.status)) actions.push(h('button.btn.primary', { type: 'button', onClick: () => openFindRunner(d.code) }, icon('users', 'sm'), 'Find a runner'));
  if (write && d.order_status === 'new') actions.push(h('button.btn.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, () => step(d.code, 'prepare')) }, 'Accept & start preparing'));
  if (write && !d.ready_at && !closed) actions.push(h('button.btn.primary', { type: 'button', onClick: (e) => busy(e.currentTarget, () => step(d.code, 'ready')) }, 'Mark ready for pickup'));
  if (write && !closed && d.pickup_pin) actions.push(h('button.btn', { type: 'button', onClick: (e) => busy(e.currentTarget, async () => {
    const r = await api(`/seller/deliveries/${d.code}/refresh-pin`, { method: 'POST', body: {} });
    toast(`New pickup PIN generated: ${r.pickup_code}`, 'success', 6000);
    reload();
  }) }, 'Refresh pickup PIN'));
  if (write && !closed && d.status !== 'picked_up' && !d.picked_up_at) actions.push(h('button.btn', { type: 'button', onClick: () => formModal({ title: 'Update preparation time', fields: [{ name: 'prep_minutes', label: 'Minutes until ready', type: 'number', min: 1, max: 180, required: true, value: d.prep_minutes || 15 }], onSubmit: async (v) => { await api(`/seller/deliveries/${d.code}/prepare`, { method: 'POST', body: v }); toast('Preparation time updated.', 'success'); reload(); } }) }, 'Change prep time'));
  if (write && d.status === 'delivered') actions.push(h('button.btn', { type: 'button', onClick: () => openReturnPickup(d) }, 'Request return pickup'));
  if (write) actions.push(h('button.btn', { type: 'button', onClick: () => openIssue(d) }, 'Report an issue'));

  const pinBox = d.pickup_pin && !d.picked_up_at && !closed ? banner('', [h('b', 'Pickup handover PIN: '), h('span.mono', { style: { fontSize: '18px', fontWeight: '700', letterSpacing: '3px' } }, d.pickup_pin), ' — share this code with the assigned NearBuy runner at handover.']) : null;
  const track = d.track_url ? h('a.btn.sm', { href: d.track_url, target: '_blank', rel: 'noopener' }, 'Open customer tracking page') : null;

  return h('div.stack.lg',
    pageHead({ title: `Delivery ${d.code}`, trail: [['Deliveries', '/seller/deliveries'], d.code], tag: [pill(d), ' ', demoTag(d.is_demo)], subtitle: `${d.order_code} · ${rowMeta(d)}`, actions: [h('a.btn', { href: `/seller/orders/${d.order_code}` }, 'Open order'), track] }),
    pinBox,
    actions.length ? h('div.row.wrap', actions) : null,
    h('div.grid.main-side',
      h('div.stack',
        card({ title: 'Timeline', body: timeline(d.history.map((e) => ({ title: e.label, note: e.note, actor: e.actor, created_at: e.created_at })), { doneAll: true }) }),
        card({ title: 'Proofs and handovers', body: d.proofs.length ? h('div.list', d.proofs.map((p) => h('div.list-row', h('div.grow', h('b', `${p.stage} — ${p.method}`), p.note ? h('div.small.muted', p.note) : null), h('span.small.muted', fmtDateTime(p.created_at))))) : h('p.small.muted', 'Pickup and delivery proofs are recorded automatically when the partner verifies each OTP handover.') })),
      h('div.stack',
        card({ title: 'Assigned runner', body: d.partner ? kv([['Name', d.partner.name], ['Partner ID', d.partner.code], ['Vehicle', d.partner.vehicle || '—'], ['ETA', d.eta_at ? fmtDateTime(d.eta_at) : '—']]) : h('div.stack.sm', h('p.small.muted', 'No runner assigned yet. Use Find a runner to inspect eligible local partners and send an appointment offer.'), write && ACTIVE_STATUSES.includes(d.status) ? h('button.btn.sm.primary', { type: 'button', onClick: () => openFindRunner(d.code) }, 'Find a runner') : null) }),
        card({ title: 'Customer & drop-off', body: kv([['Recipient', d.drop.name], ['Address', d.drop.address], ['Area', d.drop.area || '—'], ['Packages', `${d.package_count} (${(d.weight_g / 1000).toFixed(1)} kg)`], ['Payment', d.payment_type === 'cod' ? `Cash on delivery · ${inr(d.cod_amount)}` : 'Prepaid'], ['Delivery fee', inr(d.customer_fee)]]) }))));
}

function openIssue(d) {
  formModal({
    title: `Report an issue · ${d.code}`, submitLabel: 'Send to operations',
    fields: [
      { name: 'category', label: 'Category', type: 'select', required: true, options: [['delayed', 'Delayed delivery'], ['missing_parcel', 'Missing parcel'], ['incorrect_delivery', 'Incorrect delivery'], ['partner_conduct', 'Partner conduct'], ['seller_handover', 'Handover problem'], ['other', 'Other']] },
      { name: 'subject', label: 'Subject', required: true }, { name: 'description', label: 'What happened', type: 'textarea', rows: 4, required: true },
    ],
    onSubmit: async (v) => { const r = await api(`/seller/deliveries/${d.code}/issues`, { method: 'POST', body: v }); toast(`Ticket ${r.code} raised with operations.`, 'success'); },
  });
}

function openReturnPickup(d) {
  formModal({
    title: `Request return pickup · ${d.order_code}`, subtitle: 'Creates a reverse pickup task for the delivery partner network.', submitLabel: 'Create return pickup',
    fields: [{ name: 'reason', label: 'Reason', required: true, placeholder: 'Customer requested return / exchange' }],
    onSubmit: async (v) => { const r = await api(`/seller/deliveries/${d.code}/return-pickup`, { method: 'POST', body: v }); toast(`Return pickup ${r.delivery_code} created.`, 'success'); reload(); },
  });
}

async function openTestOrder(data) {
  const opts = await api('/seller/deliveries/test-orders/options');
  const quoteBox = h('div.small.muted', 'Enter a PIN code in a served zone to see the delivery fee quote.');
  const fields = [
    field({ name: 'category', label: 'Category', type: 'select', options: Object.entries(opts.categories), value: 'grocery', required: true }),
    field({ name: 'payment', label: 'Payment', type: 'select', options: [['cod', 'Cash on delivery'], ['prepaid', 'Prepaid']], value: 'cod', required: true }),
    field({ name: 'customer_name', label: 'Customer name', value: 'Ananya Verma', required: true }),
    field({ name: 'customer_phone', label: 'Customer mobile', value: '9810455512', required: true }),
    field({ name: 'address', label: 'Delivery address', value: 'C-14 Green Park Extension', required: true, full: true }),
    field({ name: 'pincode', label: 'PIN code', value: '110016', required: true }),
    field({ name: 'instructions', label: 'Delivery instructions', placeholder: 'Optional' }),
  ];
  const form = h('form.stack', h('div.form-grid', fields), quoteBox, h('div.row', h('button.btn', { type: 'button', onClick: async () => {
    const v = Object.fromEntries(new FormData(form));
    try { const q = await api('/seller/deliveries/test-orders/quote', { method: 'POST', body: v }); quoteBox.textContent = `${q.zone.name} · ${q.distance_km} km · customer fee ${inr(q.fee.total)} · partner earning ${inr(q.earning.total)}`; } catch (e) { quoteBox.textContent = e.message; }
  } }, 'Check delivery quote'), h('button.btn.primary', { type: 'submit' }, 'Create test delivery')));
  const { close } = modal({ title: 'Create a test delivery (non-production)', subtitle: 'Real customer orders arrive automatically from the NearBuy Customer Storefront. Use this tool only to simulate a delivery in testing environments.', wide: true, body: form });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api('/seller/deliveries/test-orders', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      close();
      toast(`Test delivery ${r.delivery_code} created (DEMO DATA).`, 'success');
      reload();
    } catch (err) { toast(err.message, 'error'); }
  });
}
