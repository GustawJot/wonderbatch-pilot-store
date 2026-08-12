# Storefront API Conformance Client — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone Node test suite in `wonderbatch-pilot-store` that proves the Wonderbatch storefront API v1 contract over HTTP, from outside the monolith.

**Architecture:** Three units — a request layer that owns HTTP and never throws on non-2xx, a set of strict zod schemas that are the declared contract, and test files grouped by what they prove. A pre-test reachability check fails once with a clear message instead of letting every test fail with connection-refused.

**Tech Stack:** Node 22, `node:test`, `zod`. Nothing else.

**Spec:** `../wonderbatch/__documentation/engine-modularity/phase4-conformance-client-spec.md`

## Global Constraints

- **Node 22.x.** TypeScript runs via type-stripping (`--experimental-strip-types`); there is no compile step and no type-checking in the suite.
- **Exactly one dependency: `zod@^3.23.8`.** Pinned to v3 because these schemas use `.strict()`, which v3 supports directly.
- **No database access, ever.** No `MONGODB_URI`, no `mongodb` driver, no import from the Wonderbatch repo. The isolation is the point.
- **No browser, no Playwright, no UI.**
- **Tests run against `npm run dev` on port 3000.** `npm run preview` was investigated and rejected — see Prerequisites below.
- **Exactly one assertion cannot be verified locally** — the unregistered-origin preflight. Vite's dev middleware adds `Access-Control-Allow-Origin` to any response that lacks one, on every route including plain pages, and `server.cors: false` does not disable it in Vite 8. That test is skipped when `WB_API_BASE_URL` points at localhost, with the reason printed, and runs when it points at a deployed environment.
- **The `Origin` header must be sent on every request** unless a test is deliberately omitting it. A caller that omits it skips the channel allowlist entirely and gets a 200.
- **`.env` is gitignored and stays that way.** Never commit it, never echo the token into output or commit messages.
- All commands run from the pilot repo root unless stated otherwise.

---

> **Correction, 2026-08-12 (during implementation).** As first drafted, this
> plan contradicted itself: the Prerequisites below record that `preview` is
> unusable locally and `dev` is the way, but Task 2 Step 7, Task 5 Step 2 and
> Task 9's README template still carried older "use preview, NOT dev" text.
> Those three spots have been corrected in place, along with `.env.example`.
> The Prerequisites were re-verified against the live API before any code was
> written: a registered origin gets the app's own lowercase allow-origin
> header, an unregistered one gets Vite's capitalised injected header — the
> exact discriminator described below.

## Prerequisites — COMPLETED 2026-08-12, in the Wonderbatch repo

A session scoped to this repo cannot do these. They are already done; recorded
here so the plan is self-contained and nobody repeats the investigation.

**The API must be running before `npm test`:**

```bash
cd ../wonderbatch/web && npm run dev
```

**`npm run preview` was tried and rejected.** Two independent things break it
locally, both confirmed by request:

1. The build is production-mode, so `dev` is false and `hooks.server.ts`'s
   non-primary-domain rule fires — `host: localhost` is neither
   `wonderbatch.coffee` nor `*.vercel.app`, so **every** request 301s to
   `http://wonderbatch.coffee:3000/pl/...`, API routes included. The storefront
   API's own hook opt-out sits after that block, so it never gets the chance to
   run. (Harmless on every deployed environment, whose hosts all match. Filed
   separately as a hooks-ordering fix.)
2. Vite's preview server answers unrecognised Host headers with its own 403,
   so spoofing the Host to dodge (1) does not work either.

**What this costs.** Vite's dev middleware stamps
`Access-Control-Allow-Origin: <request origin>` on any response that does not
already carry one — verified on plain page routes as well as the API, and
`server.cors: false` does not turn it off in Vite 8.1.0. Our own headers arrive
lowercase; Vite's arrive capitalised, which is how the two are told apart.

Exactly **one** assertion is affected: a preflight from an *unregistered* origin
should carry no allow-origin header, and locally it appears to carry one. Every
other assertion in this plan is unaffected, because Vite only ever *adds* a
missing header — it never changes a status code, a body, or a header we set
ourselves. Task 6 skips that one test against localhost and runs it against a
deployed base URL.

**`web/vite.config.ts` already carries a `preview.port: 3000` pin** with a
comment recording the above, so the Vite default of 4173 — which is a registered
origin on the `hayb-store` channel — can never collide if preview becomes usable
later.

---

### Task 2: Repo scaffolding, config, and the reachability check

Makes the repo runnable and makes misconfiguration fail once, clearly, before any test runs.

**Files:**
- Create: `package.json`
- Create: `src/config.ts`
- Create: `scripts/check-api-up.ts`
- Create: `tests/config.test.ts`

