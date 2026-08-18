/**
 * The request layer — the only file here that knows about HTTP.
 *
 * It NEVER throws on a non-2xx response. On this surface a 401 or a 403 is the
 * behaviour under test, not a failure, so refusals come back as data like any
 * other response.
 */

import type { PilotConfig } from './config.ts';
import { paceForSharedBudget } from './pacing.ts';

const BASE_PATH = '/api/external/storefront/v1';

export interface ApiResult {
	status: number;
	headers: Headers;
	/** Parsed JSON, or the raw text when the body is not JSON (204s included). */
	body: unknown;
}

export interface RequestOverrides {
	/** `null` omits the Authorization header. `undefined` uses the configured token. */
	token?: string | null;
	/** `null` omits the Origin header — which skips the allowlist entirely. */
	origin?: string | null;
}

export interface ListOptions extends RequestOverrides {
	limit?: number | string;
	offset?: number | string;
}

/**
 * Body of `POST /carts`. Both fields are optional — an empty or absent body
 * is fine, per the API contract.
 */
export interface CreateCartOptions extends RequestOverrides {
	buyer_reference?: string;
}

/**
 * Body of `POST /carts/:cart_id/items`. Field names match the wire exactly —
 * this client does no camelCase translation, so the body it sends is the
 * body a reader sees in the assertion.
 */
export interface AddCartItemInput {
	variant_id: string;
	quantity: number | string;
	buyer_reference?: string;
}

/**
 * Body of `PATCH /carts/:cart_id/items/:variant_id`. `DELETE` has no
 * equivalent input type — it takes no body, by design (see API.md).
 */
export interface UpdateCartItemInput {
	quantity: number | string;
	buyer_reference?: string;
}

/**
 * Body of `POST /orders`, minus `cart_id` — the client threads that in from
 * its own first argument so a test can never place from one cart while
 * naming another. Field names match the wire exactly, as everywhere.
 *
 * `discount_code` is typed `unknown` on purpose: the field is RESERVED in
 * v1 (only `null` or omission passes), and sending a non-null value is
 * exactly how the reserved-field 400 is exercised.
 */
export interface PlaceOrderBody {
	buyer: {
		first_name: string;
		last_name: string;
		email: string;
		phone: string;
		phone_prefix: string;
		invoice?: { company_name?: string; tax_id?: string };
	};
	delivery: {
		method_id: string;
		collection_point_code?: string;
		address?: {
			street: string;
			building: string;
			apartment?: string;
			city: string;
			postal_code: string;
			country: string;
		};
	};
	discount_code?: unknown;
	buyer_reference?: string | null;
}

/**
 * Query of `GET /shipping/pickup-points`. Every field is optional HERE even
 * though `method_id` and `postal_code` are required on the wire — omitting
 * one is exactly how the validation tests exercise the 400s.
 */
export interface PickupPointSearchParams {
	method_id?: string;
	postal_code?: string;
	country_code?: string;
	limit?: number | string;
	street?: string;
	building?: string;
	city?: string;
}

export interface ApiClient {
	listProducts(options?: ListOptions): Promise<ApiResult>;
	getProduct(productGroupId: string, options?: RequestOverrides): Promise<ApiResult>;
	preflight(path: string, options?: Pick<RequestOverrides, 'origin'>): Promise<ApiResult>;
	createCart(options?: CreateCartOptions): Promise<ApiResult>;
	getCart(cartId: string, options?: RequestOverrides): Promise<ApiResult>;
	addCartItem(
		cartId: string,
		item: AddCartItemInput,
		options?: RequestOverrides,
	): Promise<ApiResult>;
	updateCartItem(
		cartId: string,
		variantId: string,
		update: UpdateCartItemInput,
		options?: RequestOverrides,
	): Promise<ApiResult>;
	removeCartItem(cartId: string, variantId: string, options?: RequestOverrides): Promise<ApiResult>;
	getShippingMethods(options?: RequestOverrides): Promise<ApiResult>;
	searchPickupPoints(
		params?: PickupPointSearchParams,
		options?: RequestOverrides,
	): Promise<ApiResult>;
	/**
	 * `POST /orders`. `idempotencyKey: null` omits the header — which is how
	 * the missing-key 400 is exercised (same convention as `token: null`).
	 */
	placeOrder(
		cartId: string,
		body: PlaceOrderBody,
		idempotencyKey: string | null,
		options?: RequestOverrides,
	): Promise<ApiResult>;
	/**
	 * `GET /orders/:id`. `orderToken: null` omits the `X-Order-Token` header —
	 * the missing-header 400, same convention as above.
	 */
	getOrder(
		orderId: string,
		orderToken: string | null,
		options?: RequestOverrides,
	): Promise<ApiResult>;
}

