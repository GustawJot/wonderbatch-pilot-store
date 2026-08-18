/**
 * POST /orders + GET /orders/:id conformance (3c-4a).
 *
 * ONE file for both endpoints, deliberately breaking the one-file-per-endpoint
 * habit: every placement here is a REAL pending order in the dev database and
 * a REAL stock decrement, shared with the dev marketplace, and this suite has
 * no DB access to clean either up (the one rule). So the whole file shares a
 * SINGLE placement — the happy path, the idempotent replay, and every
 * GET /orders/:id assertion all read the same order. Splitting the files
 * would force a second placement per run for nothing.
 *
 * WHAT ONE FULL RUN COSTS THE DEV DATABASE
 * ════════════════════════════════════════
 * Exactly 1 pending order and 2 units of stock on the first purchasable
 * variant, left behind as accepted dev litter. The INSUFFICIENT_STOCK path
 * reserves nothing (the refusal happens before any decrement sticks), and
 * every other refusal is read-only.
 *
 * WHY QUANTITY 2, NOT 1 — READ BEFORE "OPTIMIZING" IT DOWN
 * ════════════════════════════════════════════════════════
 * The stock-refusal test over-requests 99 of the SAME variant (99 is the
 * cart's per-line cap — the largest request this surface can express), and
 * reservation succeeds at equality (`stock >= requested`). Dev stock sits at
 * exactly 100 per variant (2026-08-18), so after a quantity-1 placement the
 * variant holds 99 and a 99-request would NOT refuse — it would place a real
 * 99-unit order and drain the shelf. Quantity 2 leaves 98 (< 99), making the
 * refusal deterministic on every run, including the first.
 *
 * The dev-data invariants this file leans on (see README "What the orders
 * tests cost"): every hayb-store variant's stock stays ≤ 100, and the first
 * purchasable variant keeps at least ~4 units (the suite drains 2 per run).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type PlaceOrderBody } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import {
	cartResponseSchema,
	errorSchema,
	insufficientStockErrorSchema,
	orderResponseSchema,
	productListSchema,
	shippingMethodsResponseSchema,
} from '../src/schemas.ts';

const api = createClient(loadConfig());

const catalog = productListSchema.parse((await api.listProducts({ limit: 50 })).body);
const variant = catalog.data.products.flatMap((p) => p.variants).find((v) => v.is_purchasable);
if (!variant) {
	throw new Error('No purchasable variant in the test catalog — orders.test.ts needs one.');
}

const methods = shippingMethodsResponseSchema.parse((await api.getShippingMethods()).body);
const lockerMethod = methods.data.methods.find((m) => m.requires_pickup_point);
if (!lockerMethod) {
	throw new Error(
		'No pickup-point method in the live shipping offer — orders.test.ts places a ' +
			'locker order and needs one to exist.',
	);
}

/**
 * A real InPost locker code. Placement stores it verbatim (no carrier lookup
 * happens server-side — dispatch-time booking resolves the point), so a
 * plausible code is all a placement needs.
 */
const COLLECTION_POINT_CODE = 'KRA01A';

/** See the header — 2 is load-bearing, not a taste choice. */
const PLACEMENT_QUANTITY = 2;

/**
 * The one placement body, rebuilt per call so no test can mutate another's.
 * No `delivery.address`: a locker order may omit it (the point's address is
 * resolved at dispatch), which also exercises the documented PL fallback for
 * the VAT country.
 */
function orderBody(): PlaceOrderBody {
	return {
		buyer: {
			first_name: 'Anna',
			last_name: 'Nowak',
			email: 'pilot-conformance@example.com',
			phone: '600123123',
			phone_prefix: '+48',
		},
		delivery: {
			method_id: lockerMethod.id,
			collection_point_code: COLLECTION_POINT_CODE,
		},
		discount_code: null,
		buyer_reference: null,
	};
}

const idempotencyKey = crypto.randomUUID();

/**
 * THE one placement — memoized like shipping-methods' fetchMethodsOnce, but
 * here the reason is stronger than request budget: each call would be a new
 * real order. Every test below shares this cart, this key, this order.
 */
let placementOnce:
	| Promise<{ cartId: string; first: Awaited<ReturnType<typeof api.placeOrder>> }>
	| undefined;
function placeTheOneOrder() {
	placementOnce ??= (async () => {
		const cart = cartResponseSchema.parse((await api.createCart()).body);
		const cartId = cart.data.cart.id;
		const added = await api.addCartItem(cartId, {
			variant_id: variant.variant_id,
			quantity: PLACEMENT_QUANTITY,
		});
		assert.equal(added.status, 200, 'fixture add-to-cart failed — nothing below can run');
		const first = await api.placeOrder(cartId, orderBody(), idempotencyKey);
		return { cartId, first };
	})();
	return placementOnce;
}