**Interfaces:**
- Consumes: the four `.env` variables (already present)
- Produces: `loadConfig(env?): PilotConfig` with fields `apiBaseUrl`, `origin`, `token`, `channelKey`. Every later task imports this.

- [ ] **Step 1: Create `package.json`**

```json
{
	"name": "wonderbatch-pilot-store",
	"version": "0.1.0",
	"private": true,
	"type": "module",
	"description": "Conformance client for the Wonderbatch storefront API v1. HTTP only — no database access by design.",
	"engines": {
		"node": ">=22"
	},
	"scripts": {
		"test": "node --env-file=.env scripts/check-api-up.ts && node --env-file=.env --test tests/*.test.ts",
		"check": "node --env-file=.env scripts/check-api-up.ts"
	},
	"dependencies": {
		"zod": "^3.23.8"
	}
}
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: `zod` installed, `node_modules/` created (already gitignored).

- [ ] **Step 3: Write the failing test**

Create `tests/config.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig returns all four values from the environment', () => {
	const config = loadConfig({
		WB_API_BASE_URL: 'http://localhost:3000',
		WB_PILOT_ORIGIN: 'http://localhost:5173',
		WB_STOREFRONT_TOKEN: 'wb_pk_test',
		WB_CHANNEL_KEY: 'hayb-store',
	});

	assert.equal(config.apiBaseUrl, 'http://localhost:3000');
	assert.equal(config.origin, 'http://localhost:5173');
	assert.equal(config.token, 'wb_pk_test');
	assert.equal(config.channelKey, 'hayb-store');
});

test('loadConfig names every missing variable at once', () => {
	assert.throws(
		() => loadConfig({ WB_API_BASE_URL: 'http://localhost:3000' }),
		(err: Error) => {
			assert.match(err.message, /WB_PILOT_ORIGIN/);
			assert.match(err.message, /WB_STOREFRONT_TOKEN/);
			assert.match(err.message, /WB_CHANNEL_KEY/);
			return true;
		},
	);
});

test('loadConfig strips a trailing slash from the base URL', () => {
	const config = loadConfig({
		WB_API_BASE_URL: 'http://localhost:3000/',
		WB_PILOT_ORIGIN: 'http://localhost:5173',
		WB_STOREFRONT_TOKEN: 'wb_pk_test',
		WB_CHANNEL_KEY: 'hayb-store',
	});

	assert.equal(config.apiBaseUrl, 'http://localhost:3000');
});

test('loadConfig rejects an origin with a trailing slash', () => {
	assert.throws(
		() =>
			loadConfig({
				WB_API_BASE_URL: 'http://localhost:3000',
				WB_PILOT_ORIGIN: 'http://localhost:5173/',
				WB_STOREFRONT_TOKEN: 'wb_pk_test',
				WB_CHANNEL_KEY: 'hayb-store',
			}),
		/trailing slash/,
	);
});
```

The last test matters: the guard compares origins by exact string, so a trailing slash would never match the allowlist and every request would 403 for a reason nobody would guess.

- [ ] **Step 4: Run it and watch it fail**

```bash
node --test tests/config.test.ts
```

Expected: FAIL — `Cannot find module '../src/config.ts'`.

- [ ] **Step 5: Write `src/config.ts`**

```ts
/**
 * Configuration for the conformance client.
 *
 * Deliberately absent: any database URI. This client proves the API by using
 * it, and a client that could read the database could accidentally prove the
 * API works by reading around it.
 */

export interface PilotConfig {
	/** The Wonderbatch API we call. No trailing slash. */
	apiBaseUrl: string;
	/** What we claim to be. Must exactly match an entry in the channel's allowlist. */
	origin: string;
	/** The `wb_pk_` publishable token. */
	token: string;
	/** Never sent — the API resolves the channel from the token. Ours to assert against. */
	channelKey: string;
}

