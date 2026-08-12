import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('loadConfig returns all four values from the environment', () => {
	const config = loadConfig({
		WB_API_BASE_URL: 'http://localhost:3000',
		WB_PILOT_ORIGIN: 'http://localhost:5173',
		WB_STOREFRONT_TOKEN: 'wb_pk_test',
		WB_CHANNEL_KEY: 'hayb-store',
	});

	assert.equal(config.apiBaseUrl, 'http://localhost:3000');
	assert.equal(config.origin, 'http://localhost:5173');
	assert.equal(config.token, 'wb_pk_test');
	assert.equal(config.channelKey, 'hayb-store');
});

test('loadConfig names every missing variable at once', () => {
	assert.throws(
		() => loadConfig({ WB_API_BASE_URL: 'http://localhost:3000' }),
		(err: Error) => {
			assert.match(err.message, /WB_PILOT_ORIGIN/);
			assert.match(err.message, /WB_STOREFRONT_TOKEN/);
			assert.match(err.message, /WB_CHANNEL_KEY/);
			return true;
		},
	);
});

test('loadConfig strips a trailing slash from the base URL', () => {
	const config = loadConfig({
		WB_API_BASE_URL: 'http://localhost:3000/',
		WB_PILOT_ORIGIN: 'http://localhost:5173',
		WB_STOREFRONT_TOKEN: 'wb_pk_test',
		WB_CHANNEL_KEY: 'hayb-store',
	});

	assert.equal(config.apiBaseUrl, 'http://localhost:3000');
});

test('loadConfig rejects an origin with a trailing slash', () => {
	assert.throws(
		() =>
			loadConfig({
				WB_API_BASE_URL: 'http://localhost:3000',
				WB_PILOT_ORIGIN: 'http://localhost:5173/',
				WB_STOREFRONT_TOKEN: 'wb_pk_test',
				WB_CHANNEL_KEY: 'hayb-store',
			}),
		/trailing slash/,
	);
});
