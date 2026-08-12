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
