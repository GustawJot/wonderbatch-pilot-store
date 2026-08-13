import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { cartResponseSchema, errorSchema, productListSchema } from '../src/schemas.ts';

const api = createClient(loadConfig());

/**
 * Every test here needs a real, purchasable variant_id from the channel's own
 * catalog — this suite has no other way to know one exists. Fetched once, at
 * module load, before any test runs.
 */
const catalog = productListSchema.parse((await api.listProducts({ limit: 50 })).body);
const purchasableVariant = catalog.data.products
	.flatMap((p) => p.variants)
	.find((v) => v.is_purchasable);
const unpurchasableVariant = catalog.data.products
	.flatMap((p) => p.variants)
	.find((v) => !v.is_purchasable);

if (!purchasableVariant) {
	throw new Error(
		'No purchasable variant in the test catalog — cart-items-add.test.ts needs at least one.',
	);
}

async function freshCart(): Promise<string> {
	const body = cartResponseSchema.parse((await api.createCart()).body);
	return body.data.cart.id;
}

test('adding a purchasable variant returns 200 with the line on the cart', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 2 });

	assert.equal(res.status, 200);
	const body = cartResponseSchema.parse(res.body);
	const line = body.data.cart.items.find((i) => i.variant_id === purchasableVariant.variant_id);
	assert.ok(line, 'the added variant is missing from the cart');
	assert.equal(line.quantity, 2);
	assert.equal(line.unit_price.net, purchasableVariant.net_price);
	assert.equal(line.unit_price.currency, purchasableVariant.currency);
	assert.equal(line.is_purchasable, true);
	assert.equal(line.image_url, null);
});

test('adding the same variant twice increments the line, not duplicates it', async () => {
	const cartId = await freshCart();

	await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 3 });
	const res = await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 4 });

	assert.equal(res.status, 200);
	const body = cartResponseSchema.parse(res.body);
	const lines = body.data.cart.items.filter((i) => i.variant_id === purchasableVariant.variant_id);
	assert.equal(lines.length, 1, 'the variant appears as more than one line');
	assert.equal(lines[0].quantity, 7);
});

test('an unknown variant_id 404s rather than 400s', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(cartId, { variant_id: 'ffffffffffffffffffffffff', quantity: 1 });

	assert.equal(res.status, 404);
	assert.equal(errorSchema.parse(res.body).error.category, 'not_found');
});

// SKIPPED — a fully-hidden or seller-unlisted variant must 404 identically to
// an unknown one (same anti-enumeration rule as the catalog's product
// detail), but minting a variant_id for a variant this channel has hidden
// requires either DB access or a seller-side mutation, neither of which this
// HTTP-only suite has. paging.test.ts covers the equivalent guarantee for
// GET /products/:product_group_id.

test('quantity 0 on POST is refused with 400', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 0 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

test('quantity above 99 on a fresh line is refused with 400', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 100 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');
});

/**
 * THE CAP-CROSSING CASE. `POST` binds the cap to the RESULTING line, not the
 * increment: adding 10 to an existing line of 95 would total 105, so it must
 * be refused outright — and, just as important, the existing 95 must be left
 * untouched rather than partially applied.
 */
test('a POST that would push an existing line past 99 is refused, and the line is untouched', async () => {
	const cartId = await freshCart();
	await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 95 });

	const res = await api.addCartItem(cartId, { variant_id: purchasableVariant.variant_id, quantity: 10 });

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');

	const after = cartResponseSchema.parse((await api.getCart(cartId)).body);
	const line = after.data.cart.items.find((i) => i.variant_id === purchasableVariant.variant_id);
	assert.equal(line?.quantity, 95, 'the cap-crossing add partially applied instead of being refused whole');
});

test(
	'a currently-unpurchasable but still-listed variant is refused with 409 variant_not_purchasable',
	{
		skip: unpurchasableVariant
			? false
			: 'no unpurchasable-but-listed variant in the test catalog to exercise this against',
	},
	async () => {
		const cartId = await freshCart();

		const res = await api.addCartItem(cartId, {
			variant_id: unpurchasableVariant!.variant_id,
			quantity: 1,
		});

		assert.equal(res.status, 409);
		const body = errorSchema.parse(res.body);
		assert.equal(body.error.code, 'variant_not_purchasable');
	},
);

test('a valid buyer_reference is accepted but never echoed back on the cart', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(cartId, {
		variant_id: purchasableVariant.variant_id,
		quantity: 1,
		buyer_reference: 'gift for a friend',
	});

	assert.equal(res.status, 200);
	// cartResponseSchema is .strict() end to end, so an echoed buyer_reference
	// anywhere in the cart or its items would fail this parse.
	cartResponseSchema.parse(res.body);
});

/**
 * An invalid buyer_reference must refuse the WHOLE request — the item
 * mutation it rode in on must not partially apply.
 */
test('an invalid buyer_reference is refused with 400 and the item is not added', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(cartId, {
		variant_id: purchasableVariant.variant_id,
		quantity: 1,
		buyer_reference: 'x'.repeat(257),
	});

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.category, 'validation');

	const after = cartResponseSchema.parse((await api.getCart(cartId)).body);
	assert.deepEqual(after.data.cart.items, []);
});

test('no Authorization header is refused with 401', async () => {
	const cartId = await freshCart();

	const res = await api.addCartItem(
		cartId,
		{ variant_id: purchasableVariant.variant_id, quantity: 1 },
		{ token: null },
	);

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
