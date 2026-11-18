/**
 * Chromium switches every test launch of the app gets: safeStorage (the session store's encryption) uses an
 * in-memory key instead of the user's login keychain. A test run must never read or write the operator's keychain,
 * and on macOS an ad-hoc-signed rebuild is a different binary to the keychain's access list, so a real lookup
 * stops the run at a password prompt. No effect on Linux / Windows.
 *
 * Plain .mjs so the Node-run scripts (`memory:report`) share it with the TypeScript suites
 * (integration, e2e, e2e-ultimate).
 *
 * @type {readonly string[]}
 */
export const TEST_KEYCHAIN_ARGS = Object.freeze(["--use-mock-keychain"]);
