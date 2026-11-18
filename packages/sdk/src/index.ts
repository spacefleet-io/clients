/// <reference path="./body-init.d.ts" />
/**
 * @space/sdk (DEV-API-02): the TypeScript SDK of the SpaceFleet account API.
 *
 * `src/generated/` is produced by `bun run generate` (Hey API, `@hey-api/openapi-ts`) from the
 * committed API description `apps/api/openapi.json`; never edit it by hand. This file adds the
 * pieces every caller needs on top: client creation with the `x-space-app` scope and a personal
 * token or session, and `unwrap`, which turns a non-2xx answer into an `ApiError`.
 */
import { createClient, createConfig, type Client } from "./generated/client";
import { client as defaultClient } from "./generated/client.gen";

export * from "./generated";
export type { Client } from "./generated/client";

export const SPACE_APP_HEADER = "x-space-app";

/**
 * REL-CD-29: which app, platform and version is calling (`badger/android/0.3.1`). An app sets it once at start-up
 * with {@link setSpaceClientHeader}; every client this SDK creates then sends it on every call. Tools that are not an
 * app (personal tokens, scripts) leave it unset, and the API never refuses them for their version.
 */
export const SPACE_CLIENT_HEADER = "x-space-client";

let spaceClientHeader: string | null = null;

/** Sets (or, with null, clears) the {@link SPACE_CLIENT_HEADER} value every SDK call of this process sends. */
export const setSpaceClientHeader = (value: string | null) => {
  spaceClientHeader = value?.trim() || null;
};

/** The {@link SPACE_CLIENT_HEADER} entry for a hand-written `fetch` to the API; empty when no app identity is set. */
export const spaceClientHeaders = (): Record<string, string> =>
  spaceClientHeader ? { [SPACE_CLIENT_HEADER]: spaceClientHeader } : {};

export type ApiErrorPayload = {
  error?: string;
  method?: string;
  [key: string]: unknown;
};

const apiErrorListeners = new Set<(error: ApiError) => void>();

/**
 * Calls `listener` with every `ApiError` this process creates, whichever call (SDK or hand-written fetch) got the
 * answer. An app uses it to react to an answer that concerns the whole app (REL-CD-29: "please update"). Returns the
 * unsubscribe function.
 */
export const onApiError = (listener: (error: ApiError) => void): (() => void) => {
  apiErrorListeners.add(listener);
  return () => {
    apiErrorListeners.delete(listener);
  };
};

/** A non-2xx answer from the API. `payload` is the JSON body (`{ error }` for every route). */
export class ApiError extends Error {
  status: number;
  payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.error ?? "request_failed");
    this.status = status;
    this.payload = payload;
    for (const listener of apiErrorListeners) {
      try {
        listener(this);
      } catch {
        // A listener's failure never changes the error the caller gets.
      }
    }
  }
}

export type SdkClientOptions = {
  /** API origin, with `/api` when it sits behind the website's proxy. No trailing slash needed. */
  baseUrl: string;
  /** Which app the calls act for (`x-space-app`). Omit for tools that are not an app. */
  appId?: string;
  /** Session token or personal token, sent as `Authorization: Bearer`. May be a function. */
  token?: string | (() => string | undefined | Promise<string | undefined>);
  /** Replaces the global `fetch`. */
  fetch?: typeof fetch;
};

const normalizeBaseUrl = (value: string) => {
  const trimmed = value.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const toConfig = (options: SdkClientOptions) => ({
  baseUrl: normalizeBaseUrl(options.baseUrl),
  ...(options.appId ? { headers: { [SPACE_APP_HEADER]: options.appId } } : {}),
  ...(options.token ? { auth: options.token } : {}),
  ...(options.fetch ? { fetch: options.fetch } : {}),
});

/** Adds the app identity header (when set) to every request of `client`, read at call time. */
const withSpaceClientHeader = (client: Client): Client => {
  client.interceptors.request.use((request) => {
    if (spaceClientHeader && !request.headers.has(SPACE_CLIENT_HEADER)) {
      request.headers.set(SPACE_CLIENT_HEADER, spaceClientHeader);
    }
    return request;
  });
  return client;
};

withSpaceClientHeader(defaultClient);

/** A fresh client. Pass it to any SDK function as `{ client }`. */
export const createSpaceClient = (options: SdkClientOptions): Client =>
  withSpaceClientHeader(createClient(createConfig(toConfig(options))));

/** Reconfigures the shared default client used when an SDK function gets no `client`. */
export const configureDefaultClient = (options: SdkClientOptions) => {
  defaultClient.setConfig(toConfig(options));
};

type SdkResult<T> = {
  data?: T;
  error?: unknown;
  response?: Response;
};

/**
 * Awaits an SDK call and returns its data. A non-2xx answer throws `ApiError(status, body)`, exactly
 * as the hand-written client did; a failure with no answer at all (offline, DNS, refused) rethrows
 * the original fetch error, so callers can still match e.g. React Native's "Network request failed".
 * A 2xx whose body failed to parse rejects with that error, and a 2xx that is not JSON (an SPA
 * fallback or captive portal behind a wrong host) is an `invalid_response`. A 204 gives `undefined`.
 */
export const unwrap = async <T>(call: PromiseLike<SdkResult<T>>): Promise<T> => {
  const { data, error, response } = await call;
  if (!response) throw error instanceof Error ? error : new ApiError(0, { error: "no_response" });
  if (!response.ok) {
    const payload = error && typeof error === "object" ? (error as ApiErrorPayload) : {};
    throw new ApiError(response.status, payload);
  }
  if (error !== undefined) throw error;
  if (response.status === 204) return undefined as T;
  if (!/json/i.test(response.headers.get("Content-Type") ?? "")) {
    throw new ApiError(response.status, { error: "invalid_response" });
  }
  return data as T;
};
