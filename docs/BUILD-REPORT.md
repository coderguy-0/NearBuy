# NearBuy platform build report — 15 November 2026

Companion to `docs/AUDIT.md`. That document records what the repository contained and how each area was classified
before work started; this one records what was built on top of it, what was actually executed to prove each claim, and
what is deliberately still a stub.

**Status legend**

| Status | Meaning |
| --- | --- |
| **Verified** | Exercised end to end against a running server by a test in `tests/`, or by an authenticated HTTP walk-through recorded below. |
| **Implemented** | Written and reachable, but not proven by an automated test (UI is checked by rendering it in jsdom, not by a browser). |
| **Demo** | Working, but explicitly demo-only: seeded sample records, on-screen codes, test locations. Never required to use the platform. |
| **Needs provider** | Structure and records exist; the external provider (payment, SMS, maps, bank) is not configured. Nothing is claimed to have happened. |
| **Not built** | Nothing pretends to exist. |

## 1. Test evidence

```
$ npm test
1..61
# tests 61
# pass 61
# fail 0
```

`tests/customer-marketplace.test.cjs` — 17 new end-to-end tests, all running the real server on a spare port against a
throwaway database:

| # | Test | What it proves |
| --- | --- | --- |
| 1 | the marketplace lists several real shops for a served PIN code | shops come from the database, filtered by the pincode's service zone; an unserved pincode returns none |
| 2 | a customer registers, signs in and keeps a private profile | real account, own session cookie, server-side profile |
| 3 | a signed-out visitor can browse but cannot order | browse is public, ordering needs a session (401) |
| 4 | one cart with three shops becomes one customer order and three shop orders | parent `CNB-` order + per-shop `ORD-` orders, one transaction, server-quoted fees, stock reserved |
| 5 | each shop sees only its own order and no other shop can open it | cross-tenant isolation on the seller API |
| 6 | another customer cannot read or cancel this order | customer-side ownership check (404/403, not silent success) |
| 7 | store pickup is collected with the code and completes the shop order | pickup fulfilment: no delivery record, no fee, collection code verified |
| 8 | a shop can switch a delivery order to its own delivery and complete it with the customer code | *deliver myself* path closes the order with the customer's code |
| 9 | find a runner: ranked candidates, an appointed offer, acceptance and assignment | matching engine output (eligibility reasons, distance, payout), appointment, partner acceptance, single assignment |
| 10 | the appointed partner delivers it with the real pickup and delivery codes | full partner walk: start → geofence refusal at 4.4 km → pickup PIN → picked up → customer delivery code → complete |
| 11 | a cancelled customer order releases stock and stops the delivery | cancellation before acceptance restores stock and cancels the delivery; after acceptance the customer gets 409 |
| 12 | two customers cannot buy the last unit at the same time | concurrent checkout of the last unit: exactly one 201, one 409, and a sold-out product leaves the catalogue |
| 13 | the storefront page is served and the delivery network still reports the same order | the storefront is served by the server; the control tower reads the same delivery row |
| 14 | a shop with no available runner is told why, and the order is not lost | every partner offline → zero eligible, reasons shown, appointment refused, order left awaiting assignment, self-delivery fallback works |
| 15 | a declined or expired offer goes back to the shop instead of vanishing | decline recorded, job returns to the shop, offer expires on the dispatch tick, re-appointment works |
| 16 | one delivery can never belong to two partners | second accept refused, re-appointing an assigned job refused, exactly one accepted offer and one `partner_id` |
| 17 | a retried checkout does not place a second order, and code guessing is limited | same `request_id` returns the same order, a new id makes a new order, six wrong PIN attempts are refused and the seventh is rate-limited |

The 44 tests that existed before this pass still pass unchanged (Seller Hub lifecycle, delivery network, discover,
product pages, storefront).

## 2. Feature status matrix

