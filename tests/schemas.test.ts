import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
	wireVariantSchema,
	wireProductSchema,
	errorSchema,
	cartItemSchema,
	cartSchema,
	cartResponseSchema,
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
