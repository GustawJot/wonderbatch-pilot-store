/**
 * Self-throttling against the API's own budget.
 *
 * The storefront API allows 120 requests per ROLLING minute per (token + IP)
 * — sized to be invisible to a shopper and fatal to a script. This suite is,
 * by that definition, a script: with the 3c-3 shipping endpoints on board a
 * full run fires ~130 requests in under a minute, and the last file started
 * receiving honest 429s. The API is behaving exactly as documented, so the
 * client adapts, not the API.
 *
 * Serialization (`--test-concurrency=1`) already spaces the FAILURE budget;
 * this paces the shared success budget the same way a considerate real store
 * would: before each request, if the trailing window is at capacity, wait
 * until the oldest request falls out of it.
 *
 * WHY A FILE AND NOT A VARIABLE: node's test runner puts every test file in
 * its own child process, so an in-memory tally would reset 14 times per run.
 * The tally lives in a gitignored JSON file beside this repo's `.env`, which
 * also — usefully — paces back-to-back `npm test` runs against the same
 * still-warm server window. Files run one at a time, so read-modify-write
 * needs no locking.
 *
 * The cap deliberately sits BELOW the real 120: the server counts its own
 * receipt times (this file counts send times), `check-api-up` and any
 * parallel human curiosity are invisible here, and the pacer counts a few
 * requests the server never charges (preflights, auth failures — those
 * charge a separate budget). The slack absorbs all of that; a 429 that
 * still gets through is therefore a genuine API surprise, not noise.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

/** One second over the server's 60s so boundary requests never race the prune. */
const WINDOW_MS = 61_000;
/** The server allows 120; the difference is the slack described above. */
const MAX_IN_WINDOW = 105;

const STATE_FILE = fileURLToPath(new URL('../.request-window.json', import.meta.url));

function readWindow(now: number): number[] {
	let stamps: unknown;
	try {
		stamps = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
	} catch {
		return []; // Missing or corrupt — either way an empty window is the safe read.
	}
	if (!Array.isArray(stamps)) return [];
	return stamps.filter((t): t is number => typeof t === 'number' && now - t < WINDOW_MS);
}

/**
 * Blocks until the shared budget has room, then claims one slot. Call once
 * per outgoing request, before sending it.
 */
export async function paceForSharedBudget(): Promise<void> {
	let now = Date.now();
	let window = readWindow(now);

	while (window.length >= MAX_IN_WINDOW) {
		await sleep(window[0] + WINDOW_MS - now + 50);
		now = Date.now();
		window = readWindow(now);
	}

	window.push(now);
	writeFileSync(STATE_FILE, JSON.stringify(window));
}