const REQUIRED = [
	'WB_API_BASE_URL',
	'WB_PILOT_ORIGIN',
	'WB_STOREFRONT_TOKEN',
	'WB_CHANNEL_KEY',
] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): PilotConfig {
	const missing = REQUIRED.filter((key) => !env[key]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variable(s): ${missing.join(', ')}.\n` +
				`Copy .env.example to .env and fill it in.`,
		);
	}

	const origin = env.WB_PILOT_ORIGIN!;
	if (origin.endsWith('/')) {
		throw new Error(
			`WB_PILOT_ORIGIN has a trailing slash ("${origin}").\n` +
				`The API compares origins by exact string, so this would never match the ` +
				`channel allowlist and every request would 403.`,
		);
	}

	return {
		apiBaseUrl: env.WB_API_BASE_URL!.replace(/\/+$/, ''),
		origin,
		token: env.WB_STOREFRONT_TOKEN!,
		channelKey: env.WB_CHANNEL_KEY!,
	};
}
```

- [ ] **Step 6: Run the tests and watch them pass**

```bash
node --test tests/config.test.ts
```

Expected: 4 passing.

- [ ] **Step 7: Write the reachability check**

Create `scripts/check-api-up.ts`:

```ts
/**
 * Runs before the suite. One clear failure beats twenty connection-refused
 * errors that all say the same thing.
 */

import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const url = `${config.apiBaseUrl}/api/external/storefront/v1/products`;

let response: Response;
try {
	response = await fetch(url, {
		headers: { Authorization: `Bearer ${config.token}`, Origin: config.origin },
		signal: AbortSignal.timeout(10_000),
	});
} catch {
	console.error(
		`✗ Cannot reach the API at ${config.apiBaseUrl}.\n\n` +
			`  Start it from the Wonderbatch repo:\n` +
			`    cd ../wonderbatch/web && npm run dev\n\n` +
			`  Use dev, NOT preview. A production build treats localhost as a\n` +
			`  non-primary domain and 301s every request — API routes included —\n` +
			`  to http://wonderbatch.coffee:3000, so nothing here can reach it.`,
	);
	process.exit(1);
}

if (response.status === 401) {
	console.error(
		`✗ The API is up but rejected the token (401).\n\n` +
			`  Re-mint it from the Wonderbatch repo:\n` +
			`    cd ../wonderbatch/web && node --env-file=.env.development \\\n` +
			`      scripts/mint-storefront-token.mjs --channel=${config.channelKey} --commit\n\n` +
			`  Then paste the new value into .env as WB_STOREFRONT_TOKEN.`,
	);
	process.exit(1);
}

if (response.status === 403) {
	console.error(
		`✗ The API is up but refused our origin (403): ${config.origin}\n\n` +
			`  That origin is not in the channel's security.allowed_origins.\n` +
			`  Comparison is by exact string — check for a trailing slash or a wrong port.`,
	);
	process.exit(1);
}

if (!response.ok) {
	console.error(`✗ Unexpected status ${response.status} from ${url}`);
	process.exit(1);
}

console.log(`✓ API reachable at ${config.apiBaseUrl}, token and origin accepted.`);
```

- [ ] **Step 8: Run it against the live dev server**

```bash
npm run check
```

Expected: `✓ API reachable at http://localhost:3000, token and origin accepted.`

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/config.ts scripts/check-api-up.ts tests/config.test.ts
git commit -m "feat: config loader and pre-test reachability check"
```

---

### Task 3: The HTTP request layer

The only file that knows about HTTP. Every later task talks to the API through it.

**Files:**
- Create: `src/client.ts`
- Create: `tests/client.test.ts`

**Interfaces:**
- Consumes: `loadConfig(): PilotConfig` from Task 2
- Produces: `createClient(config: PilotConfig): ApiClient` with methods `listProducts(options?)`, `getProduct(productGroupId, options?)`, `preflight(path, options?)`. All return `Promise<ApiResult>` = `{ status: number; headers: Headers; body: unknown }`. `RequestOverrides` = `{ token?: string | null; origin?: string | null }` where `null` **omits** the header and `undefined` uses the configured value.

- [ ] **Step 1: Write the failing test**

Create `tests/client.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';

const api = createClient(loadConfig());

test('listProducts returns status, headers and a parsed body', async () => {
	const res = await api.listProducts();

	assert.equal(res.status, 200);
	assert.equal(typeof res.headers.get('content-type'), 'string');
	assert.ok(res.body && typeof res.body === 'object');
});

test('a refusal is returned as data, not thrown', async () => {
	const res = await api.listProducts({ token: null });

	assert.equal(res.status, 401);
	assert.ok(res.body && typeof res.body === 'object');
});

test('query parameters reach the API', async () => {
	const res = await api.listProducts({ limit: 1 });
	const body = res.body as { data: { products: unknown[] } };

	assert.equal(res.status, 200);
	assert.equal(body.data.products.length, 1);
});
```

The second test is the important one: on this surface a 403 is the thing under test, so the client must never throw on a non-2xx.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --env-file=.env --test tests/client.test.ts
```

Expected: FAIL — `Cannot find module '../src/client.ts'`.

- [ ] **Step 3: Write `src/client.ts`**

