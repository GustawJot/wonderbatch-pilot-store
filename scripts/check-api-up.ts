/**
 * Runs before the suite. One clear failure beats twenty connection-refused
 * errors that all say the same thing.
 */

import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const url = `${config.apiBaseUrl}/api/external/storefront/v1/products`;

let response: Response;
try {
	response = await fetch(url, {
		headers: { Authorization: `Bearer ${config.token}`, Origin: config.origin },
		signal: AbortSignal.timeout(10_000),
	});
} catch {
	console.error(
		`✗ Cannot reach the API at ${config.apiBaseUrl}.\n\n` +
			`  Start it from the Wonderbatch repo:\n` +
			`    cd ../wonderbatch/web && npm run dev\n\n` +
			`  Use dev, NOT preview. A production build treats localhost as a\n` +
			`  non-primary domain and 301s every request — API routes included —\n` +
			`  to http://wonderbatch.coffee:3000, so nothing here can reach it.`,
	);
	process.exit(1);
}

if (response.status === 401) {
	console.error(
		`✗ The API is up but rejected the token (401).\n\n` +
			`  Re-mint it from the Wonderbatch repo:\n` +
			`    cd ../wonderbatch/web && node --env-file=.env.development \\\n` +
			`      scripts/mint-storefront-token.mjs --channel=${config.channelKey} --commit\n\n` +
			`  Then paste the new value into .env as WB_STOREFRONT_TOKEN.`,
	);
	process.exit(1);
}

if (response.status === 403) {
	console.error(
		`✗ The API is up but refused our origin (403): ${config.origin}\n\n` +
			`  That origin is not in the channel's security.allowed_origins.\n` +
			`  Comparison is by exact string — check for a trailing slash or a wrong port.`,
	);
	process.exit(1);
}

if (!response.ok) {
	console.error(`✗ Unexpected status ${response.status} from ${url}`);
	process.exit(1);
}

console.log(`✓ API reachable at ${config.apiBaseUrl}, token and origin accepted.`);
