# NearBuy platform audit — 15 November 2026

Scope: the repository in this workspace (`nearbuy-one` v2.8.0). Everything below was read from the code and the
running server, not assumed from screens. Where a claim is about behaviour, the API route and/or the test that proves
it is named.

## 1. Stack and structure

| Layer | What actually exists |
| --- | --- |
| Server | Node 22 built-ins only (`node:http`, `node:sqlite`, `node:crypto`). No framework, no build step, no runtime dependencies. Entry point `server/index.js`, route registry `server/router.js`. |
| Database | SQLite file `data/seller-hub.sqlite` via `node:sqlite` — WAL, `foreign_keys = ON`, `busy_timeout = 4000`. Migrations are `CREATE TABLE IF NOT EXISTS` blocks in `server/db.js` (35 tables) and `server/delivery/schema.js` (30 tables), applied on boot. |
| Transactions | `tx()` in `server/db.js` uses `BEGIN IMMEDIATE` with nesting via a depth counter. Stock changes go through `server/stock.js` only. |
| Frontend | Plain ES modules, no bundler shipped. Six browser apps: marketing home (`index.html`), Seller Hub (`/seller/`), delivery partner app (`/runner/`), control tower (`/control-tower/`), fleet portal (`/fleet/`), customer tracking (`/track/`), plus the client-side "NearBuy One" demo portal (`/portal.html`). |
| Security | Session cookies (HttpOnly, SameSite, optional CHIPS), `X-NearBuy-Request` + same-origin CSRF check, per-route permission strings, server-side role resolution, rate limiting, CSP per app family. |
| Email | `server/mail.js` — SMTP when configured, otherwise an outbox table; the server logs that mail is not configured. |

## 2. What is fully operational (server-enforced, database-backed)

| Area | Evidence |
| --- | --- |
| Seller accounts, email verification, onboarding, team roles | `server/routes/account.js`, `server/auth.js`; `tests/seller-hub.test.cjs` |
| Catalogue, variants, images, inventory movements, reservations | `server/routes/catalog.js`, `server/stock.js` |
| Seller order lifecycle (accept → process → pack → ready → dispatch → deliver, cancel, returns) with stock reservation/release, ledger and settlement | `server/routes/orders.js`, `server/routes/finance.js`; `tests/seller-hub.test.cjs` |
| Delivery network: partner onboarding, document verification, zones, fees, dispatch, offers, assignment, pickup OTP, delivery OTP, proof, COD, earnings, payouts, support tickets, audit log | `server/delivery/*`; `tests/delivery-network.test.cjs` |
| Concurrency guard on assignment | `UPDATE deliveries SET partner_id = ? WHERE id = ? AND partner_id IS NULL AND status IN (...)` in `server/delivery/engine.js` |
| Customer tracking page with live ETA, delivery code, rating, problems | `/track/`, `/api/track/:token` |
| Seller ↔ delivery linkage | `deliveries.order_id`, `E.ensureDelivery(order)`, `E.onOrderChanged()` |

## 3. What was missing, partial or simulated (found in this audit)

