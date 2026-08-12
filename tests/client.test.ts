import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.ts';
import { loadConfig } from '../src/config.ts';

const api = createClient(loadConfig());

test('listProducts returns status, headers and a parsed body', async () => {
	const res = await api.listProducts();

	assert.equal(res.status, 200);
	assert.equal(typeof res.headers.get('content-type'), 'string');
	assert.ok(res.body && typeof res.body === 'object');
});

test('a refusal is returned as data, not thrown', async () => {
	const res = await api.listProducts({ token: null });

	assert.equal(res.status, 401);
	assert.ok(res.body && typeof res.body === 'object');
});

test('query parameters reach the API', async () => {
	const res = await api.listProducts({ limit: 1 });
	const body = res.body as { data: { products: unknown[] } };

	assert.equal(res.status, 200);
	assert.equal(body.data.products.length, 1);
});
