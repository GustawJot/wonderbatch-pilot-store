import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	wireVariantSchema,
	wireProductSchema,
	errorSchema,
	cartItemSchema,
	cartSchema,
	cartResponseSchema,
	shippingMethodSchema,
	pickupPointSchema,
	orderSchema,
	insufficientStockErrorSchema,
} from '../src/schemas.ts';

const validVariant = {
	variant_id: '507f1f77bcf86cd799439011',
	net_weight: 250,
	net_price: '39.90',
	currency: 'PLN',
	sku: null,
	ean: null,
	availability: 'in_stock',
	is_purchasable: true,
};

test('a well-formed variant validates', () => {
	assert.doesNotThrow(() => wireVariantSchema.parse(validVariant));
});

test('an UNEXPECTED field fails validation', () => {
	assert.throws(() => wireVariantSchema.parse({ ...validVariant, surprise: 'hello' }));
});

test('a missing field fails validation', () => {
	const { currency, ...withoutCurrency } = validVariant;
	assert.throws(() => wireVariantSchema.parse(withoutCurrency));
});

test('net_price must be a fixed-2-decimal string, not a number', () => {
	assert.throws(() => wireVariantSchema.parse({ ...validVariant, net_price: 39.9 }));
	assert.throws(() => wireVariantSchema.parse({ ...validVariant, net_price: '39.9' }));
});

test('a product needs at least one variant', () => {
	assert.throws(() =>
		wireProductSchema.parse({
			product_group_id: 'hayb-brasil-espresso',
			name: 'Brasil Espresso',
			product_type: null,
			description: null,
			image_url: null,
			attributes: null,
			variants: [],
		}),
	);
});

test('the error envelope validates', () => {
	assert.doesNotThrow(() =>
		errorSchema.parse({
			success: false,
			error: { category: 'authentication', message: 'Invalid publishable token' },
		}),
	);
});

const validCartItem = {
	variant_id: '6a0cbfba64882223a54b4e02',
	product_group_id: 'hayb-espresso-blend-espresso',
	name: 'Espresso Blend',
	net_weight: 250,
	quantity: 2,
	unit_price: { net: '39.90', currency: 'PLN' },
	availability: 'available',
	is_purchasable: true,
	image_url: null,
	added_at: '2026-08-13T10:15:00.000Z',
};

const validCart = {
	id: 'crt_8x2K9f0000000000000000000000000000000000000',
	items: [validCartItem],
	totals: { item_count: 1, quantity: 2, net_value: '79.80', currency: 'PLN' },
	created_at: '2026-08-13T10:14:00.000Z',
};

test('a well-formed cart item validates', () => {
	assert.doesNotThrow(() => cartItemSchema.parse(validCartItem));
});

test('a cart item with an UNEXPECTED field fails validation — a leaked buyer_reference would be caught here', () => {
	assert.throws(() => cartItemSchema.parse({ ...validCartItem, buyer_reference: 'order #4' }));
});

test('a cart item quantity outside 1-99 fails validation', () => {
	assert.throws(() => cartItemSchema.parse({ ...validCartItem, quantity: 0 }));
	assert.throws(() => cartItemSchema.parse({ ...validCartItem, quantity: 100 }));
});

/**
 * A REGRESSION GUARD, NOT A HYPOTHETICAL. API.md is emphatic that `hidden`
 * must never reach the cart wire — a line whose variant the seller has since
 * unlisted reports `out_of_stock` instead, for the same anti-enumeration
 * reason the catalog drops `hidden` variants outright. If this ever starts
 * failing against a real response, that is the API leaking a seller's
 * unlisted-weight decision to a buyer's browser, not a test to loosen.
 */
test('availability "hidden" on a cart item fails validation', () => {
	assert.throws(() => cartItemSchema.parse({ ...validCartItem, availability: 'hidden' }));
});

test('unit_price must be net-only — a gross field would fail as unexpected', () => {
	assert.throws(() =>
		cartItemSchema.parse({
			...validCartItem,
			unit_price: { net: '39.90', gross: '49.09', currency: 'PLN' },
		}),
	);
});

test('a well-formed cart validates, empty items included', () => {
	assert.doesNotThrow(() => cartSchema.parse(validCart));
	assert.doesNotThrow(() =>
		cartSchema.parse({
			...validCart,
			items: [],
			totals: { item_count: 0, quantity: 0, net_value: '0.00', currency: 'PLN' },
		}),
	);
});

test('a cart id not shaped like crt_… fails validation', () => {
	assert.throws(() => cartSchema.parse({ ...validCart, id: 'the-mongo-_id-should-never-be-this' }));
});

test('the cart response envelope wraps a single cart', () => {
	assert.doesNotThrow(() =>
		cartResponseSchema.parse({ success: true, data: { cart: validCart } }),
	);
});

const validShippingMethod = {
	id: 'inpost_locker_pl',
	type: 'locker',
	carrier: 'inpost',
	requires_pickup_point: true,
	shipping_fee: { net: '11.99', currency: 'PLN' },
};

test('a well-formed shipping method validates, a "0.00" free-delivery fee included', () => {
	assert.doesNotThrow(() => shippingMethodSchema.parse(validShippingMethod));
	assert.doesNotThrow(() =>
		shippingMethodSchema.parse({
			...validShippingMethod,
			shipping_fee: { net: '0.00', currency: 'PLN' },
		}),
	);
});

