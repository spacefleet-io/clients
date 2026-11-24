# `@space/metadata-client`

The anonymous-ticket client every app reuses: a persisted **ticket reserve** with its own refill schedule, a **direct lookup client** for the metadata service and the **metadata URL resolver**. Specs: META-ANON-02, META-ANON-03, META-RELAY-01, META-RELAY-02. Contract: tracking issue #403. Token format and blinding live in `@space/privacy-pass` (`packages/privacy-pass/README.md`).

Pure TypeScript: no `node:*`, no DOM-only API, no logging (a test walks the import graph). Runs in the Electron renderer, React Native / Hermes, Bun and Node. The host supplies `fetch`, storage and (optionally) timers and randomness. `@space/shared` is imported as types only (`TitleSearchResult` etc.), except three pure modules the test walks and holds to the same rules: `@space/shared/localizedTexts`, the import-free codec of the kept synopsis and episode texts (LIB-LANG-02), and `@space/shared/titleLanguage` and `@space/shared/mediaLanguageDisplay`, the title-language codecs (#2822).

## API

```ts
import {
  createTicketReserve, createMetadataClient, resolveMetadataUrl,
  NoTicketError, MetadataUnavailableError, TicketRejectedError, MetadataRequestError,
} from "@space/metadata-client";

interface KeyValueStorage { get(key): Promise<string | null>; set(key, value): Promise<void>; remove(key): Promise<void> }

createTicketReserve(config: {
  storage: KeyValueStorage;
  fetch: FetchLike;                                  // global fetch fits
  getAuth: () => TicketAuth | null | Promise<TicketAuth | null>;   // { token, headers? }; null = signed out
  apiBaseUrl: () => string;                          // read at every refill
  pinnedKeys?: readonly PinnedTicketKey[];           // default [PINNED_TICKET_KEY] (production, release builds); dev builds pass ticketKeysForBuild(true), every environment's key (META-ANON-07)
  random?: () => number;                             // jitter RNG, default crypto-backed
  getRandomBytes?: (n: number) => Uint8Array;        // ticket material, default globalThis.crypto
  now?: () => number;                                // default Date.now (HTTP-date Retry-After)
  timers?: { setTimeout(cb, ms): unknown; clearTimeout(handle): void };  // default global, unref'd where possible
  options?: { target = 600, lowWater = 300, batchSize = 100, intervalMs = 6h, jitter = 0.3, backoffBaseMs = 5min, storageKey };
  onRefill?: (result: RefillResult) => void;         // counts only, after every scheduled tick
}): TicketReserve

interface TicketReserve {
  count(): Promise<number>;
  take(): Promise<string | null>;                    // removes the ticket from storage BEFORE resolving; never refills
  put(ticket: string): Promise<void>;                // gives back a ticket the service did not spend (META-ANON-05); never rejects
  refill(opts?: { force?: boolean }): Promise<RefillResult>;  // single flight; below lowWater, or force
  start(): Promise<RefillResult>;                    // call when signed in; never rejects
  stop(): void;
}
type RefillResult = { status: "ok" | "skipped" | "unpaid" | "rate_limited" | "signed_out" | "network_error" | "server_error" | "rejected" | "stopped" | "error"; added: number; dropped: number; count: number; retryAfterSeconds?: number };

createMetadataClient(config: { reserve: { take(): Promise<string | null>; put?(ticket: string): Promise<void> }; fetch: FetchLike; metadataUrl: () => string; now?: () => number }): MetadataClient

interface MetadataClient {
  lookup<T>(body: { op: "search" | "details" | "videos" | "image" | "skipMarkers"; ... }): Promise<T>;
  search(type: TitleType, query: string, page = 1): Promise<{ results: TitleSearchResult[]; page: number; totalPages: number }>;
  details(type: TitleType, id: number, language = "en"): Promise<{ item: TitleDetails }>;
  videos(type: TitleType, id: number, language: string): Promise<{ trailers: Trailer[] }>;
  imageUrl(kind: "poster" | "backdrop" | "profile" | "still", path: string, language?: string): Promise<{ url: string | null }>;
  skipMarkers(request: { type: "movie"; id: number; durationSeconds?: number } | { type: "tv"; id: number; season: number; episode: number; durationSeconds?: number }): Promise<MetadataSkipMarkersResult>;
}

resolveMetadataUrl(env?: { override?, METADATA_URL?, VITE_METADATA_URL?, EXPO_PUBLIC_METADATA_URL?, apiBaseUrl? }): string
metadataUrlForApi(apiBaseUrl: string | null | undefined): string
```

Each helper posts one lookup body and resolves to the service's answer as is: `search` sends `{ op: "search", type, query, page }` and gets `{ results, page, totalPages }`; `details` sends `{ op: "details", type, id, language }` and gets `{ item }`; `videos` sends `{ op: "videos", type, id, language }` and gets `{ trailers }`; `imageUrl` sends `{ op: "image", kind, path, language? }` and gets `{ url }` (`null` when there is no picture); `skipMarkers` sends `{ op: "skipMarkers", type, id, season?, episode?, durationSeconds? }` and gets the intro and credits times, `{ fetchedAt, markers, coverage }` (META-SKIP-01: apps never call a source; `durationSeconds` only closes a credits time that runs to the end of the file). Use `lookup` for anything else.

The title, skip-marker and subtitle bodies also carry `contract: 2` (META-SRC-09): the service then answers in its neutral shape (cast and crew `personId`, a 410 `deleted`, skip markers without the source's name), so no app names where the metadata comes from.

### Behaviour

- **Reserve blob**: one JSON value `{ "v": 1, "tokens": [base64url, ...] }` under one key (`space.metadata.tickets.v1`). Tokens are never logged. A corrupt blob counts as empty; tickets whose key id is not one of the pinned keys are dropped at the first read (key rotation).
- **put()** runs under the same lock: it ignores anything that is not a well-formed token of the pinned key, skips a token already held, and swallows write failures (the ticket is then lost, as it was before put-back existed).
- **take()** is serialised by an in-process mutex shared with refill's append; the new blob is written before the ticket is returned, so a crash after `take()` never reuses it, and a failed write hands out nothing.
- **Timers**: every delay is clamped to 2^31-1 ms (`MAX_TIMER_MS`, about 24.8 days; larger values make `setTimeout` fire at once), and `Retry-After` is capped at one year. `getAuth` headers named `Authorization` or `Content-Type` (any case) are ignored. `stop()` then `start()` while a refill runs still performs the start-up refill.
- **Schedule** (`start()`): low-water check at once, then every `intervalMs` +-`jitter` (about 6 h, 4.2 to 7.8 h) using `setTimeout`. `take()`, `lookup` and uploads never start a refill or arm a timer. A tick refills only below `lowWater`, up to `target`, in batches of up to 100.
- **Refill outcomes**: `402` unpaid: keep what is held, retry at the next tick. `429`: `retryAfterSeconds` from `Retry-After` (seconds or date); the next tick is the later of the regular one and that. `401` or `getAuth() === null`: signed out, the schedule stops until `start()` is called again (call `stop()` on sign-out). Network error or 5xx or unreadable body: exponential backoff from 5 min, capped at the interval; earlier batches are kept. Signatures that do not verify against the pinned key are dropped, and an answer whose `keyId` is missing, not a string or not a pinned one drops the whole batch (fail closed) and counted in `dropped` (META-ANON-03); a batch where nothing verifies ends the refill with `rejected`.
- **Lookup**: `POST ${metadataUrl()}/lookup` with exactly two headers, `Authorization: PrivateToken token="..."` and `Content-Type: application/json`, and `credentials: "omit"`. No session, device or app header. One ticket per request. `401` drops the ticket and retries with the next (at most 2 retries, then `TicketRejectedError`); `429`/`503` throw `MetadataUnavailableError` (`status`, `retryAfterSeconds`); an empty reserve throws `NoTicketError` (the caller decides: wait for the schedule, tell the user; the client never refills inline); other statuses throw `MetadataRequestError`. A ticket is spent by its attempt, also when the request fails on the network or the service answers 429/503.
- **URL** (META-ANON-08): an explicit setting or env value wins; otherwise the metadata service of the API the tickets come from (`metadataUrlForApi`): the production API gives `https://metadata.spacefleet.io` (public from the Play closed test, REL-CD-09); an API with a port gives the same host two ports up (`http://localhost:3000` gives `http://localhost:3002`); an `api.<domain>` host gives `metadata.<domain>`; any other host gives port 3002 on it. Never the build flavour. Non-http(s) values throw.
- **Intro and credits reports** (`skipContributions.ts`, META-SKIP-05, META-SKIP-06): `queueSkipContribution({ id, season, episode, durationMs, kind: "intro" | "credits", startMs, endMs, verdict: "confirmed" | "changed" })` never throws and never sends at once. The app installs one queue with `installSkipContributionQueue(createSkipContributionQueue({ client, storage }))` when signed in and calls `uninstallSkipContributionQueue({ clear: true })` on sign-out. Reports wait under `space.metadata.skip-contributions.v1` (at most 200, a newer report for the same episode and kind replaces the older); at a random time 2 to 8 hours later (1 to 10 minutes after start for a batch that came due while closed) each goes out as `{ op: "skipContribution", ...report }`, one ticket each. 400 or 501 drops that report; any other failure keeps the rest for a new window. Reports made before the queue is installed are kept in memory for it.

## Usage per app type

The app creates one reserve and one client, calls `reserve.start()` when the user is signed in and `reserve.stop()` on sign-out. It never calls `refill()` from a lookup path.

```ts
const reserve = createTicketReserve({
  storage, fetch, apiBaseUrl: () => apiBaseUrl,
  getAuth: () => session && { token: session.token, headers: { "X-App-Scope": "desktop" } },
  onRefill: (r) => { if (r.status === "unpaid") showPaymentHint(); },
});
const metadata = createMetadataClient({ reserve, fetch, metadataUrl: () => resolveMetadataUrl({ VITE_METADATA_URL: import.meta.env.VITE_METADATA_URL, apiBaseUrl }) });
```

- **Desktop (Electron renderer)**: `storage` over the electron store (main process, ideally encrypted with `safeStorage`) or, at minimum, `localStorage` wrapped in promises; global `fetch` (credentials omit keeps the renderer's cookies out of lookups); `getAuth` returns the session and the app scope header used by the other API calls.
- **Mobile / TV (React Native, Hermes)**: `storage` over AsyncStorage or the secure store; global `fetch`; Expo env `EXPO_PUBLIC_METADATA_URL`; `globalThis.crypto.getRandomValues` needs a polyfill (`react-native-get-random-values`) or pass `getRandomBytes`.
- **Headless / runtime (Bun, Node)**: `storage` over a file (write to a temp file, then rename, so a crash cannot truncate the blob); `METADATA_URL` env.
- **Jellyfin sidecar**: same as headless, with the sidecar's own file store and the user's session; the plugin itself never sees a ticket.
- **Kodi**: Python, see the port notes below.

## Kodi port notes (algorithm)

Kodi has its own Python implementation, checked against `packages/privacy-pass/vectors/` (RFC 9474 / RFC 9578 vectors and `dev-token.json`). Steps to port, in this order:

1. **Reserve store**: one JSON file `{ "v": 1, "tokens": [...] }` in the add-on profile dir; write temp file + rename. Guard every read-modify-write with one lock.
2. **take**: under the lock read, pop one token, write the file, only then return the token. Never return a token that was not persisted as removed. Empty: return nothing and let the caller skip metadata (no inline refill).
3. **Refill** (only from the schedule): `want = min(100, target - held)`; for each of `want` draw a 32-byte random nonce, build `token_type(0x0002) || nonce || SHA-256(TokenChallenge) || token_key_id` (`packages/privacy-pass/src/token.ts`), blind it with RSABSSA-SHA384-PSS-Deterministic against the pinned modulus; POST `{ "blinded": [base64url, ...] }` to `<api>/metadata/tickets` with `Authorization: Bearer <session>` and the app's usual headers. Answer `{ "signed": [...], "keyId": hex }`: if `keyId` is missing or not the id the batch was blinded for, drop everything; when it names another pinned key (only a dev build pins more than one), blind the following batches for that key, at most once per refill; otherwise unblind each signature, verify it against the pinned modulus, drop the ones that fail, append the rest (base64url of the 354-byte token) to the store. Loop until `target` (default 600). Stop on `402` (unpaid), `429` (honour `Retry-After`), `401` (signed out: stop the schedule), a network error (back off 5 min doubling, cap at the interval), or a batch where nothing verified.
4. **Schedule**: when the add-on service starts and the user is signed in, refill if held < 300; then every 6 h x (1 +- 0.3 random). Never from a lookup. On a service restart repeat the start check.
5. **Lookup**: take one ticket; `POST <metadata url>/lookup` with only `Authorization: PrivateToken token="<base64url token>"` and `Content-Type: application/json`, body `{ "op": "search"|"details"|"videos"|"image"|"skipMarkers", ... }` (fields as in the helpers above); no cookies, no session, no device or app header. On `401` take the next ticket and retry, at most 2 retries. On `429`/`503` stop and report unavailable (honour `Retry-After`); when the answer's `error` is `rate_limited` (429) or `ticket_store_unavailable` (503) the service never spent the ticket, so `put` it back, and for `upstream_capacity` (503, spent) or any other or unreadable answer do not (META-ANON-05).
6. **Key rotation**: on the first read after an update drop stored tokens whose key id (bytes 66..98 of the token) is not one of the pinned ones.

## Tests

`bun run --cwd packages/metadata-client test` (vitest under Bun) drives the real flow in process: a fake issuer that blind-signs with the dev key, a fake lookup server that verifies every token and tracks spent nonces, manual timers, a console spy. Tests carry phase markers in their output.
