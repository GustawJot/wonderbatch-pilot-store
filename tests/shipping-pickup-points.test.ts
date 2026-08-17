/**
 * GET /shipping/pickup-points conformance.
 *
 * These searches reach the REAL dev carrier integration, so two budgets
 * shape this file:
 *  - the endpoint's dedicated 30/min per-IP budget (it proxies a third-party
 *    carrier API) — every test here, validation failures included, charges
 *    it, so the file stays at four requests per run;
 *  - the carrier itself — an honest "found nothing" is a valid live answer,
 *    so every search tolerates `points: []` and asserts only the shape.
 *
 * The `method_id` under test comes from the LIVE offer, not a hardcoded id:
 * the seller's configuration is theirs to change, and a pinned id would turn
 * their edit into our false alarm. If the seller currently offers no
 * pickup-point method, the search tests skip rather than fail.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import {
	shippingMethodsResponseSchema,
	pickupPointsResponseSchema,
	errorSchema,
} from '../src/schemas.ts';

const api = createClient(loadConfig());

/** Warsaw centre — a postcode any Polish carrier has points near. */
const WARSAW_POSTAL_CODE = '00-001';

/**
 * One methods fetch for the whole file (the suite is serialized, so the
 * cached promise is race-free). Returns the first offered method that
 * requires a pickup point, or null when the seller offers none.
 */
let offeredPickupMethodId: Promise<string | null> | undefined;
function findPickupMethodId(): Promise<string | null> {
	offeredPickupMethodId ??= (async () => {
		const body = shippingMethodsResponseSchema.parse((await api.getShippingMethods()).body);
		return body.data.methods.find((method) => method.requires_pickup_point)?.id ?? null;
	})();
	return offeredPickupMethodId;
}

test('a Warsaw search on a live offered method answers 200 under the strict schema', async (t) => {
	const methodId = await findPickupMethodId();
	if (methodId === null) {
		t.skip('the live seller currently offers no pickup-point method');
		return;
	}

	const res = await api.searchPickupPoints({
		method_id: methodId,
		postal_code: WARSAW_POSTAL_CODE,
	});

	// "Found nothing" is ruled a 200 with points: [] — on this surface 404
	// keeps its anti-enumeration meaning (deliberately diverging from the
	// internal route). A 404 here is a contract break even when the carrier
	// genuinely has nothing.
	assert.notEqual(res.status, 404, 'an empty search result must be 200 + points: [], never 404');
	assert.equal(res.status, 200);
	pickupPointsResponseSchema.parse(res.body);
	// Empty is tolerated on purpose: the carrier's answer is not ours to pin.
});

test('a missing method_id is refused with a 400 validation envelope', async () => {
	const res = await api.searchPickupPoints({ postal_code: WARSAW_POSTAL_CODE });

	assert.equal(res.status, 400);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'validation');
	assert.equal(body.error.field, 'method_id');
});

/**
 * Unknown, seller-disabled and non-pickup method ids are all documented as
 * the SAME single 400 — the endpoint must not be an oracle for what the
 * engine knows but the seller hides. No second probe for the disabled case:
 * this suite cannot disable a method over HTTP, and the one branch is the
 * one behaviour.
 */
test('an unknown method_id is refused with the same 400 validation envelope', async () => {
	const res = await api.searchPickupPoints({
		method_id: 'never_a_real_method_id',
		postal_code: WARSAW_POSTAL_CODE,
	});

	assert.equal(res.status, 400);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'validation');
	assert.equal(body.error.field, 'method_id');
});

test('limit=50 is clamped — never more than 20 points come back', async (t) => {
	const methodId = await findPickupMethodId();
	if (methodId === null) {
		t.skip('the live seller currently offers no pickup-point method');
		return;
	}

	const res = await api.searchPickupPoints({
		method_id: methodId,
		postal_code: WARSAW_POSTAL_CODE,
		limit: 50,
	});

	assert.equal(res.status, 200);
	const body = pickupPointsResponseSchema.parse(res.body);
	assert.ok(
		body.data.points.length <= 20,
		`limit=50 returned ${body.data.points.length} points — the documented max is 20`,
	);
});