```ts
/**
 * The request layer — the only file here that knows about HTTP.
 *
 * It NEVER throws on a non-2xx response. On this surface a 401 or a 403 is the
 * behaviour under test, not a failure, so refusals come back as data like any
 * other response.
 */

import type { PilotConfig } from './config.ts';

const BASE_PATH = '/api/external/storefront/v1';

export interface ApiResult {
	status: number;
	headers: Headers;
	/** Parsed JSON, or the raw text when the body is not JSON (204s included). */
	body: unknown;
}

export interface RequestOverrides {
	/** `null` omits the Authorization header. `undefined` uses the configured token. */
	token?: string | null;
	/** `null` omits the Origin header — which skips the allowlist entirely. */
	origin?: string | null;
}

export interface ListOptions extends RequestOverrides {
	limit?: number | string;
	offset?: number | string;
}

export interface ApiClient {
	listProducts(options?: ListOptions): Promise<ApiResult>;
	getProduct(productGroupId: string, options?: RequestOverrides): Promise<ApiResult>;
	preflight(path: string, options?: Pick<RequestOverrides, 'origin'>): Promise<ApiResult>;
}

export function createClient(config: PilotConfig): ApiClient {
	async function request(
		path: string,
		options: RequestOverrides & { method?: string; query?: Record<string, string> } = {},
	): Promise<ApiResult> {
		const url = new URL(`${config.apiBaseUrl}${BASE_PATH}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(key, value);
		}

		const headers = new Headers();

		const token = options.token === undefined ? config.token : options.token;
		if (token !== null) headers.set('Authorization', `Bearer ${token}`);

		const origin = options.origin === undefined ? config.origin : options.origin;
		if (origin !== null) headers.set('Origin', origin);

		const response = await fetch(url, {
			method: options.method ?? 'GET',
			headers,
			signal: AbortSignal.timeout(30_000),
		});

		const text = await response.text();
		let body: unknown = text;
		try {
			body = text === '' ? null : JSON.parse(text);
		} catch {
			// Leave `body` as the raw text — an HTML error page is worth seeing
			// in the assertion output rather than swallowing as a parse failure.
		}

		return { status: response.status, headers: response.headers, body };
	}

	return {
		listProducts(options = {}) {
			const query: Record<string, string> = {};
			if (options.limit !== undefined) query.limit = String(options.limit);
			if (options.offset !== undefined) query.offset = String(options.offset);
			return request('/products', { ...options, query });
		},

		getProduct(productGroupId, options = {}) {
			return request(`/products/${encodeURIComponent(productGroupId)}`, options);
		},

		preflight(path, options = {}) {
			return request(path, { ...options, method: 'OPTIONS', token: null });
		},
	};
}
```

Note `preflight` forces `token: null` — browsers send no credentials on a preflight, so a client that sent one would be testing a request no browser will ever make.

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --env-file=.env --test tests/client.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add src/client.ts tests/client.test.ts
git commit -m "feat: HTTP request layer that returns refusals as data"
```

---

### Task 4: The declared contract — strict schemas

**Files:**
- Create: `src/schemas.ts`
- Create: `tests/schemas.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `productListSchema`, `productDetailSchema`, `errorSchema`, `wireProductSchema`, `wireVariantSchema`, `paginationSchema` — all zod schemas, all `.strict()`

- [ ] **Step 1: Write the failing test**

Create `tests/schemas.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireVariantSchema, wireProductSchema, errorSchema } from '../src/schemas.ts';

const validVariant = {
	variant_id: '507f1f77bcf86cd799439011',
	net_weight: 250,
	net_price: '39.90',
	currency: 'PLN',
	sku: null,
	ean: null,
	availability: 'in_stock',
	is_purchasable: true,
};

test('a well-formed variant validates', () => {
	assert.doesNotThrow(() => wireVariantSchema.parse(validVariant));
});

test('an UNEXPECTED field fails validation', () => {
	assert.throws(() => wireVariantSchema.parse({ ...validVariant, surprise: 'hello' }));
});

test('a missing field fails validation', () => {
	const { currency, ...withoutCurrency } = validVariant;
	assert.throws(() => wireVariantSchema.parse(withoutCurrency));
});

test('net_price must be a fixed-2-decimal string, not a number', () => {
	assert.throws(() => wireVariantSchema.parse({ ...validVariant, net_price: 39.9 }));
	assert.throws(() => wireVariantSchema.parse({ ...validVariant, net_price: '39.9' }));
});

test('a product needs at least one variant', () => {
	assert.throws(() =>
		wireProductSchema.parse({
			product_group_id: 'hayb-brasil-espresso',
			name: 'Brasil Espresso',
			product_type: null,
			description: null,
			image_url: null,
			attributes: null,
			variants: [],
		}),
	);
});

