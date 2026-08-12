/**
 * The request layer — the only file here that knows about HTTP.
 *
 * It NEVER throws on a non-2xx response. On this surface a 401 or a 403 is the
 * behaviour under test, not a failure, so refusals come back as data like any
 * other response.
 */

import type { PilotConfig } from './config.ts';

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

export interface ApiClient {
	listProducts(options?: ListOptions): Promise<ApiResult>;
	getProduct(productGroupId: string, options?: RequestOverrides): Promise<ApiResult>;
	preflight(path: string, options?: Pick<RequestOverrides, 'origin'>): Promise<ApiResult>;
}

export function createClient(config: PilotConfig): ApiClient {
	async function request(
		path: string,
		options: RequestOverrides & { method?: string; query?: Record<string, string> } = {},
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

		const response = await fetch(url, {
			method: options.method ?? 'GET',
			headers,
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
	};
}