### Accounts, identity, access

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| Customer registration, sign-in, sign-out, profile, address | **Verified** | test 2; scrypt hashes, own `nb_customer_sid` cookie |
| Seller accounts, verification, team roles, invitations, reset | **Verified** | `tests/seller-hub.test.cjs` |
| Runner application, documents, approval, suspension, 18+ gate | **Verified** | `tests/delivery-network.test.cjs`; age computed from date of birth server-side |
| Fleet manager and operations accounts | **Verified** | `tests/delivery-network.test.cjs` |
| Demo accounts (~3) isolated and optional | **Verified** | seeding only when `SEED_DEMO`/non-production; platform fully usable after registering |
| Per-request permission strings, server-side only | **Verified** | tests 5, 6, 9, 11 fail with the wrong session |
| Email verification and password reset delivery | **Needs provider** | outbox rows written; SMTP unset in this environment, the log says mail was **not** sent |

### Order lifecycle

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| One parent order + one order per shop | **Verified** | test 4 |
| Per-shop fulfilment choice (delivery / collection) | **Verified** | tests 4, 7 |
| Seller accept / reject / prepare / ready | **Verified** | tests 8, 11 + Seller Hub suite |
| Seller decides *deliver myself* or *find a runner* | **Verified** | tests 8, 9 |
| Atomic single assignment (no duplicate runner) | **Verified** | conditional `UPDATE` in `server/delivery/engine.js`; test 9 asserts one owner |
| Runner matching: verification, online, distance, capacity, parcel fit, workload | **Verified** | test 9 + `GET /api/seller/deliveries/:code/candidates` reasons |
| Offer creation, expiry, decline, re-appointment | **Verified** | test 15 (decline and expiry, both driving the real dispatch tick) |
| Pickup PIN verified by server, never a button | **Verified** | test 10 |
| Customer delivery code verified by server | **Verified** | test 8 (self-delivery), test 10 (runner) |
| Arrival geofence (250 m) | **Verified** | test 10 asserts 409 `outside_geofence` at 4.4 km and success at the shop |
| Code attempt limits | **Verified** | test 17: six wrong PINs are refused, the seventh is `429 Too many incorrect codes` |
| Code expiry | **Implemented** | codes carry an expiry the server checks; no automated test forces the clock yet |
| Cancellation and stock release | **Verified** | test 11 |
| Concurrent checkout of the last unit | **Verified** | test 12 |
| Returns and refunds (seller-side) | **Verified** | Seller Hub suite |
| Store pickup collection | **Verified** | test 7 |

### Real-time and notifications

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| Live updates for delivery status (SSE) | **Verified** | partner, tower and track apps consume `/api/events`; test 13 reads the same row from the tower |
| Customer notification centre with unread counts | **Implemented** | written by the order/fulfilment paths and rendered on `#/account` |
| Notification outbox (never faked) | **Implemented** | rows written in the same transaction as the event; email leg needs SMTP |
| Push/SMS to the customer's phone | **Needs provider** | no SMS provider; on-screen codes in demo mode only |

### Money

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| Ledger on delivery, fees, GST, settlements | **Verified** | Seller Hub and delivery suites |
| Runner earnings per delivery, cash-on-delivery float limit | **Verified** | eligibility test in the delivery suite; COD limit surfaces as an eligibility reason |
| Payout records and settlement marking | **Implemented** | records only; no money moves until operations record a bank reference |
| Refunds | **Verified** | Seller Hub return flow |
| Payment gateway charge | **Needs provider** | orders store `cash` or `prepaid`; nothing claims a real charge |
| Platform fee / runner commission split | **Implemented** | stored on the delivery record and shown to the seller before appointing |

### Operations and administration

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| Control tower: live deliveries, dispatch, assign, reassign | **Verified** | delivery suite; test 13 |
| Partner verification queue and suspension | **Verified** | delivery suite |
| Zones, fees, serviceability by pincode | **Verified** | delivery suite; test 1 depends on it |
| Complaints/tickets for partners and customers | **Verified** (partner, seller) / **Implemented** (customer order issues) | delivery suite |
| Audit log for sensitive actions | **Verified** | delivery suite asserts entries; every seller/runner/admin mutation writes one |
| Reports and CSV exports | **Verified** | delivery and seller suites |