test('the error envelope validates', () => {
	assert.doesNotThrow(() =>
		errorSchema.parse({
			success: false,
			error: { category: 'authentication', message: 'Invalid publishable token' },
		}),
	);
});
```

The unexpected-field test is the one that makes this a conformance suite rather than a smoke test.

- [ ] **Step 2: Run it and watch it fail**

```bash
node --test tests/schemas.test.ts
```

Expected: FAIL — `Cannot find module '../src/schemas.ts'`.

- [ ] **Step 3: Write `src/schemas.ts`**

```ts
/**
 * The declared contract of the storefront API v1.
 *
 * STRICT IN BOTH DIRECTIONS. Unknown fields fail as well as missing ones,
 * because an additive change is still a consumer-visible contract change and a
 * real store's parser may not tolerate it. Forcing every change through this
 * file makes it conscious.
 *
 * Shapes mirror `WireProduct` / `WireVariant` in the Wonderbatch repo at
 * `web/src/routes/api/external/storefront/v1/_serialize.ts`. They are restated
 * rather than imported, deliberately: importing would weld this client to the
 * monolith and destroy the only property that makes it worth having.
 */

import { z } from 'zod';

export const wireVariantSchema = z
	.object({
		variant_id: z.string().min(1),
		net_weight: z.number().positive(),
		/** Net, fixed 2 decimals, as a string — never a float. */
		net_price: z.string().regex(/^\d+\.\d{2}$/),
		currency: z.string().length(3),
		sku: z.string().nullable(),
		ean: z.string().nullable(),
		availability: z.string().min(1),
		is_purchasable: z.boolean(),
	})
	.strict();

export const wireProductSchema = z
	.object({
		product_group_id: z.string().min(1),
		name: z.string().min(1),
		product_type: z.string().nullable(),
		description: z.string().nullable(),
		image_url: z.string().nullable(),
		attributes: z.record(z.unknown()).nullable(),
		/**
		 * At least one. The list never fetches unlisted rows and the detail
		 * endpoint 404s when every variant is hidden, so an empty array should be
		 * unreachable on the wire.
		 */
		variants: z.array(wireVariantSchema).min(1),
	})
	.strict();

export const paginationSchema = z
	.object({
		total: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		offset: z.number().int().nonnegative(),
		has_more: z.boolean(),
	})
	.strict();

export const productListSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				products: z.array(wireProductSchema),
				pagination: paginationSchema,
				currency: z.string().length(3),
				locale: z.string().min(2),
			})
			.strict(),
	})
	.strict();

export const productDetailSchema = z
	.object({
		success: z.literal(true),
		data: z
			.object({
				product: wireProductSchema,
				currency: z.string().length(3),
				locale: z.string().min(2),
			})
			.strict(),
	})
	.strict();

export const errorSchema = z
	.object({
		success: z.literal(false),
		error: z
			.object({
				category: z.string().min(1),
				message: z.string().min(1),
				code: z.string().optional(),
				field: z.string().optional(),
				details: z.record(z.unknown()).optional(),
			})
			.strict(),
	})
	.strict();
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
node --test tests/schemas.test.ts
```

Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts tests/schemas.test.ts
git commit -m "feat: strict response schemas for storefront API v1"
```

---

### Task 5: Auth conformance

**Files:**
- Create: `tests/auth.test.ts`

**Interfaces:**
- Consumes: `createClient`, `loadConfig`, `errorSchema`
- Produces: nothing

- [ ] **Step 1: Write the tests**

Create `tests/auth.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { errorSchema } from '../src/schemas.ts';

const config = loadConfig();
const api = createClient(config);

test('a valid token from a registered origin is accepted', async () => {
	const res = await api.listProducts();
	assert.equal(res.status, 200);
});

test('no Authorization header is refused with 401', async () => {
	const res = await api.listProducts({ token: null });

	assert.equal(res.status, 401);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'authentication');
});

test('an unrecognised token is refused with 401', async () => {
	const res = await api.listProducts({ token: 'wb_pk_definitely_not_a_real_token' });

	assert.equal(res.status, 401);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'authentication');
});

test('an unregistered origin is refused with 403 and the message names it', async () => {
	const res = await api.listProducts({ origin: 'http://localhost:59999' });

	assert.equal(res.status, 403);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'authorization');
	assert.match(body.error.message, /http:\/\/localhost:59999/);
});

/**
 * DELIBERATE, NOT A BUG.
 *
 * CORS is a browser mechanism. A caller that sends no Origin skips the
 * allowlist and receives the full catalog — which is correct, because the
 * publishable token unlocks nothing private and `allowed_origins` was never a
 * wall around the API.
 *
 * Asserted here so that anyone "fixing" it has to change this test on purpose.
 */
test('omitting the Origin header entirely still returns 200', async () => {
	const res = await api.listProducts({ origin: null });
	assert.equal(res.status, 200);
});
```

