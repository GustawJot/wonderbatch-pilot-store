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
