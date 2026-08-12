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
