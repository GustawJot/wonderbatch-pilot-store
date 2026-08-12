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

## Adding endpoints

Each new endpoint is one function in `src/client.ts`, one schema in
`src/schemas.ts`, and one test file. The cart endpoints (3c) will be the first
that hold state between requests.
