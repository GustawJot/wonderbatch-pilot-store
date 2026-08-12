import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wireVariantSchema, wireProductSchema, errorSchema } from '../src/schemas.ts';

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
