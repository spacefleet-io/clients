/**
 * #25: the renderer `localStorage` entries that make up the signed-in session.
 * The main process keeps its own durable copy of exactly these entries
 * (main/sessionStore.ts) so an abrupt kill / crash cannot sign the user out
 * or drop the user back on /home instead of the route they were on.
 *
 * Shared by main (validation), preload (IPC channels) and renderer (mirror).
 */

/** The route a relaunch reopens (renderer/lib/routePersistence.ts). */
export const LAST_AUTHENTICATED_ROUTE_KEY = "sf_last_authenticated_route";

/** The auth token (renderer/auth.tsx). */
export const AUTH_TOKEN_KEY = "sf_client_token";

/** Auth token + cached user (renderer/auth.tsx) and the last route. */
const SESSION_EXACT_KEYS: Readonly<Record<string, true>> = {
  [AUTH_TOKEN_KEY]: true,
  sf_client_user: true,
  [LAST_AUTHENTICATED_ROUTE_KEY]: true,
};

/**
 * Library key + acknowledgement (renderer/lib/onboarding.ts): the bare keys and
 * the per-user scoped ones (`sf_client_library_key:<userId>`,
 * `sf_client_library_key_ack:<userId>`).
 */
const SESSION_KEY_PREFIXES = ["sf_client_library_key"] as const;

export const isSessionStorageKey = (key: string): boolean =>
  Object.hasOwn(SESSION_EXACT_KEYS, key) || SESSION_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

export type SessionEntries = Record<string, string>;

/** Largest accepted value; a token / user blob / library key is far below this. */
export const SESSION_VALUE_MAX_BYTES = 64 * 1024;

export const SESSION_SNAPSHOT_CHANNEL = "sf-session-snapshot";
export const SESSION_REPLACE_CHANNEL = "sf-session-replace";

/** Keep only well-formed session entries; anything else is dropped, never persisted. */
export const sanitizeSessionEntries = (input: unknown): SessionEntries => {
  const out: SessionEntries = {};
  if (typeof input !== "object" || input === null || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isSessionStorageKey(key)) continue;
    if (typeof value !== "string") continue;
    if (new TextEncoder().encode(value).byteLength > SESSION_VALUE_MAX_BYTES) continue;
    out[key] = value;
  }
  return out;
};
