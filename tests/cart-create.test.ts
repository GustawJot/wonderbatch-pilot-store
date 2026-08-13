import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { cartResponseSchema, errorSchema } from '../src/schemas.ts';

const config = loadConfig();
const api = createClient(config);

test('POST /carts mints a fresh, empty cart and returns 201', async () => {
	const res = await api.createCart();

	assert.equal(res.status, 201);
	const body = cartResponseSchema.parse(res.body);
	assert.match(body.data.cart.id, /^crt_/);
	assert.deepEqual(body.data.cart.items, []);
	assert.equal(body.data.cart.totals.item_count, 0);
	assert.equal(body.data.cart.totals.quantity, 0);
});

/**
 * A brand-new cart has no line to derive a currency from, so totals reports
 * "0.00" in the channel's own currency rather than a placeholder or a null.
 */
test('an empty cart reports net_value 0.00 — there is no line to derive a currency from', async () => {
	const res = await api.createCart();
	const body = cartResponseSchema.parse(res.body);

	assert.equal(body.data.cart.totals.net_value, '0.00');
	// The channel's currency code itself is asserted against the catalog in
	// catalog.test.ts; here we only need cartResponseSchema's length(3) check
	// above to have already passed, which it did.
});

test('an absent body is fine — POST /carts needs no buyer_reference', async () => {
	const res = await api.createCart();
	assert.equal(res.status, 201);
});

test('a valid buyer_reference is accepted but never echoed back', async () => {
	const res = await api.createCart({ buyer_reference: 'order #4711' });

	assert.equal(res.status, 201);
	// cartSchema is .strict(), so if the server ever echoed buyer_reference
	// back onto the cart object, this parse would throw.
	cartResponseSchema.parse(res.body);
});

test('an empty-string buyer_reference is refused with 400', async () => {
	const res = await api.createCart({ buyer_reference: '' });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('a buyer_reference over 256 characters is refused with 400', async () => {
	const res = await api.createCart({ buyer_reference: 'x'.repeat(257) });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('two calls to POST /carts mint two distinct cart ids', async () => {
	const first = cartResponseSchema.parse((await api.createCart()).body);
	const second = cartResponseSchema.parse((await api.createCart()).body);

	assert.notEqual(first.data.cart.id, second.data.cart.id);
});

test('no Authorization header is refused with 401, same as the catalog', async () => {
	const res = await api.createCart({ token: null });

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