- [ ] **Step 2: Run them**

```bash
node --env-file=.env --test tests/auth.test.ts
```

Expected: 5 passing.

Note: an unregistered-origin **GET** returns 403 on `vite dev` too. Vite only ever *adds* a missing allow-origin header; it never changes a status code. Only the preflight header-absence assertion in Task 6 is affected by dev mode.

- [ ] **Step 3: Commit**

```bash
git add tests/auth.test.ts
git commit -m "test: auth conformance for the storefront API"
```

---

### Task 6: CORS conformance

**Files:**
- Create: `tests/cors.test.ts`

**Interfaces:**
- Consumes: `createClient`, `loadConfig`
- Produces: nothing

- [ ] **Step 1: Write the tests**

Create `tests/cors.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const api = createClient(config);

const UNREGISTERED = 'http://localhost:59999';

/**
 * Vite's dev middleware stamps `Access-Control-Allow-Origin` onto any response
 * that does not already carry one — every route, not just the API, and
 * `server.cors: false` does not disable it in Vite 8. It only ADDS a missing
 * header, so it cannot affect any other assertion here; but it makes exactly
 * one of them untestable locally, because "no allow-origin header" is the thing
 * being asserted.
 *
 * Ours arrive lowercase, Vite's arrive capitalised, if you ever need to tell
 * them apart by hand.
 */
const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(config.apiBaseUrl);
const localSkip =
	'Vite injects a permissive allow-origin header locally. Point WB_API_BASE_URL ' +
	'at a deployed environment to run this.';

test('a 200 echoes our origin exactly — never a wildcard', async () => {
	const res = await api.listProducts();

	assert.equal(res.headers.get('access-control-allow-origin'), config.origin);
	assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
});

test('responses vary on Origin so a shared cache cannot cross stores', async () => {
	const res = await api.listProducts();
	assert.match(res.headers.get('vary') ?? '', /Origin/i);
});

test('credentials are never allowed — this surface takes no cookies', async () => {
	const res = await api.listProducts();
	assert.equal(res.headers.get('access-control-allow-credentials'), null);
});

/**
 * A 401 without CORS headers reaches a store developer's console as an opaque
 * CORS error with no status and no body, so a wrong token looks identical to a
 * misconfigured origin. That is a debugging trap, and this is the guard against
 * it regressing.
 */
test('a 403 still carries CORS headers', async () => {
	const res = await api.listProducts({ origin: config.origin, token: 'wb_pk_wrong' });
	assert.equal(res.status, 401);
	assert.match(res.headers.get('vary') ?? '', /Origin/i);
});

test('a preflight from a registered origin is approved', async () => {
	const res = await api.preflight('/products');

	assert.equal(res.status, 204);
	assert.equal(res.headers.get('access-control-allow-origin'), config.origin);
	assert.equal(res.headers.get('access-control-allow-methods'), 'GET, POST, PATCH, DELETE, OPTIONS');
	assert.equal(res.headers.get('access-control-allow-headers'), 'Content-Type, Authorization');
	assert.equal(res.headers.get('access-control-max-age'), '86400');
});

/**
 * The load-bearing one, and the only assertion this suite cannot make locally.
 *
 * An unregistered origin should get a 204 with NO allow-origin header — the
 * browser blocks the real request, and we leak nothing about which origins are
 * registered. See the note above for why localhost cannot prove it.
 *
 * The 204 itself IS checked locally; only the header absence is skipped.
 */
test('an unregistered origin still gets a 204 preflight', async () => {
	const res = await api.preflight('/products', { origin: UNREGISTERED });
	assert.equal(res.status, 204);
});

test(
	'a preflight from an unregistered origin gets no allow-origin header',
	{ skip: isLocal ? localSkip : false },
	async () => {
		const res = await api.preflight('/products', { origin: UNREGISTERED });

		assert.equal(res.status, 204);
		assert.equal(res.headers.get('access-control-allow-origin'), null);
	},
);
```

- [ ] **Step 2: Run them**

```bash
node --env-file=.env --test tests/cors.test.ts
```

Expected: 6 passing.

- [ ] **Step 3: Commit**

```bash
git add tests/cors.test.ts
git commit -m "test: CORS conformance, including the unregistered-origin preflight"
```

---

### Task 7: Catalog shape conformance

**Files:**
- Create: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `createClient`, `loadConfig`, `productListSchema`, `productDetailSchema`
- Produces: nothing

- [ ] **Step 1: Write the tests**

