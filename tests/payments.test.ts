/**
 * POST /orders/:id/payment-session + POST /orders/:id/verify-payment
 * conformance (3c-4b).
 *
 * ONE file for both endpoints, same reasoning as orders.test.ts: the
 * fixtures here are REAL — a pending order in the dev database, a stock
 * decrement, and a REAL processor order on the payment sandbox — and this
 * suite has no DB access to clean any of it up (the one rule). So the whole
 * file shares a SINGLE placement and a SINGLE payment session; the replay
 * semantics the contract promises ("calling again returns the stored
 * session") are what make that sharing free: every call after the first
 * costs the processor nothing.
 *
 * WHAT ONE FULL RUN COSTS
 * ═══════════════════════
 * 1 pending order + 1 unit of stock on the first purchasable variant (dev
 * litter, same as orders.test.ts), plus 1 card order on the payment
 * processor's SANDBOX (never paid — it expires on the processor's side) and
 * the engine's own payment-intent row for it. Every replay, every refusal
 * and the verify call reuse that single session. No emails fire: a pending
 * placement sends nothing, and a happy-path session/verify alerts nobody.
 *
 * FILE ORDER IS LOAD-BEARING: `payments` sorts after `orders`, so
 * orders.test.ts runs first and its stock-refusal arithmetic (README "What
 * the orders tests cost") sees the shelf before this file's 1-unit drain.
 * The suite now drains 3 units per full run (2 there + 1 here) — restock
 * the first variant to at most 100 when it runs low.
 *
 * WHAT THIS FILE CANNOT PROVE, deliberately documented rather than faked:
 *
 *   - The fourth anti-enumeration miss (a real order probed through a
 *     DIFFERENT channel's token) needs a second registered channel's
 *     credentials — the same gap orders.test.ts records.
 *   - `already_paid` — for card and blik it is UNREACHABLE outright: the
 *     engine's replay fast-path is unconditional for those methods, so only
 *     a digital_wallet session (whose stored processor order gets a live
 *     status check) can ever answer it. This suite pays with card and never
 *     moves money, so the state is pinned as schema only (schemas.test.ts),
 *     null-client_token rule included.
 *   - `{status:"paid"}` from verify-payment — needs money to actually move;
 *     schema-pinned only, same as above.
 *   - The remaining session refusals: `ZERO_TOTAL` (needs a fully
 *     discounted order, which this surface cannot place),
 *     `PAYMENT_IN_PROGRESS` (needs the losing side of a concurrent create
 *     race), and the blik-code input refusals (e.g. `INVALID_BLIK_CODE` —
 *     refusing a sandbox BLIK attempt is processor behaviour, not
 *     deterministic contract). All are error-envelope-shaped by the
 *     engine's own door tests; none is exercised over this wire.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, type PaymentSessionBody, type PlaceOrderBody } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';
import {
	cartResponseSchema,
	errorSchema,
	orderResponseSchema,
	paymentSessionResponseSchema,
	productListSchema,
	shippingMethodsResponseSchema,
	verifyPaymentResponseSchema,
} from '../src/schemas.ts';

const config = loadConfig();
const api = createClient(config);

const catalog = productListSchema.parse((await api.listProducts({ limit: 50 })).body);
const variant = catalog.data.products.flatMap((p) => p.variants).find((v) => v.is_purchasable);
if (!variant) {
	throw new Error('No purchasable variant in the test catalog — payments.test.ts needs one.');
}

const methods = shippingMethodsResponseSchema.parse((await api.getShippingMethods()).body);
const lockerMethod = methods.data.methods.find((m) => m.requires_pickup_point);
if (!lockerMethod) {
	throw new Error(
		'No pickup-point method in the live shipping offer — payments.test.ts places a ' +
			'locker order and needs one to exist.',
	);
}

/** Same verbatim-stored locker code as orders.test.ts. */
const COLLECTION_POINT_CODE = 'KRA01A';

/**
 * The redirect the store would send: OUR registered origin, path and query
 * free by contract. The engine may drop a localhost redirect before the
 * processor sees it (processors reject localhost hosts) — that is the
 * engine's business; the DOOR's allowlist answer is what's under test.
 */
