# wonderbatch-pilot-store

A conformance client for the Wonderbatch storefront API v1.

It is not a storefront. It is a test suite that talks to the API over HTTP and
nothing else — the first consumer written from outside the monolith.

## Why it exists

Wonderbatch's own tests cover the storefront API well, but all of them stand
inside the process they are testing. That blind spot is not theoretical: the
dev server was found injecting permissive CORS headers that made an
unregistered origin look approved, and no in-process test could have seen it.

## The one rule

**No database access, ever.** This repo has no `MONGODB_URI` and no driver. A
client that could read the database could accidentally prove the API works by
reading around it.

## Running it

The API must be running first:

```bash
cd ../wonderbatch/web && npm run dev
```

Use `dev`, **not** `preview`. Preview does not work locally, for two reasons
measured on 2026-08-12:

1. Vite's preview server stamps a wildcard `Access-Control-Allow-Origin` on any
   response lacking one, so CORS is no more honest there than in dev.
2. A preview build runs in production mode, which loads `.env.production` — so
   it connects to the **production database**, and a token that is valid on dev
   is rejected. That is a footgun in its own right and is filed separately.

A third reason, a 301 that redirected API routes into localized HTML pages, was
fixed on 2026-08-12 and no longer applies.

Then:

```bash
npm test
```

`npm test` runs a reachability check first, so a server that is down or a token
that has expired fails once with a clear message instead of failing every test
with connection-refused.

## What `dev` costs us

Vite's dev middleware stamps `Access-Control-Allow-Origin` onto any response
that does not already carry one — every route, not just the API, and
`server.cors: false` does not disable it in Vite 8. It only ever *adds* a
missing header; it never changes a status code, a body, or a header we set
ourselves.

So exactly **one** assertion is affected: a preflight from an *unregistered*
origin should carry no allow-origin header, and locally it appears to carry
one. That test is skipped against localhost — with its reason printed, so the
gap is visible in the run output — and runs when `WB_API_BASE_URL` points at a
deployed environment. Its 204 status is still checked locally.

Ours arrive lowercase, Vite's arrive capitalised, if you ever need to tell them
apart by hand.

## Running against a deployed environment

Point `WB_API_BASE_URL` at a deployed host and the locally-skipped preflight
assertion runs for real:

```bash
WB_API_BASE_URL=https://dev.wonderbatch.coffee npm test
```

`dev.` and `preview.wonderbatch.coffee` sit behind Vercel SSO
(`ssoProtection: all_except_custom_domains`), so an unauthenticated request
302s to `vercel.com/sso-api` and never reaches the app. Set `WB_VERCEL_BYPASS`
to the project's Protection Bypass for Automation secret to get past the edge.
The reachability check detects that redirect and says so by name rather than
letting the suite fail with something unrecognisable.

The client uses `redirect: 'manual'` throughout: a redirect is an observation,
not a detour. Following one silently would mean asserting against a login page.

### The unregistered-origin preflight, verified 2026-08-12

This is the one assertion the suite cannot make against localhost, and it is
the load-bearing one: an unregistered origin must get a 204 carrying **no**
`access-control-allow-origin`, so the browser blocks the real request and we
leak nothing about which origins are registered.

On 2026-08-12 the full suite ran green against `dev.wonderbatch.coffee` —
**41 passing, 0 skipped, 0 failing** — with that assertion executing rather
than skipping. It was independently confirmed against production, which is not
SSO-protected and runs no Vite middleware:

```
OPTIONS /api/external/storefront/v1/products
Origin: http://localhost:59999
→ 204, vary: Origin, allow-methods/headers/max-age present
→ NO access-control-allow-origin
```

The app withholds the header, exactly as the contract requires. The header that
appears locally is Vite's injection, not ours — which is the whole reason this
suite exists outside the monolith.

The same run also showed the bypass header does not perturb CORS: every CORS
assertion behaved identically to a local run, so the secret really is consumed
at the edge and never reaches the app's own logic.

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored — it holds a
live publishable token.

