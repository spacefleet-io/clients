/**
 * Minimal `fetch` shape the runtime client needs. Deliberately not
 * `typeof fetch`: that type carries runtime-specific statics (Bun's
 * `fetch.preconnect`) which test doubles and non-Bun hosts do not provide.
 */
export type RuntimeFetch = (input: string, init?: RequestInit) => Promise<Response>;