### Security

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| CSRF header + same-origin check on every mutation | **Verified** | suite-wide; requests without `X-NearBuy-Request` are refused |
| Rate limiting (sign-in, registration, codes) | **Verified** | registration limit exercised by the suite (10/min burst, 40/hour per IP) |
| Parameterised SQL everywhere | **Implemented** | reviewed; no string-built SQL with user input |
| Secrets/PII not exposed in responses | **Implemented** | pickup PIN only to the owning seller, delivery code only to the owning customer and the track link, runner phone withheld until assignment |
| Precise location privacy | **Implemented** | the runner sees the customer address only after pickup; the tower sees the delivery zone, not the customer's precise point, until assigned |
| Duplicate-request protection | **Verified** | test 17 (checkout `request_id`), test 16 (single owner); the delivery portal also accepts `Idempotency-Key` |
| Row-level security | **Not built** | SQLite has no RLS; the equivalent is enforced in the route layer. A Postgres move should translate the same rules into policies |

### Deployment

| Feature | Status | Evidence / limit |
| --- | --- | --- |
| Single-port server serving all apps | **Verified** | `npm start` |
| Netlify static hosting of the marketing site | **Verified** | the existing site is live there |
| API on a Node host (Netlify Functions or a container) | **Needs provider** | no host credentials; `netlify.toml` documents the redirect the API needs |
| Managed Postgres / Supabase migration | **Not built** | SQLite is single-node; the schema is plain SQL and ports directly |

## 3. What changed in this pass

1. `server/routes/customer.js` — customer accounts, sessions, marketplace browsing, checkout (parent + per-shop orders),
   order history, cancellation, notification centre, and the storefront asset route.
2. `server/marketplace-seed.js` — two extra served shops (stationery, general store) and one demo customer, all flagged
   demo data.
3. `server/routes/fulfilment.js` — seller fulfilment state machine: collection, self-delivery, and the transition to
   network delivery.
4. `server/delivery/engine.js`, `routes-seller.js` — runner candidates ranking and appointment, exported for the seller
   API.
5. `customer/` — the storefront: home, shops, shop, cart, checkout, orders, order detail, account, sign-in, sign-up, in
   the existing navy/orange identity.
6. `seller/app/pages-orders.js`, `pages-deliveries.js` — the fulfilment card (deliver myself / find a runner / collection)
   and the ranked runner card with reasons and payout.
7. `tests/customer-marketplace.test.cjs` — the 17 end-to-end tests above.

## 4. Phase log

| Phase | Result |
| --- | --- |
| 1 · Audit | `docs/AUDIT.md`: stack read, 35 + 30 tables listed, every area classified A–F. The gap was the customer side, not the seller or delivery side. |
| 2 · Backend and database | Customer accounts, profiles, parent/child orders, checkout transaction, marketplace queries, notifications; three seeded shops and one demo customer. |
| 3 · Customer and seller | Storefront at `/customer/` in the existing identity; Seller Hub orders now arrive from real customers and carry a fulfilment card. |
| 4 · Seller fulfilment | Collection, *deliver myself*, *find a NearBuy runner*, with the state machine and the customer codes on both paths. |
| 5 · Runner system | Candidate ranking with reasons and payout, appoint/offer/accept/decline/expire, atomic assignment, pickup and delivery verification, geofence. |
| 6 · Real-time | SSE topics for partner, tower, track and seller; customer notification centre written in the same transaction as the event. |
| 7 · Payments and admin | Earnings, cash float, settlements and payouts are records; the control tower reads the same rows. No provider, nothing claimed. |
| 8 · Security and testing | Server-side checks on every route, rate limits, idempotency, attempt limits, audit log; 61 tests green. |
| 9 · Deployment | Single-port server runs everywhere; the marketing site stays on Netlify. The API still needs a Node host — no credentials available, so not attempted. |

## 5. Known limits, stated plainly

- **No payment provider.** Orders record how they will be paid; no gateway is charged and no refund has been issued by a
  provider.
- **No email or SMS in this environment.** Every message is an outbox row; the server logs "NOT sent". Links can be
  shown on screen with `DEV_MAIL_PREVIEW=1` in non-production.
- **No maps.** Distance is straight-line × 1.35 from the pincode centre; the "map" is a coordinate plot, not tiles.
- **SQLite, single node.** `node:sqlite` is still experimental in Node 22; rate limits are in-memory, so a multi-instance
  deployment needs a shared store and a managed database.
- **The UI is verified by rendering in jsdom, not by a real browser.** Layout and tap targets were checked by eye in the
  served pages; there is no headless-browser test in this repository.
- **`/portal.html`** remains the original browser-only demo, untouched. It is documented as such and is never required.