| Finding | Detail | Verdict |
| --- | --- | --- |
| Customer portal was client-side only | `nearbuy.js` (5,953 lines, powers `/portal.html`) contains **zero** `fetch()` calls. Products, shops, cart, orders and the "customer account" live in `localStorage` under one key. The page itself says "This is a demo account. Details are stored only in this browser." | **Simulated** |
| No customer identity | `users` + `sessions` exist but every session resolves to a seller team membership. There was no customer profile, no customer session cookie, no customer-owned order access rule. | **Not implemented** |
| No marketplace checkout | Order creation existed only as `createOrder(sellerId, ...)` called from the seller's "test order" tool (`server/delivery/testorders.js`) whose own comment says "the marketplace has no connected customer checkout yet". | **Not implemented** |
| Orders are seller-scoped only | `orders.seller_id NOT NULL`, no parent customer order, so a multi-shop cart had nowhere to live. | **Not implemented** |
| No store pickup | Checkout had no fulfilment choice; the delivery engine assumed every serviceable order becomes a network delivery. | **Not implemented** |
| No seller fulfilment decision | The network delivery was created automatically; the seller could not choose "deliver myself" and had no "find a runner" screen of their own (only operations could assign manually, at `/api/admin/deliveries/:code/assign`). | **Partial** |
| One shop in the database | The seed creates a single approved seller, so "discover nearby shops" and multi-shop checkout could not be exercised. | **Partial** |
| Payments | Records and ledger exist (`transactions`, `settlements`, `refunds`, `cod_transactions`); no payment provider is integrated and none claims to be. | **Not integrated (by design)** |
| Deployment | No `netlify.toml`, no functions. The live Netlify address can only serve the static files; the API needs a Node host. | **Not configured** |

## 4. Classification requested in the brief

| Class | Items |
| --- | --- |
| A. Fully operational | Seller Hub end to end; delivery network end to end; tracking; auth; team roles; audit; reports/CSV; support tickets |
| B. Partially operational | Seller fulfilment choice (network only); marketplace order origin (test-order tool only); shop discovery (single shop) |
| C. Frontend-only demonstrations | `/portal.html` ("NearBuy One") customer shopping, its account, its orders, its seller/runner onboarding wizards; the 3D marketing pages |
| D. Browser storage as storage | `portal.html` state (`localStorage`), its "cart", "orders", "profile" and onboarding checklists |
| E. Not implemented | Customer accounts; marketplace checkout; multi-shop parent orders; store pickup; customer notification centre; payment gateway |
| F. Broken/incorrectly connected | Nothing found that was wired but non-functional; the gap was the missing bridge between the storefront demo and the server |

## 5. Work carried out after this audit

The audit gate for the mission is the bridge between a real customer and the existing, already-correct seller and
delivery systems. Implemented in this pass:

1. **Customer accounts and sessions** (`server/routes/customer.js`) — separate `nb_customer_sid` cookie, real
   registration, sign-in, sign-out, profile and address book, rate-limited, password rules shared with the seller auth.
2. **Live marketplace** — shops discovered from the database by delivery pincode and zone, real catalogue/stock/prices,
   search and category filters. Two extra served shops are seeded (stationery and general store) so the marketplace is
   genuinely multi-shop.
3. **Checkout with one authoritative order** — one parent `customer_orders` record plus one `orders` row per shop, each
   carrying its own fulfilment choice (`delivery` or `pickup`), the server-quoted delivery fee, reserved stock inside a
   single `BEGIN IMMEDIATE` transaction, and a delivery job created only for shops that deliver.
4. **Store pickup** — free by platform rule, with a collection code the seller verifies; no delivery record, no fee.
5. **Seller fulfilment decision** — "Deliver myself" (releases the network delivery, seller completes with the customer
   code) or "Find a NearBuy runner" (ranked eligible partners, appoint one, offer expires and can be re-appointed).
6. **Customer order history and notification centre** — real statuses, runner name and ETA for delivery orders,
   collection code for pickup orders, tracking link per shop, cancellations before the seller accepts.
7. **Server-backed customer storefront** at `/customer/` in the NearBuy navy/orange identity, replacing the previous
   redirect to the localStorage demo. `/portal.html` is untouched and still available as the offline demo.

## 6. Deliberately not done in this pass

- No payment provider: orders are recorded as prepaid-on-delivery or cash on delivery; nothing claims a real charge.
- No email/SMS delivery for customer accounts beyond the existing outbox (SMTP is unset in this environment).
- The marketing pages, 3D home page and `/portal.html` demo keep their client-side behaviour; they were not rewritten.
- Netlify deployment: the server needs a Node runtime. A deployment config and environment variables are documented in
  the README but cannot be applied without credentials for that host.
