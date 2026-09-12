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

	// An empty catalog would make the loop below a no-op and report green. The
	// zero case is caught by the first test in this file, but a regression guard
	// that can silently assert nothing is not a regression guard.
	assert.ok(list.data.products.length > 0, 'no products to compare');

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

	// Same reason as above: an alarm that can assert nothing is not an alarm.
	assert.ok(list.data.products.length > 0, 'no products to check');

	for (const product of list.data.products) {
		assert.equal(product.image_url, null, `${product.product_group_id} has an image_url`);
	}
});

/**
 * `product_type` is the CATEGORY key (`coffee-beans`, `drip-bags`, `filters`,
 * `ceramics`, more later) and `product_family` groups categories for browsing
 * (`coffee` or `accessories`). The schema pins the open type and the closed
 * family; this pins the one fixture we know is beans, so a category rename
 * shows up here by name rather than as a parse failure three files away.
 *
 * `hayb-brasil-espresso-espresso` is the live id. The contract's example says
 * `hayb-brasil-espresso`; per its own "Examples" note, the live response wins.
 */
test('the known beans fixture is categorised coffee-beans in the coffee family', async () => {
	const res = await api.getProduct('hayb-brasil-espresso-espresso');

	assert.equal(res.status, 200);
	const { product } = productDetailSchema.parse(res.body).data;
	assert.equal(product.product_type, 'coffee-beans');
	assert.equal(product.product_family, 'coffee');
});

test('every coffee-beans product belongs to the coffee family', async () => {
	const list = productListSchema.parse((await api.listProducts()).body);
	const beans = list.data.products.filter((p) => p.product_type === 'coffee-beans');

	// The pilot channel sells beans today, so an empty set here means the
	// catalog changed under us — the fix is a new known-beans fixture, not
	// dropping the guard. A loop that can assert nothing is not an assertion.
	assert.ok(beans.length > 0, 'no coffee-beans product to check');

	for (const product of beans) {
		assert.equal(
			product.product_family,
			'coffee',
			`${product.product_group_id} is coffee-beans but not in the coffee family`,
		);
	}
});

/**
 * THE INVARIANT THE CONTRACT STATES OUTRIGHT. `axis` is what the buyer picks
 * between and `net_weight` is what ships; for a variant sold by weight they
 * are the same number. The schema enforces this on every parse — this test is
 * the readable statement of it, walked over the live catalog.
 */
test('on every weight variant, axis.value equals net_weight', async () => {
	const list = productListSchema.parse((await api.listProducts()).body);
	const weightVariants = list.data.products.flatMap((p) =>
		p.variants.filter((v) => v.axis.kind === 'weight').map((v) => ({ product: p, variant: v })),
	);

	// Everything listed today is sold by weight, so an empty set here means the
	// catalog changed under us, not that the invariant holds vacuously.
	assert.ok(weightVariants.length > 0, 'no weight variant to check');

	for (const { product, variant } of weightVariants) {
		assert.equal(
			variant.axis.value,
			variant.net_weight,
			`${product.product_group_id}/${variant.variant_id}: axis.value ${variant.axis.value} ≠ net_weight ${variant.net_weight}`,
		);
		assert.equal(variant.axis.unit, 'g');
		assert.equal(variant.axis.label, `${variant.net_weight} g`);
	}
});
