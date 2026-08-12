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
test('a 401 still carries CORS headers', async () => {
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