test('POST /orders answers 201 under the strict schema, with the channel-family order number', async () => {
	const { first } = await placeTheOneOrder();

	assert.equal(first.status, 201);
	const order = orderResponseSchema.parse(first.body).data.order;

	// The pilot channel's registry token is HAY-PL (spec §3 fork C) — the
	// suffix families are channel DATA, so the exact token lives here in the
	// test, not in the schema.
	assert.match(order.order_number, /^\d{6}\/\d{4}-HAY-PL$/);
	assert.equal(order.payment_status, 'pending');
	assert.equal(order.fulfilment_status, 'unfulfilled');
	assert.equal(order.delivery_status, 'not_dispatched');

	// A freshly placed order has reached no milestone and has no shipment.
	assert.equal(order.tracking, null);
	assert.equal(order.paid_at, null);
	assert.equal(order.dispatched_at, null);
	assert.equal(order.delivered_at, null);
	assert.equal(order.buyer_reference, null);

	// The delivery echo — the method we chose and the point code, verbatim.
	assert.equal(order.delivery.method_id, lockerMethod.id);
	assert.equal(order.delivery.collection_point_code, COLLECTION_POINT_CODE);

	// The single line survives placement with its catalog identity intact.
	assert.equal(order.items.length, 1);
	assert.equal(order.items[0].variant_id, variant.variant_id);
	assert.equal(order.items[0].quantity, PLACEMENT_QUANTITY);
	assert.equal(order.items[0].net_weight, variant.net_weight);
	assert.equal(order.items[0].unit_price.net, variant.net_price);
	assert.equal(order.items[0].unit_price.currency, variant.currency);
});

/**
 * MONEY MUST ACTUALLY RECONCILE, not just be well-formed. Integer cents
 * throughout so the test's own arithmetic can never manufacture a float red.
 * Two engine rules re-asserted from outside: `vat_amount` is the residual
 * `gross − net` (never an independently rounded `net × rate`), and one VAT
 * rate rules the whole order (items, totals and shipping alike).
 */
test('totals roll up and vat_amount is the residual gross − net', async () => {
	const { first } = await placeTheOneOrder();
	const order = orderResponseSchema.parse(first.body).data.order;
	const cents = (s: string) => Math.round(Number(s) * 100);

	assert.equal(order.totals.item_count, 1);
	assert.equal(order.totals.quantity, PLACEMENT_QUANTITY);
	assert.equal(
		order.totals.net_value,
		((cents(variant.net_price) * PLACEMENT_QUANTITY) / 100).toFixed(2),
	);
	assert.equal(
		cents(order.totals.vat_amount),
		cents(order.totals.gross_value) - cents(order.totals.net_value),
	);

	// Locker order without an address → the documented PL fallback.
	assert.equal(order.totals.vat_country, 'PL');
	assert.equal(order.totals.currency, catalog.data.currency);

	// The shipping fee is the OFFER's fee — the per-seller price from
	// GET /shipping/methods, not any flat marketplace default.
	assert.equal(order.shipping_fee.net, lockerMethod.shipping_fee.net);
	assert.equal(order.shipping_fee.currency, lockerMethod.shipping_fee.currency);

	// One destination VAT rate for the whole order.
	assert.equal(order.items[0].unit_price.vat_rate, order.totals.vat_rate);
	assert.equal(order.shipping_fee.vat_rate, order.totals.vat_rate);
});

test('a same-key replay returns the same 201 body and places nothing — the cart stays empty', async () => {
	const { cartId, first } = await placeTheOneOrder();

	const replay = await api.placeOrder(cartId, orderBody(), idempotencyKey);

	assert.equal(replay.status, 201);
	assert.deepEqual(replay.body, first.body);

	// The order was placed once: the first placement emptied the cart, and the
	// replay served the cached body without touching it again.
	const after = cartResponseSchema.parse((await api.getCart(cartId)).body);
	assert.deepEqual(after.data.cart.items, []);
});

test('a missing Idempotency-Key is refused with 400 naming the header', async () => {
	const { cartId } = await placeTheOneOrder();

	const res = await api.placeOrder(cartId, orderBody(), null);

	assert.equal(res.status, 400);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'validation');
	assert.equal(body.error.field, 'Idempotency-Key');
});

/**
 * `discount_code` is RESERVED in v1: the field is accepted and only null (or
 * omission) passes. The refusal happens at body validation — before the cart
 * is read and before the key is consumed — so a store that ships a discount
 * input finds out at the first submit, with its key still usable.
 */
test('a non-null discount_code is refused with 400', async () => {
	const { cartId } = await placeTheOneOrder();

	const res = await api.placeOrder(
		cartId,
		{ ...orderBody(), discount_code: 'WELCOME10' },
		crypto.randomUUID(),
	);

	assert.equal(res.status, 400);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'validation');
	assert.equal(body.error.field, 'discount_code');
});

/**
 * The machine-readable stock refusal. 99 (the cart's per-line cap) of the
 * SAME variant the shared placement already bought 2 of — see the header for
 * why that arithmetic is what keeps this test from ever placing a real
 * 99-unit order. Nothing is reserved on this path: the refused cart keeps
 * its line, and stock is untouched.
 */