Create `tests/catalog.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { productListSchema, productDetailSchema } from '../src/schemas.ts';

const config = loadConfig();
const api = createClient(config);

test('the product list matches the declared contract exactly', async () => {
	const res = await api.listProducts();

	assert.equal(res.status, 200);
	const body = productListSchema.parse(res.body);
	assert.ok(body.data.products.length > 0, 'the test channel should list products');
});

test('the list reports the channel currency and locale', async () => {
	const res = await api.listProducts();
	const body = productListSchema.parse(res.body);

	assert.equal(body.data.currency, 'PLN');
	assert.equal(body.data.locale, 'pl');
});

test('product detail matches the declared contract exactly', async () => {
	const list = productListSchema.parse((await api.listProducts({ limit: 1 })).body);
	const groupId = list.data.products[0].product_group_id;

	const res = await api.getProduct(groupId);

	assert.equal(res.status, 200);
	const body = productDetailSchema.parse(res.body);
	assert.equal(body.data.product.product_group_id, groupId);
});

/**
 * A REGRESSION GUARD, NOT A HYPOTHETICAL.
 *
 * 3b shipped with these two endpoints disagreeing: detail returned `hidden`
 * variants that the list omitted, publishing weights a seller had specifically
 * declined to sell — to anyone who viewed their store's page source.
 */
test('list and detail return identical variants for the same product', async () => {
	const list = productListSchema.parse((await api.listProducts()).body);

	for (const product of list.data.products) {
		const detail = productDetailSchema.parse(
			(await api.getProduct(product.product_group_id)).body,
		);

		assert.deepEqual(
			detail.data.product.variants.map((v) => v.variant_id).sort(),
			product.variants.map((v) => v.variant_id).sort(),
			`list and detail disagree for ${product.product_group_id}`,
		);
	}
});

/**
 * DELIBERATELY BRITTLE.
 *
 * `image_url` is null because product images still live on
 * `sales-channel.listings`, and a storefront reading the marketplace's catalog
 * is exactly the crossing this initiative exists to delete. When Phase 2a's
 * card editor gives images a seller-owned home, THIS TEST WILL FAIL — and that
 * failure is the alarm saying a consumer-visible contract change just happened.
 * Update it deliberately at that point; do not loosen it now.
 */
test('image_url is null on every product until 2a gives images a home', async () => {
	const list = productListSchema.parse((await api.listProducts()).body);

	for (const product of list.data.products) {
		assert.equal(product.image_url, null, `${product.product_group_id} has an image_url`);
	}
});
```

- [ ] **Step 2: Run them**

```bash
node --env-file=.env --test tests/catalog.test.ts
```

Expected: 5 passing.

- [ ] **Step 3: Commit**

```bash
git add tests/catalog.test.ts
git commit -m "test: catalog shape, list/detail agreement, and the image_url alarm"
```

---

### Task 8: Paging and not-found conformance

**Files:**
- Create: `tests/paging.test.ts`

**Interfaces:**
- Consumes: `createClient`, `loadConfig`, `productListSchema`, `errorSchema`
- Produces: nothing

- [ ] **Step 1: Write the tests**

Create `tests/paging.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { productListSchema, errorSchema } from '../src/schemas.ts';

const api = createClient(loadConfig());

test('with no limit given, a default is applied', async () => {
	const body = productListSchema.parse((await api.listProducts()).body);
	assert.equal(body.data.pagination.limit, 50);
	assert.equal(body.data.pagination.offset, 0);
});

test('has_more is consistent with offset, count and total', async () => {
	const body = productListSchema.parse((await api.listProducts({ limit: 1 })).body);
	const { offset, total, has_more } = body.data.pagination;

	assert.equal(has_more, offset + body.data.products.length < total);
});

test('paging through the catalog reaches every product exactly once', async () => {
	const seen: string[] = [];
	let offset = 0;

	for (;;) {
		const body = productListSchema.parse((await api.listProducts({ limit: 2, offset })).body);
		seen.push(...body.data.products.map((p) => p.product_group_id));
		if (!body.data.pagination.has_more) {
			assert.equal(seen.length, body.data.pagination.total);
			break;
		}
		offset += 2;
		assert.ok(offset < 100, 'paging loop did not terminate');
	}

	assert.equal(new Set(seen).size, seen.length, 'a product appeared on two pages');
});

/**
 * `limit=0` returns an empty page while `has_more` stays true, so a paging loop
 * never terminates and never advances. Refused rather than served.
 */
test('limit=0 is refused with 400', async () => {
	const res = await api.listProducts({ limit: 0 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('a non-numeric limit is refused rather than silently defaulted', async () => {
	const res = await api.listProducts({ limit: 'abc' });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('a limit above the ceiling is refused with 400', async () => {
	const res = await api.listProducts({ limit: 201 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('a negative offset is refused with 400', async () => {
	const res = await api.listProducts({ offset: -1 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('an unknown product_group_id returns 404', async () => {
	const res = await api.getProduct('this-product-does-not-exist');

	assert.equal(res.status, 404);
	assert.equal(errorSchema.parse(res.body).error.category, 'not_found');
});
```