/**
 * A REGRESSION GUARD, NOT A HYPOTHETICAL. The offer resolver carries a
 * `source` diagnostic ("configured" vs "default") that the route
 * deliberately keeps OFF the wire — publishing it would let a competitor
 * tell a hand-configured store from an untouched one for free. If this test
 * ever fails against a real response, that is the diagnostic leaking, not a
 * schema to loosen.
 */
test('the resolver-internal `source` field on a shipping method fails validation', () => {
	assert.throws(() => shippingMethodSchema.parse({ ...validShippingMethod, source: 'configured' }));
});

test('the sketch-era `price` name fails validation — the wire field is `shipping_fee`', () => {
	const { shipping_fee, ...renamed } = validShippingMethod;
	assert.throws(() => shippingMethodSchema.parse({ ...renamed, price: shipping_fee }));
	// Even alongside a correct shipping_fee, a stray `price` is still drift.
	assert.throws(() => shippingMethodSchema.parse({ ...validShippingMethod, price: shipping_fee }));
});

test('a shipping fee outside the PLN/EUR picklist fails validation', () => {
	assert.throws(() =>
		shippingMethodSchema.parse({
			...validShippingMethod,
			shipping_fee: { net: '11.99', currency: 'USD' },
		}),
	);
});

const validPickupPoint = {
	code: 'WAW123A',
	name: 'Paczkomat WAW123A',
	address: 'Prosta 1',
	city: 'Warszawa',
	postal_code: '00-001',
	location: { latitude: 52.2297, longitude: 21.0122 },
	distance_meters: 240,
	opening_hours: '24/7',
	location_description: 'Przy wejściu do sklepu',
	is_available_247: true,
	carrier_id: 'inpost',
};

test('a well-formed pickup point validates, nulled nullables included', () => {
	assert.doesNotThrow(() => pickupPointSchema.parse(validPickupPoint));
	assert.doesNotThrow(() =>
		pickupPointSchema.parse({
			...validPickupPoint,
			distance_meters: null,
			location_description: null,
		}),
	);
});

test('an omitted location_description fails validation — nullable means explicit null, never absent', () => {
	const { location_description, ...omitted } = validPickupPoint;
	assert.throws(() => pickupPointSchema.parse(omitted));
});

const validOrder = {
	id: '665f1b2c3d4e5f6071828394',
	order_number: '260818/1001-HAY-PL',
	order_token: '8c1e2f4a-1234-4abc-9def-567890abcdef',
	payment_status: 'pending',
	fulfilment_status: 'unfulfilled',
	delivery_status: 'not_dispatched',
	items: [
		{
			variant_id: '665f1a2b3c4d5e6f70818283',
			name: 'Espresso Blend',
			net_weight: 250,
			quantity: 2,
			unit_price: { net: '39.90', gross: '49.08', vat_rate: '0.23', currency: 'PLN' },
		},
	],
	totals: {
		item_count: 1,
		quantity: 2,
		net_value: '79.80',
		gross_value: '98.15',
		vat_amount: '18.35',
		vat_rate: '0.23',
		vat_country: 'PL',
		currency: 'PLN',
	},
	shipping_fee: { net: '11.99', gross: '14.75', vat_rate: '0.23', currency: 'PLN' },
	delivery: { method_id: 'inpost_locker_pl', collection_point_code: 'KRA01A' },
	tracking: null,
	buyer_reference: null,
	created_at: '2026-08-18T10:15:00.000Z',
	paid_at: null,
	dispatched_at: null,
	delivered_at: null,
};

test('a well-formed order validates, tracking block included', () => {
	assert.doesNotThrow(() => orderSchema.parse(validOrder));
	assert.doesNotThrow(() =>
		orderSchema.parse({
			...validOrder,
			paid_at: '2026-08-18T10:20:00.000Z',
			tracking: { carrier: 'inpost', tracking_number: '520000123', tracking_url: null },
		}),
	);
});

test('an order with an UNEXPECTED field fails validation — a leaked buyer block would be caught here', () => {
	assert.throws(() => orderSchema.parse({ ...validOrder, buyer: { email: 'a@b.co' } }));
});

test('the marketplace order-number family fails validation — only the channel family belongs on this wire', () => {
	assert.throws(() =>
		orderSchema.parse({ ...validOrder, order_number: 'WONDER-260818/1001-BATCH' }),
	);
});

test('an order money block must carry all four fields — a net-only unit_price fails', () => {
	const netOnly = { ...validOrder.items[0], unit_price: { net: '39.90', currency: 'PLN' } };
	assert.throws(() => orderSchema.parse({ ...validOrder, items: [netOnly] }));
});

test('an omitted paid_at fails validation — milestones are explicit null, never absent', () => {
	const { paid_at, ...omitted } = validOrder;
	assert.throws(() => orderSchema.parse(omitted));
});

test('the INSUFFICIENT_STOCK envelope validates, and a lineless details fails', () => {
	const line = {
		variant_id: '665f1a2b3c4d5e6f70818283',
		name: 'Espresso Blend',
		requested_quantity: 99,
		available_stock: 3,
	};
	assert.doesNotThrow(() =>
		insufficientStockErrorSchema.parse({
			success: false,
			error: {
				category: 'conflict',
				message: 'Not enough stock for "Espresso Blend". Available: 3, requested: 99.',
				code: 'INSUFFICIENT_STOCK',
				details: { lines: [line] },
			},
		}),
	);
	assert.throws(() =>
		insufficientStockErrorSchema.parse({
			success: false,
			error: {
				category: 'conflict',
				message: 'Not enough stock.',
				code: 'INSUFFICIENT_STOCK',
				details: { lines: [] },
			},
		}),
	);
});
