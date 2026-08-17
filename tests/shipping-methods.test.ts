/**
 * GET /shipping/methods conformance.
 *
 * VALUES TOLERANT, SCHEMA STRICT. The live seller's offer is theirs to
 * change — which methods, what fees, even an empty offer are all valid
 * answers — so no test pins a particular method or fee. What must never
 * drift is the shape: field names, the closed `type` vocabulary, the
 * fixed-2-decimal net string, the PLN/EUR currency picklist, and the
 * ABSENCE of anything extra (the resolver's `source` diagnostic above all).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import { shippingMethodsResponseSchema, productListSchema, errorSchema } from '../src/schemas.ts';

const api = createClient(loadConfig());

/**
 * ONE fetch for the whole file, shared by every value assertion below — the
 * offer is config-backed and read-only, and the suite's request volume is
 * budgeted (the API allows 120/min, see pacing.ts), so re-fetching the same
 * document per test would spend budget to prove nothing.
 */
let methodsOnce: ReturnType<typeof api.getShippingMethods> | undefined;
function fetchMethodsOnce() {
	methodsOnce ??= api.getShippingMethods();
	return methodsOnce;
}

test('GET /shipping/methods answers 200 under the strict schema', async () => {
	const res = await fetchMethodsOnce();

	assert.equal(res.status, 200);
	// The parse IS the assertion: unknown fields (a leaked `source`, a
	// sketch-era `price`), a float fee, or an off-picklist currency all throw.
	shippingMethodsResponseSchema.parse(res.body);
});

/**
 * Every fee must be priced in the channel's own catalog currency — a EUR fee
 * on a PLN storefront would price shipping in money the checkout cannot
 * settle, and the route promises a 500 rather than serving such an offer.
 * The channel's currency isn't in this suite's config; the catalog response
 * carries it, so the catalog is the reference.
 */
test('every shipping fee is a fixed-2-decimal net in the channel currency', async () => {
	const catalog = productListSchema.parse((await api.listProducts({ limit: 1 })).body);
	const body = shippingMethodsResponseSchema.parse((await fetchMethodsOnce()).body);

	for (const method of body.data.methods) {
		assert.match(
			method.shipping_fee.net,
			/^\d+\.\d{2}$/,
			`method ${method.id} fee "${method.shipping_fee.net}" is not a fixed-2-decimal string`,
		);
		assert.equal(
			method.shipping_fee.currency,
			catalog.data.currency,
			`method ${method.id} is priced in ${method.shipping_fee.currency} but the channel sells in ${catalog.data.currency}`,
		);
	}
});

/**
 * `requires_pickup_point` comes from the method's own engine definition, and
 * a courier delivers to an address — a courier method demanding a pickup
 * point would send 3c-4's order placement chasing a point that cannot exist.
 */
test('no courier method requires a pickup point', async () => {
	const body = shippingMethodsResponseSchema.parse((await fetchMethodsOnce()).body);

	for (const method of body.data.methods) {
		if (method.requires_pickup_point) {
			assert.notEqual(
				method.type,
				'courier',
				`method ${method.id} is a courier yet requires a pickup point`,
			);
		}
	}
});

// ONE auth-failure probe, deliberately — each of these charges the API's
// failure-rate budget, and the guard is byte-for-byte the one auth.test.ts
// already exercises across statuses. This only proves it is wired up here.
test('no Authorization header is refused with 401, same as every other endpoint', async () => {
	const res = await api.getShippingMethods({ token: null });

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