- [ ] **Step 2: Run them**

```bash
node --env-file=.env --test tests/paging.test.ts
```

Expected: 8 passing.

Both constants used here were read from Wonderbatch source on 2026-08-12: `DEFAULT_LIMIT = 50` and `MAX_LIMIT = 200` in `products/+server.ts`, and `not_found` in the `ErrorCategory` union in `lib/shared/errors/types.ts`. If a run disagrees, correct the test to the observed value — never change the API to satisfy this suite.

- [ ] **Step 3: Add the enumeration test**

The fully-hidden product this needs was confirmed on the dev database on 2026-08-12: **`hayb-espresso-blend-espresso`** — one 250 g variant, not listed on `hayb-store`. It is one of 21 fully-hidden groups belonging to that seller, against 5 that the channel actually lists.

Append to `tests/paging.test.ts`:

```ts
/**
 * A fully-hidden product must be indistinguishable from a nonexistent one.
 * Otherwise the status code alone lets someone enumerate a seller's catalog by
 * guessing slugs — and slugs are guessable by construction
 * (`{seller}-{product}-{method}`).
 *
 * `hayb-espresso-blend-espresso` exists in warehouse.inventory but is not
 * listed on hayb-store. If it is ever listed, this test starts failing with a
 * 200 — swap in another unlisted group rather than deleting the test.
 */
test('a fully-hidden product 404s exactly like an unknown one', async () => {
	const hidden = await api.getProduct('hayb-espresso-blend-espresso');
	const unknown = await api.getProduct('this-product-does-not-exist');

	assert.equal(hidden.status, 404);
	assert.equal(unknown.status, 404);
	assert.deepEqual(hidden.body, unknown.body);
});
```

- [ ] **Step 4: Run the file again**

```bash
node --env-file=.env --test tests/paging.test.ts
```

Expected: 9 passing.

- [ ] **Step 5: Commit**

```bash
git add tests/paging.test.ts
git commit -m "test: paging bounds, validation refusals and not-found behaviour"
```

---

### Task 9: README and the first full green run

**Files:**
- Create: `README.md`

**Interfaces:**
- Consumes: everything
- Produces: nothing

- [ ] **Step 1: Run the whole suite**

```bash
npm test
```

Expected: the reachability check passes, then every test file runs green.

- [ ] **Step 2: Write `README.md`**

```markdown
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

Use `dev`, **not** `preview` — a preview build 301s every request off
localhost. See the README for the full reason and for the single assertion this
costs us.

Then:

```bash
npm test
```

## Configuration

Copy `.env.example` to `.env` and fill it in. `.env` is gitignored — it holds a
live publishable token.

The origin must exactly match an entry in the channel's
`security.allowed_origins`. Comparison is by exact string, so a trailing slash
never matches.

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
```

- [ ] **Step 3: If the enumeration test was skipped in Task 8, record it**

Append to `README.md` under a new `## Known gaps` heading:

```markdown
## Known gaps

- The enumeration guard (a fully-hidden product must 404 identically to a
  nonexistent one) is untested: the dev channel has no fully-hidden product to
  test against. Add the test when one exists.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: how to run the conformance client and why it exists"
```

- [ ] **Step 5: Final verification**

```bash
npm test
```

Expected: green, top to bottom, with roughly 35 assertions across seven files.

---

## Self-review notes

**Spec coverage.** Every row of the spec's coverage table maps to a task: auth → Task 5, CORS → Task 6, catalog and `image_url` → Task 7, paging and 404 → Task 8. The list/detail agreement guard is Task 7. The fail-fast behaviour is Task 2. The port pin is Task 1. The one spec row that may not survive contact with reality — the fully-hidden product — has an explicit check and an explicit instruction not to fake it.

**Where the expected values come from.** Every status code, header value and error category in this plan was observed against the live API with curl on 2026-08-12, except four constants read directly from Wonderbatch source: `DEFAULT_LIMIT = 50`, `MAX_LIMIT = 200`, the `ErrorCategory` union, and the `WireProduct` / `WireVariant` field lists. Nothing here is guessed.

**The test channel's data, confirmed 2026-08-12.** `hayb-store` lists 6 variants across 5 products; the seller has 26 product groups in total, so 21 are fully hidden from this channel. Four of the five visible products have a hidden sibling variant (a 250 g or 1 kg the seller declined to list), which is what gives Task 7's list/detail agreement test real teeth — if hidden variants ever leak back into the detail response, four of five products would disagree.