test('a line above available stock is refused with 409 INSUFFICIENT_STOCK naming the variant', async () => {
	await placeTheOneOrder(); // this run has already drained 2 units of the variant

	const cart = cartResponseSchema.parse((await api.createCart()).body);
	const cartId = cart.data.cart.id;
	const added = await api.addCartItem(cartId, { variant_id: variant.variant_id, quantity: 99 });
	assert.equal(added.status, 200);

	const res = await api.placeOrder(cartId, orderBody(), crypto.randomUUID());

	if (res.status === 201) {
		assert.fail(
			`placeOrder(quantity 99) answered 201 — a REAL 99-unit order was just placed. ` +
				`Dev stock for ${variant.variant_id} has risen above 100, breaking the ` +
				`invariant this test leans on (README "What the orders tests cost"). ` +
				`Restock the variant to at most 100 before running the suite again.`,
		);
	}

	assert.equal(res.status, 409);
	const body = insufficientStockErrorSchema.parse(res.body);
	const line = body.error.details.lines[0];
	assert.equal(line.variant_id, variant.variant_id);
	assert.equal(line.requested_quantity, 99);
	assert.ok(
		line.available_stock < line.requested_quantity,
		`the refusal reports ${line.available_stock} available yet refused ${line.requested_quantity}`,
	);

	// Refused whole: the cart the attempt rode in on is untouched.
	const after = cartResponseSchema.parse((await api.getCart(cartId)).body);
	assert.equal(after.data.cart.items[0]?.quantity, 99);
});

/**
 * An unknown cart 404s with the anti-enumeration collapse. The OTHER half of
 * that promise — a real cart belonging to a DIFFERENT channel answering the
 * byte-identical 404 — is not testable over HTTP with this suite's single
 * channel token; it would need a second registered channel's credentials.
 */
test('an unknown cart_id answers 404 CART_NOT_FOUND', async () => {
	const res = await api.placeOrder(`crt_${'a'.repeat(43)}`, orderBody(), crypto.randomUUID());

	assert.equal(res.status, 404);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.category, 'not_found');
	assert.equal(body.error.code, 'CART_NOT_FOUND');
});

test('GET /orders/:id with the placement token returns the placement body verbatim', async () => {
	const { first } = await placeTheOneOrder();
	const placed = orderResponseSchema.parse(first.body).data.order;

	const read = await api.getOrder(placed.id, placed.order_token);

	assert.equal(read.status, 200);
	orderResponseSchema.parse(read.body);
	// One shared serializer on the engine side — the read IS the placement
	// body (plus post-payment fields, all still null on a pending order).
	assert.deepEqual(read.body, first.body);
});

/**
 * FOUR MISSES, ONE ANSWER. A wrong token, an unknown id and a malformed id
 * must be indistinguishable — an order's existence is never confirmable
 * without the right token. (The fourth miss, a real order probed through a
 * DIFFERENT channel's token, needs a second channel — same gap as the cart
 * 404 above.) A malformed id is deliberately a 404 and never a 400: the id
 * namespace stays opaque.
 */
test('a wrong token, an unknown id and a malformed id all answer the identical 404', async () => {
	const { first } = await placeTheOneOrder();
	const placed = orderResponseSchema.parse(first.body).data.order;

	const wrongToken = await api.getOrder(placed.id, '00000000-0000-4000-8000-000000000000');
	const unknownId = await api.getOrder('ffffffffffffffffffffffff', placed.order_token);
	const malformedId = await api.getOrder('not-an-object-id', placed.order_token);

	for (const res of [wrongToken, unknownId, malformedId]) {
		assert.equal(res.status, 404);
		assert.equal(errorSchema.parse(res.body).error.code, 'ORDER_NOT_FOUND');
	}
	assert.deepEqual(wrongToken.body, unknownId.body);
	assert.deepEqual(unknownId.body, malformedId.body);
});

/**
 * A missing X-Order-Token is a 400 naming the header — and the SAME 400
 * whether or not the order exists, so the refusal carries no existence
 * signal either.
 */
test('a missing X-Order-Token header is a 400 naming the header, existence-blind', async () => {
	const { first } = await placeTheOneOrder();
	const placed = orderResponseSchema.parse(first.body).data.order;

	const realOrder = await api.getOrder(placed.id, null);
	const noSuchOrder = await api.getOrder('ffffffffffffffffffffffff', null);

	assert.equal(realOrder.status, 400);
	const body = errorSchema.parse(realOrder.body);
	assert.equal(body.error.category, 'validation');
	assert.equal(body.error.field, 'X-Order-Token');

	assert.equal(noSuchOrder.status, 400);
	assert.deepEqual(noSuchOrder.body, realOrder.body);
});

// ONE auth-failure probe, deliberately — same reasoning as every other
// endpoint file: it charges the API's failure budget, and auth.test.ts owns
// the full guard matrix. This only proves the guard is wired up here.
test('no Authorization header is refused with 401, same as every other endpoint', async () => {
	const res = await api.placeOrder(
		`crt_${'a'.repeat(43)}`,
		orderBody(),
		crypto.randomUUID(),
		{ token: null },
	);

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