const REDIRECT_URL = `${config.origin}/checkout/return?paid=1`;

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

function sessionBody(overrides: Partial<PaymentSessionBody> = {}): PaymentSessionBody {
	return { payment_method: 'card', redirect_url: REDIRECT_URL, ...overrides };
}

/** THE one placement — every test below reads this order. */
let placementOnce: Promise<{ orderId: string; orderToken: string }> | undefined;
function placeTheOneOrder() {
	placementOnce ??= (async () => {
		const cart = cartResponseSchema.parse((await api.createCart()).body);
		const added = await api.addCartItem(cart.data.cart.id, {
			variant_id: variant.variant_id,
			quantity: 1,
		});
		assert.equal(added.status, 200, 'fixture add-to-cart failed — nothing below can run');
		const placed = await api.placeOrder(cart.data.cart.id, orderBody(), crypto.randomUUID());
		assert.equal(placed.status, 201, 'fixture placement failed — nothing below can run');
		const order = orderResponseSchema.parse(placed.body).data.order;
		return { orderId: order.id, orderToken: order.order_token };
	})();
	return placementOnce;
}

/**
 * THE one processor session — the only call in this suite that costs the
 * sandbox anything. Everything else replays it or is refused before it.
 */
let sessionOnce: Promise<Awaited<ReturnType<typeof api.createPaymentSession>>> | undefined;
function createTheOneSession() {
	sessionOnce ??= (async () => {
		const { orderId, orderToken } = await placeTheOneOrder();
		return api.createPaymentSession(orderId, orderToken, sessionBody());
	})();
	return sessionOnce;
}

// ─────────────────────────────────────────────────────────────────────
// POST /orders/:id/payment-session
// ─────────────────────────────────────────────────────────────────────

test('a first session answers 200 created, with a processor order and a client token', async () => {
	const first = await createTheOneSession();

	assert.equal(first.status, 200);
	const session = paymentSessionResponseSchema.parse(first.body).data.payment_session;
	assert.equal(session.state, 'created');
	// The schema already guarantees non-empty processor_order_id/client_token
	// and a known processor on a created session; WHICH processor serves card
	// is engine routing config, not wire contract, so it is not pinned here.
});

test('a second identical call replays the stored session verbatim — nothing new is minted', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();
	const first = paymentSessionResponseSchema.parse((await createTheOneSession()).body).data
		.payment_session;

	const replay = await api.createPaymentSession(orderId, orderToken, sessionBody());

	assert.equal(replay.status, 200);
	const replayed = paymentSessionResponseSchema.parse(replay.body).data.payment_session;
	assert.equal(replayed.state, 'replayed');
	assert.equal(replayed.processor_order_id, first.processor_order_id);
	assert.equal(replayed.client_token, first.client_token);
	assert.equal(replayed.processor, first.processor);
});

/**
 * The recorded ruling, observed from outside: the marketplace's internal
 * endpoint lets a client pick `metadata.captureMode`; this surface does NOT.
 * Over HTTP the observable half is that unrecognized fields are ignored, not
 * refused, and change nothing — the same stored session comes back, so the
 * junk demonstrably never minted a sibling processor order.
 */
test('client metadata and unknown body fields are ignored — same session, no refusal', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();
	const first = paymentSessionResponseSchema.parse((await createTheOneSession()).body).data
		.payment_session;

	const res = await api.createPaymentSession(
		orderId,
		orderToken,
		sessionBody({ metadata: { captureMode: 'manual', anything: 'else' }, surprise: 'hello' } as
			PaymentSessionBody),
	);

	assert.equal(res.status, 200);
	const session = paymentSessionResponseSchema.parse(res.body).data.payment_session;
	assert.equal(session.state, 'replayed');
	assert.equal(session.processor_order_id, first.processor_order_id);
});

