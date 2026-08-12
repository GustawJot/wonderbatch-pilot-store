/**
 * Configuration for the conformance client.
 *
 * Deliberately absent: any database URI. This client proves the API by using
 * it, and a client that could read the database could accidentally prove the
 * API works by reading around it.
 */

export interface PilotConfig {
	/** The Wonderbatch API we call. No trailing slash. */
	apiBaseUrl: string;
	/** What we claim to be. Must exactly match an entry in the channel's allowlist. */
	origin: string;
	/** The `wb_pk_` publishable token. */
	token: string;
	/** Never sent — the API resolves the channel from the token. Ours to assert against. */
	channelKey: string;
}

const REQUIRED = [
	'WB_API_BASE_URL',
	'WB_PILOT_ORIGIN',
	'WB_STOREFRONT_TOKEN',
	'WB_CHANNEL_KEY',
] as const;

export function loadConfig(env: Record<string, string | undefined> = process.env): PilotConfig {
	const missing = REQUIRED.filter((key) => !env[key]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required environment variable(s): ${missing.join(', ')}.\n` +
				`Copy .env.example to .env and fill it in.`,
		);
	}

	const origin = env.WB_PILOT_ORIGIN!;
	if (origin.endsWith('/')) {
		throw new Error(
			`WB_PILOT_ORIGIN has a trailing slash ("${origin}").\n` +
				`The API compares origins by exact string, so this would never match the ` +
				`channel allowlist and every request would 403.`,
		);
	}

	return {
		apiBaseUrl: env.WB_API_BASE_URL!.replace(/\/+$/, ''),
		origin,
		token: env.WB_STOREFRONT_TOKEN!,
		channelKey: env.WB_CHANNEL_KEY!,
	};
}