export function createClient(config: PilotConfig): ApiClient {
	async function request(
		path: string,
		options: RequestOverrides & {
			method?: string;
			query?: Record<string, string>;
			body?: unknown;
			/** Endpoint-specific headers (`Idempotency-Key`, `X-Order-Token`). */
			extraHeaders?: Record<string, string>;
		} = {},
	): Promise<ApiResult> {
		const url = new URL(`${config.apiBaseUrl}${BASE_PATH}${path}`);
		for (const [key, value] of Object.entries(options.query ?? {})) {
			url.searchParams.set(key, value);
		}

		const headers = new Headers();

		const token = options.token === undefined ? config.token : options.token;
		if (token !== null) headers.set('Authorization', `Bearer ${token}`);

		const origin = options.origin === undefined ? config.origin : options.origin;
		if (origin !== null) headers.set('Origin', origin);

		/**
		 * Consumed at Vercel's edge, never by the app. Sent on every request
		 * including preflights — without it a protected deployment 302s us to
		 * SSO and we would be asserting against a login page.
		 *
		 * A real browser preflight carries no such header, so this is a
		 * deliberate departure from browser behaviour, accepted because the
		 * alternative is not testing the deployment at all.
		 */
		if (config.vercelBypass) {
			headers.set('x-vercel-protection-bypass', config.vercelBypass);
			headers.set('x-vercel-set-bypass-cookie', 'false');
		}

		if (options.body !== undefined) headers.set('Content-Type', 'application/json');

		for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
			headers.set(name, value);
		}

		// The API budgets 120 requests per rolling minute and a full run now
		// exceeds that — wait here, when the window is full, rather than let
		// the tail of the suite drown in self-inflicted 429s (see pacing.ts).
		await paceForSharedBudget();

		const response = await fetch(url, {
			method: options.method ?? 'GET',
			headers,
			body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
			signal: AbortSignal.timeout(30_000),
			/**
			 * A redirect is an observation, not a detour. Following one silently
			 * would turn an SSO bounce or a stray 301 into an assertion against
			 * whatever page we landed on.
			 */
			redirect: 'manual',
		});

		const text = await response.text();
		let body: unknown = text;
		try {
			body = text === '' ? null : JSON.parse(text);
		} catch {
			// Leave `body` as the raw text — an HTML error page is worth seeing
			// in the assertion output rather than swallowing as a parse failure.
		}

		return { status: response.status, headers: response.headers, body };
	}

	return {
		listProducts(options = {}) {
			const query: Record<string, string> = {};
			if (options.limit !== undefined) query.limit = String(options.limit);
			if (options.offset !== undefined) query.offset = String(options.offset);
			return request('/products', { ...options, query });
		},

		getProduct(productGroupId, options = {}) {
			return request(`/products/${encodeURIComponent(productGroupId)}`, options);
		},

		preflight(path, options = {}) {
			return request(path, { ...options, method: 'OPTIONS', token: null });
		},

		createCart(options = {}) {
			const { buyer_reference, ...overrides } = options;
			const body: Record<string, unknown> = {};
			if (buyer_reference !== undefined) body.buyer_reference = buyer_reference;
			return request('/carts', { ...overrides, method: 'POST', body });
		},

		getCart(cartId, options = {}) {
			return request(`/carts/${encodeURIComponent(cartId)}`, options);
		},

		addCartItem(cartId, item, options = {}) {
			return request(`/carts/${encodeURIComponent(cartId)}/items`, {
				...options,
				method: 'POST',
				body: item,
			});
		},

		updateCartItem(cartId, variantId, update, options = {}) {
			return request(
				`/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(variantId)}`,
				{ ...options, method: 'PATCH', body: update },
			);
		},

		removeCartItem(cartId, variantId, options = {}) {
			return request(
				`/carts/${encodeURIComponent(cartId)}/items/${encodeURIComponent(variantId)}`,
				{ ...options, method: 'DELETE' },
			);
		},

		getShippingMethods(options = {}) {
			return request('/shipping/methods', options);
		},

		searchPickupPoints(params = {}, options = {}) {
			const query: Record<string, string> = {};
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined) query[key] = String(value);
			}
			return request('/shipping/pickup-points', { ...options, query });
		},

		placeOrder(cartId, body, idempotencyKey, options = {}) {
			return request('/orders', {
				...options,
				method: 'POST',
				body: { cart_id: cartId, ...body },
				...(idempotencyKey !== null
					? { extraHeaders: { 'Idempotency-Key': idempotencyKey } }
					: {}),
			});
		},

		getOrder(orderId, orderToken, options = {}) {
			return request(`/orders/${encodeURIComponent(orderId)}`, {
				...options,
				...(orderToken !== null ? { extraHeaders: { 'X-Order-Token': orderToken } } : {}),
			});
		},
	};
}