The origin must exactly match an entry in the channel's
`security.allowed_origins`. Comparison is by exact string, so a trailing slash
never matches — `loadConfig` rejects one outright rather than letting every
request 403 for a reason nobody would guess.

## Two tests that are supposed to be annoying

- **`image_url` is asserted null on every product.** When Phase 2a gives
  product images a seller-owned home, this fails on purpose — it is the alarm
  saying a consumer-visible contract change happened.
- **Unknown response fields fail validation.** Adding a field to the API is
  still a contract change, and a real store's parser may not tolerate it.

## What the orders tests cost (3c-4a)

The order endpoints cannot be conformance-tested without using them:
`tests/orders.test.ts` places a REAL pending order in the dev database and
decrements REAL dev stock, shared with the dev marketplace. There is no
cleanup — this repo has no DB access by design (the one rule), so the rows
are accepted dev litter.

**One full run costs exactly 1 pending order and 2 units of stock** on the
first purchasable variant in the catalog. Everything shares that single
placement: the happy path, the idempotent replay, and every `GET /orders/:id`
assertion. The `INSUFFICIENT_STOCK` path reserves nothing.

Two dev-data invariants the file leans on (both explained in its header):

- **Every variant's stock stays ≤ 100.** The stock-refusal test over-requests
  99 (the cart's per-line cap) of the same variant the shared placement
  bought 2 of; reservation succeeds at equality, so stock must sit below 99
  by then. That is also why the placement buys 2 and not 1 — at the measured
  dev stock of exactly 100, a quantity-1 placement would leave 99 and the
  99-request would PLACE a real 99-unit order instead of refusing.
- **The first purchasable variant keeps a few units.** The full suite drains
  3 per run — 2 in `orders.test.ts` plus 1 in `payments.test.ts` (below) —
  so ~33 runs from a full shelf of 100; restock it — to at most 100 — when
  it runs low.

## What the payment tests cost (3c-4b)

`tests/payments.test.ts` shares the same reality: its fixture is a REAL
pending order (1 more order, 1 more unit of stock per run, same accepted
dev litter as above), and its subject is a REAL processor session — **one
card order on the payment processor's SANDBOX per run**, plus the engine's
own payment-intent row for it. The sandbox order is never paid; it expires
on the processor's side. No cleanup on either — the one rule.

The contract's own replay semantics are what keep that footprint flat: the
suite creates exactly ONE session, and every further session call — the
replay test, the ignored-metadata test, the path/query test — returns the
stored session without touching the processor, while the refusal probes are
turned away before any lookup. The verify poll is the one exception in
mechanics, not in cost: while the order is unsettled it DOES ask the
processor for the order's live status — a read that creates nothing, so it
still costs nothing new. No emails fire on any path this suite takes: a
pending placement sends nothing, and a happy-path session/verify alerts
nobody.

File order is load-bearing: `payments` sorts after `orders`, so the stock
arithmetic in `orders.test.ts` (above) sees the shelf before this file's
1-unit drain. Money never moves, so the paid-side answers (`already_paid`,
`{status: "paid"}`) are pinned as schemas only — see the file header.

## Adding endpoints

Each new endpoint is one function in `src/client.ts`, one schema in
`src/schemas.ts`, and one test file. The cart endpoints (3c) will be the first
that hold state between requests.

## Known gaps

- **Cart endpoint coverage exists but has not run against a live server.**
  `createCart`/`getCart`/`addCartItem`/`updateCartItem`/`removeCartItem` and
  their five test files (branch `feat/3c-2-cart-conformance`) were written
  against the API those endpoints ship on
  (`feat/3c-2-cart-endpoints` in the Wonderbatch repo, local-only, not yet
  deployed anywhere). The "41 passing" figure above is the catalog suite
  only — it does not yet include the cart tests. See that branch's
  `task-5-report.md` for exactly what's verified vs. inferred.