test('any path and query on an allowed origin passes — only the ORIGIN is policed', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();
	const first = paymentSessionResponseSchema.parse((await createTheOneSession()).body).data
		.payment_session;

	const res = await api.createPaymentSession(
		orderId,
		orderToken,
		sessionBody({ redirect_url: `${config.origin}/deep/path?q=1#frag` }),
	);

	assert.equal(res.status, 200);
	const session = paymentSessionResponseSchema.parse(res.body).data.payment_session;
	// Replay of THE session, not a sibling: this is the assertion that keeps
	// the file's own footprint claim honest — if replay ever started keying on
	// redirect_url, this call would mint a second sandbox order per run, and
	// only this equality would notice.
	assert.equal(session.state, 'replayed');
	assert.equal(session.processor_order_id, first.processor_order_id);
});

/**
 * The allowlist: every way to miss it — an unlisted origin, the userinfo
 * trick (the URL LOOKS like ours but its real origin is evil.example), the
 * right host on another port or scheme, an unparseable value, a relative
 * path, a protocol-relative value — answers ONE byte-identical 400, so the
 * refusal is no oracle for WHICH check failed. And the same refusal comes
 * back for an order that doesn't exist: the check runs before the lookup,
 * so it leaks no existence signal either.
 */
test('every redirect_url miss answers the byte-identical REDIRECT_URL_NOT_ALLOWED 400', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();

	const swappedScheme = config.origin.startsWith('https://')
		? config.origin.replace(/^https:\/\//, 'http://')
		: config.origin.replace(/^http:\/\//, 'https://');

	const cases: unknown[] = [
		'https://evil.example/checkout/return', // unlisted origin
		`${config.origin.replace(/^https?:\/\//, 'http://')}@evil.example/return`, // userinfo trick
		`${config.origin}1/return`, // same-looking host, one character on — a different origin
		`${swappedScheme}/return`, // right host, wrong scheme — a different origin
		'not a url at all', // unparseable
		'/checkout/return', // path-only (relative)
		'//evil.example/return', // protocol-relative — unparseable without a base
	];

	const refusals = [];
	for (const redirect_url of cases) {
		refusals.push(await api.createPaymentSession(orderId, orderToken, sessionBody({ redirect_url })));
	}
	// Existence-blind: an unknown order id gets the same refusal, byte for byte.
	refusals.push(
		await api.createPaymentSession(
			'ffffffffffffffffffffffff',
			orderToken,
			sessionBody({ redirect_url: 'https://evil.example/checkout/return' }),
		),
	);

	for (const refusal of refusals) {
		assert.equal(refusal.status, 400);
		assert.deepEqual(refusal.body, refusals[0].body);
		// Refusals carry CORS too (API.md: every failure on this surface goes
		// through the with-CORS response path). Without the header a browser
		// store sees an opaque CORS error instead of the refusal — and no
		// in-process engine test can catch that regression.
		assert.equal(refusal.headers.get('access-control-allow-origin'), config.origin);
	}
	const body = errorSchema.parse(refusals[0].body);
	assert.equal(body.error.code, 'REDIRECT_URL_NOT_ALLOWED');
	assert.equal(body.error.field, 'redirect_url');
});

test('an unknown payment_method is refused with 400 naming the allowed values', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();

	const res = await api.createPaymentSession(
		orderId,
		orderToken,
		sessionBody({ payment_method: 'cash' }),
	);

	assert.equal(res.status, 400);
	const body = errorSchema.parse(res.body);
	assert.equal(body.error.field, 'payment_method');
	assert.match(body.error.message, /card, digital_wallet, blik/);
});

test('a missing redirect_url is refused with 400 naming the field', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();

	const res = await api.createPaymentSession(
		orderId,
		orderToken,
		sessionBody({ redirect_url: undefined }),
	);

	assert.equal(res.status, 400);
	assert.equal(errorSchema.parse(res.body).error.field, 'redirect_url');
});

test('a missing X-Order-Token is a 400 naming the header, existence-blind', async () => {
	const { orderId } = await placeTheOneOrder();

	const realOrder = await api.createPaymentSession(orderId, null, sessionBody());
	const noSuchOrder = await api.createPaymentSession(
		'ffffffffffffffffffffffff',
		null,
		sessionBody(),
	);

	assert.equal(realOrder.status, 400);
	const body = errorSchema.parse(realOrder.body);
	assert.equal(body.error.category, 'validation');
	assert.equal(body.error.field, 'X-Order-Token');

	assert.equal(noSuchOrder.status, 400);
	assert.deepEqual(noSuchOrder.body, realOrder.body);
});

