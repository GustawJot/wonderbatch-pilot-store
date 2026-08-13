import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { cartResponseSchema, errorSchema, productListSchema } from '../src/schemas.ts';

const api = createClient(loadConfig());

const catalog = productListSchema.parse((await api.listProducts({ limit: 50 })).body);
const purchasableVariant = catalog.data.products
	.flatMap((p) => p.variants)
	.find((v) => v.is_purchasable);
const otherVariant = catalog.data.products
	.flatMap((p) => p.variants)
	.find((v) => v.is_purchasable && v.variant_id !== purchasableVariant?.variant_id);

if (!purchasableVariant) {
	throw new Error(
		'No purchasable variant in the test catalog — cart-items-update.test.ts needs at least one.',
	);
}

/** A fresh cart with exactly one line: purchasableVariant at quantity 1. */
async function cartWithOneLine(): Promise<string> {
	const created = cartResponseSchema.parse((await api.createCart()).body);
	await api.addCartItem(created.data.cart.id, { variant_id: purchasableVariant.variant_id, quantity: 1 });
	return created.data.cart.id;
}

test('PATCH sets the quantity of an existing line', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, { quantity: 5 });

	assert.equal(res.status, 200);
	const body = cartResponseSchema.parse(res.body);
	const line = body.data.cart.items.find((i) => i.variant_id === purchasableVariant.variant_id);
	assert.equal(line?.quantity, 5);
});

test('PATCH accepts the upper boundary, quantity 99, without consulting the previous quantity', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, { quantity: 99 });

	assert.equal(res.status, 200);
	const body = cartResponseSchema.parse(res.body);
	const line = body.data.cart.items.find((i) => i.variant_id === purchasableVariant.variant_id);
	assert.equal(line?.quantity, 99);
});

/**
 * `quantity: 0` on PATCH is a 400, not a removal — the API is documented to
 * point the caller at DELETE instead, precisely so "set to zero" and "remove
 * the line" stay two distinct, unambiguous operations.
 */
test('quantity 0 on PATCH is refused with 400 pointing at DELETE', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, { quantity: 0 });

	assert.equal(res.status, 400);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'validation');
	assert.match(body.error.message, /delete/i);
});

test('quantity 100 on PATCH is refused with 400', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, { quantity: 100 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('a negative quantity on PATCH is refused with 400', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, { quantity: -1 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('PATCH naming a variant_id that is not a line in this cart 404s', async () => {
	const cartId = await cartWithOneLine();

	const target = otherVariant ?? { variant_id: 'ffffffffffffffffffffffff' };
	const res = await api.updateCartItem(cartId, target.variant_id, { quantity: 2 });

	assert.equal(res.status, 404);
	assert.equal(errorSchema.parse(res.body).error.category, 'not_found');
});

// SKIPPED — "PATCH never re-checks purchasability" (a line whose variant has
// since gone unavailable can still be freely reduced or raised) needs a
// variant that WAS purchasable at add-time and became unpurchasable
// afterwards. This HTTP-only suite has no way to flip that state mid-test; it
// would need seller-side or DB access to force the transition.

test('a valid buyer_reference on PATCH is accepted but never echoed back', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, {
		quantity: 3,
		buyer_reference: 'reorder for the office',
	});

	assert.equal(res.status, 200);
	cartResponseSchema.parse(res.body);
});

test('an invalid buyer_reference on PATCH is refused with 400 and the quantity is unchanged', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(cartId, purchasableVariant.variant_id, {
		quantity: 42,
		buyer_reference: '',
	});

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');

	const after = cartResponseSchema.parse((await api.getCart(cartId)).body);
	const line = after.data.cart.items.find((i) => i.variant_id === purchasableVariant.variant_id);
	assert.equal(line?.quantity, 1, 'the rejected buyer_reference let the quantity change through anyway');
});

test('no Authorization header is refused with 401', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.updateCartItem(
		cartId,
		purchasableVariant.variant_id,
		{ quantity: 2 },
		{ token: null },
	);

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
