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

if (!purchasableVariant) {
	throw new Error(
		'No purchasable variant in the test catalog — cart-items-remove.test.ts needs at least one.',
	);
}

async function cartWithOneLine(): Promise<string> {
	const created = cartResponseSchema.parse((await api.createCart()).body);
	await api.addCartItem(created.data.cart.id, { variant_id: purchasableVariant.variant_id, quantity: 1 });
	return created.data.cart.id;
}

test('DELETE removes an existing line and returns 200 with the current cart', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.removeCartItem(cartId, purchasableVariant.variant_id);

	assert.equal(res.status, 200);
	const body = cartResponseSchema.parse(res.body);
	assert.equal(
		body.data.cart.items.some((i) => i.variant_id === purchasableVariant.variant_id),
		false,
	);
});

/**
 * IDEMPOTENCY IS THE POINT. Unlike PATCH on an absent line (404), DELETE on
 * an absent line still succeeds — a double-click on "remove" in a real store
 * must not surface an error the buyer has no way to make sense of.
 */
test('removing an already-removed line is idempotent — still 200, not 404', async () => {
	const cartId = await cartWithOneLine();
	await api.removeCartItem(cartId, purchasableVariant.variant_id);

	const res = await api.removeCartItem(cartId, purchasableVariant.variant_id);

	assert.equal(res.status, 200);
	const body = cartResponseSchema.parse(res.body);
	assert.equal(
		body.data.cart.items.some((i) => i.variant_id === purchasableVariant.variant_id),
		false,
	);
});

test('removing a line from a cart that never had it also returns 200, not 404', async () => {
	const created = cartResponseSchema.parse((await api.createCart()).body);

	const res = await api.removeCartItem(created.data.cart.id, purchasableVariant.variant_id);

	assert.equal(res.status, 200);
	cartResponseSchema.parse(res.body);
});

/**
 * `variant_id` is documented as the 24-character hex `inventory._id`. A
 * malformed value can't even resolve to "absent line" — it fails validation
 * before any lookup, which is why this is the one case in the cart surface
 * where DELETE is NOT idempotent-successful.
 */
test('a malformed (non-hex) variant_id is refused with 400', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.removeCartItem(cartId, 'not-a-valid-hex-variant-id');

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('an unknown cart_id 404s rather than reporting the line removed', async () => {
	const res = await api.removeCartItem(
		'crt_this_token_was_never_minted_000000000000',
		purchasableVariant.variant_id,
	);

	assert.equal(res.status, 404);
	assert.equal(errorSchema.parse(res.body).error.category, 'not_found');
});

test('no Authorization header is refused with 401', async () => {
	const cartId = await cartWithOneLine();

	const res = await api.removeCartItem(cartId, purchasableVariant.variant_id, { token: null });

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
