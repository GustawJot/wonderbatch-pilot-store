/**
 * Runs before the suite. One clear failure beats twenty connection-refused
 * errors that all say the same thing.
 */

import { loadConfig } from '../src/config.ts';

const config = loadConfig();
const url = `${config.apiBaseUrl}/api/external/storefront/v1/products`;

const headers: Record<string, string> = {
	Authorization: `Bearer ${config.token}`,
	Origin: config.origin,
};
if (config.vercelBypass) {
	headers['x-vercel-protection-bypass'] = config.vercelBypass;
	headers['x-vercel-set-bypass-cookie'] = 'false';
}

let response: Response;
try {
	response = await fetch(url, {
		headers,
		signal: AbortSignal.timeout(10_000),
		redirect: 'manual',
	});
} catch {
	console.error(
		`✗ Cannot reach the API at ${config.apiBaseUrl}.\n\n` +
			`  Start it from the Wonderbatch repo:\n` +
			`    cd ../wonderbatch/web && npm run dev\n\n` +
			`  Use dev, NOT preview. Vite's preview server stamps a wildcard\n` +
			`  allow-origin header on responses that lack one, and it runs in\n` +
			`  production mode — so it connects to the PRODUCTION database and a\n` +
			`  valid dev token is rejected there.`,
	);
	process.exit(1);
}

if (response.status >= 300 && response.status < 400) {
	const location = response.headers.get('location') ?? '(no Location header)';
	const isSso = location.includes('vercel.com/sso-api');

	console.error(
		`✗ The API redirected (${response.status}) instead of answering.\n\n` +
			`  Location: ${location}\n\n` +
			(isSso
				? `  That is Vercel Deployment Protection. dev. and preview.wonderbatch.coffee\n` +
					`  sit behind SSO, so an unauthenticated request never reaches the app.\n\n` +
					`  Set WB_VERCEL_BYPASS in .env to the project's Protection Bypass for\n` +
					`  Automation secret (Vercel → Settings → Deployment Protection).\n` +
					(config.vercelBypass
						? `  One IS set and was sent, so it is likely wrong or has been rotated.`
						: `  None is currently set.`)
				: `  A production build treats a non-primary host as a redirect target.\n` +
					`  Check WB_API_BASE_URL.`),
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
