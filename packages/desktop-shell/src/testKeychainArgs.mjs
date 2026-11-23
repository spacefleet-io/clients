/**
 * Chromium switches every test or dev launch of a desktop app (Badger, Parrot) gets: safeStorage (the session store's
 * encryption) uses an in-memory key instead of the user's login keychain. A test run must never read or write the
 * operator's keychain, and on macOS an ad-hoc-signed rebuild is a different binary to the keychain's access list, so a
 * real lookup stops the run at a password prompt. No effect on Linux / Windows. Never part of a packaged app's own
 * launch: a released app keeps its session in the real keychain.
 *
 * Plain .mjs so the Node-run scripts (`dev`, `memory:report`) share it with the TypeScript suites
 * (integration, e2e, e2e-ultimate). Guarded by tests/test-keychain-args.test.ts.
 *
 * @type {readonly string[]}
 */
export const TEST_KEYCHAIN_ARGS = Object.freeze(["--use-mock-keychain"]);