/**
 * The order-read anti-enumeration promise, NOT relaxed for payment calls: a
 * wrong token, an unknown id and a malformed id are indistinguishable. (The
 * fourth miss — another channel's order — needs a second channel's
 * credentials; see the header.)
 */
test('a wrong token, an unknown id and a malformed id all answer the identical 404', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();

	const wrongToken = await api.createPaymentSession(
		orderId,
		'00000000-0000-4000-8000-000000000000',
		sessionBody(),
	);
	const unknownId = await api.createPaymentSession(
		'ffffffffffffffffffffffff',
		orderToken,
		sessionBody(),
	);
	const malformedId = await api.createPaymentSession('not-an-object-id', orderToken, sessionBody());

	for (const res of [wrongToken, unknownId, malformedId]) {
		assert.equal(res.status, 404);
		assert.equal(errorSchema.parse(res.body).error.code, 'ORDER_NOT_FOUND');
		// The 404 must reach a browser store AS a 404 — CORS on refusals.
		assert.equal(res.headers.get('access-control-allow-origin'), config.origin);
	}
	assert.deepEqual(wrongToken.body, unknownId.body);
	assert.deepEqual(unknownId.body, malformedId.body);
});

// ─────────────────────────────────────────────────────────────────────
// POST /orders/:id/verify-payment
// ─────────────────────────────────────────────────────────────────────

/**
 * The one verify answer money-less conformance CAN reach: the shared order
 * has a live session nobody ever pays, so the engine asks the processor and
 * finds it still unsettled. `reconciled: false` — this call flipped nothing.
 */
test('verify-payment on the unpaid order answers {status: pending, reconciled: false}', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();
	await createTheOneSession(); // the live-session round-trip, not the no-session early return

	const res = await api.verifyPayment(orderId, orderToken);

	assert.equal(res.status, 200);
	const body = verifyPaymentResponseSchema.parse(res.body);
	assert.equal(body.data.status, 'pending');
	assert.equal(body.data.reconciled, false);
});

test('verify-payment: a missing X-Order-Token is the same existence-blind 400', async () => {
	const { orderId } = await placeTheOneOrder();

	const realOrder = await api.verifyPayment(orderId, null);
	const noSuchOrder = await api.verifyPayment('ffffffffffffffffffffffff', null);

	assert.equal(realOrder.status, 400);
	assert.equal(errorSchema.parse(realOrder.body).error.field, 'X-Order-Token');
	assert.equal(noSuchOrder.status, 400);
	assert.deepEqual(noSuchOrder.body, realOrder.body);
});

test('verify-payment: wrong token, unknown id and malformed id answer the identical 404', async () => {
	const { orderId, orderToken } = await placeTheOneOrder();

	const wrongToken = await api.verifyPayment(orderId, '00000000-0000-4000-8000-000000000000');
	const unknownId = await api.verifyPayment('ffffffffffffffffffffffff', orderToken);
	const malformedId = await api.verifyPayment('not-an-object-id', orderToken);

	for (const res of [wrongToken, unknownId, malformedId]) {
		assert.equal(res.status, 404);
		assert.equal(errorSchema.parse(res.body).error.code, 'ORDER_NOT_FOUND');
		// The 404 must reach a browser store AS a 404 — CORS on refusals.
		assert.equal(res.headers.get('access-control-allow-origin'), config.origin);
	}
	assert.deepEqual(wrongToken.body, unknownId.body);
	assert.deepEqual(unknownId.body, malformedId.body);
});

// ONE auth-failure probe, deliberately — same reasoning as every other
// endpoint file: it charges the API's failure budget, and auth.test.ts owns
// the full guard matrix. This only proves the guard is wired up here.
test('no Authorization header is refused with 401, same as every other endpoint', async () => {
	const res = await api.createPaymentSession(
		'ffffffffffffffffffffffff',
		'00000000-0000-4000-8000-000000000000',
		sessionBody(),
		{ token: null },
	);

	assert.equal(res.status, 401);
	assert.equal(errorSchema.parse(res.body).error.category, 'authentication');
});
