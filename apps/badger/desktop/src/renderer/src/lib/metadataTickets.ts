/**
 * Anonymous metadata lookups for the desktop renderer (META-ANON-01/02, META-RELAY-01).
 *
 * Title lookups no longer go through the account API: the renderer keeps a reserve of blind-signed tickets
 * (obtained from the API while signed in, in batches, never per lookup) and spends one per request when it
 * talks straight to the metadata service. A lookup request carries exactly `Authorization: PrivateToken ...`
 * and `Content-Type`, with `credentials: "omit"`; the session token is only ever sent to the API's
 * `POST /metadata/tickets` (the issuance request made by the reserve).
 *
 * The session logic (generation guard, reserve, client) is `createSessionMetadata` in `@space/metadata-client`, shared
 * with the web player; `getDesktopMetadata()` is the one instance the app uses, wired to localStorage, fetch and the
 * API base URL.
 */
import {
  createMetadataImageResolver,
  createSessionMetadata,
  refillLogLine,
  metadataTicketsForBuild,
  resolveMetadataUrl,
  RESERVE_STORAGE_KEY,
  syncStorageAdapter,
  type ImageKind,
  type ImageOutcome,
  type MetadataClient,
  type MetadataImageResolver,
  type RefillResult,
  type SessionMetadata,
} from "@space/metadata-client";
import { localStorageCreditsStore, metadataCreditsLoader, type CreditsSource } from "@space/metadata-client/credits";
import { createWorkerTicketCrypto, ticketKeysForBuild, type PinnedTicketKey } from "@space/privacy-pass";
import { currentDesktopBuildEnv, isDesktopDevBuild, type DesktopBuildEnv } from "../../../shared/devBuild";
import { getApiBaseUrl } from "@space/shared/api";
import { SPACE_APP_HEADER } from "@space/shared/appScope";
import { AUTH_TOKEN_KEY } from "../../../shared/sessionKeys";
import { closeArtworkSession, getRendererArtworkStore, openArtworkSession } from "./artworkCache";
import { createLookupPacer } from "./lookupPacer";

export { RESERVE_STORAGE_KEY };

/**
 * The ticket keys this build trusts (META-ANON-03, META-ANON-06, META-ANON-07): in a development build
 * ({@link isDesktopDevBuild}: `electron-vite dev` or a `VITE_SF_DEV_TICKET_KEY=1` test build) the key of every
 * environment, dev and production, so the server picker (ACCT-AUTH-09) can point at any API; in every other build,
 * release packages included, the production key only. Decided by the build, never by the URL the app talks to.
 */
export const desktopTicketKeys = (env: DesktopBuildEnv): readonly PinnedTicketKey[] => ticketKeysForBuild(isDesktopDevBuild(env));

/**
 * One log line per scheduled refill, worded by the shared `refillLogLine`. A `key_mismatch` (META-ANON-07) says
 * which key the API signs with and which keys this build trusts: the app then holds no ticket and every title search
 * reports that metadata is unavailable. Key ids are public (`GET /metadata/tickets/key`); no ticket or blinded value is logged.
 */
export const logRefillResult = (result: RefillResult, trustedKeys: readonly PinnedTicketKey[], log: Pick<Console, "info" | "warn"> = console): void => {
  const { level, line } = refillLogLine(result, trustedKeys);
  log[level](`[metadata-tickets] ${line}`);
};

let instance: SessionMetadata | null = null;
let metadataUrlOverride: string | null = null;
// META-ANON-06: a `vite dev` run sends no tickets unless the build says VITE_METADATA_TICKETS=on; a package always does.
const desktopTickets = () => metadataTicketsForBuild({ devBuild: import.meta.env.DEV === true, flag: import.meta.env.VITE_METADATA_TICKETS });
// An explicit SF_METADATA_URL / VITE_METADATA_URL wins; otherwise the service of the API the tickets come from
// (META-ANON-08), whatever the build flavour (a `build:test` -devkey package is not `DEV`). A dev build with tickets
// off must set one (META-ANON-06).
const metadataUrl = () =>
  resolveMetadataUrl({ override: metadataUrlOverride, VITE_METADATA_URL: import.meta.env.VITE_METADATA_URL, apiBaseUrl: getApiBaseUrl(), tickets: desktopTickets() });

/** Settings → About's data credits (META-SRC-09): from the lookups' metadata service, the last answer kept in localStorage. */
export const desktopCreditsSource: CreditsSource = { load: metadataCreditsLoader(metadataUrl), store: localStorageCreditsStore };

/** The main process' `SF_METADATA_URL` (apiHost.get().metadataUrl), the same way the API base URL reaches the renderer. */
export const setMetadataUrlOverride = (value: string | null | undefined): void => {
  metadataUrlOverride = value?.trim() ? value.trim() : null;
};

export const getDesktopMetadata = (): SessionMetadata => {
  if (instance) return instance;
  const pinnedKeys = desktopTicketKeys(currentDesktopBuildEnv());
  const tickets = desktopTickets();
  instance = createSessionMetadata({
    storage: syncStorageAdapter(() => window.localStorage),
    // Every lookup of the app shares one pace (META-PUB-02's per-connection limit): see lookupPacer.ts.
    fetch: createLookupPacer((url, init) => globalThis.fetch(url, init)),
    // The session is read at every refill, so a token that changed or went away is seen at once. These headers
    // go to the API only (the issuance request): the lookups the client makes never take any.
    getAuth: () => {
      const token = window.localStorage.getItem(AUTH_TOKEN_KEY);
      return token ? { token, headers: { [SPACE_APP_HEADER]: "badger" } } : null;
    },
    apiBaseUrl: () => getApiBaseUrl(),
    // META-ANON-12: a refill's RSA blinding (~40 ms a ticket here) runs in a worker, never on the renderer's thread.
    ticketCrypto: createWorkerTicketCrypto(new Worker(new URL("./ticketCrypto.worker.ts", import.meta.url), { type: "module", name: "sf-ticket-crypto" })),
    pinnedKeys,
    onRefill: (result) => logRefillResult(result, pinnedKeys),
    tickets,
    metadataUrl,
  });
  // Each batch of a refill is logged as it lands (the refill line above comes only once the whole refill is done), and
  // artwork that failed for lack of a ticket may be asked again at once.
  instance.reserve.onTickets((count) => {
    console.info(`[metadata-tickets] batch landed held=${count}`);
    imageResolver?.forgetFailures();
  });
  return instance;
};

/** The metadata client the renderer uses for every title lookup and every intro/credits lookup (META-SKIP-01). */
export const metadataClient: MetadataClient = {
  lookup: (body) => getDesktopMetadata().client.lookup(body),
  search: (type, query, page) => getDesktopMetadata().client.search(type, query, page),
  details: (type, id, language) => getDesktopMetadata().client.details(type, id, language),
  videos: (type, id, language) => getDesktopMetadata().client.videos(type, id, language),
  imageUrl: (kind, path, language) => getDesktopMetadata().client.imageUrl(kind, path, language),
  skipMarkers: (request) => getDesktopMetadata().client.skipMarkers(request),
  subtitles: (request) => getDesktopMetadata().client.subtitles(request),
  subtitleFile: (fileId) => getDesktopMetadata().client.subtitleFile(fileId),
  musicRecordings: (query) => getDesktopMetadata().client.musicRecordings(query),
  musicAlbums: (query) => getDesktopMetadata().client.musicAlbums(query),
  musicLyrics: (query) => getDesktopMetadata().client.musicLyrics(query),
  musicCover: (mbidReleaseGroup, size) => getDesktopMetadata().client.musicCover(mbidReleaseGroup, size),
  musicArtistImage: (mbidArtist) => getDesktopMetadata().client.musicArtistImage(mbidArtist),
  musicCopyChanges: (since) => getDesktopMetadata().client.musicCopyChanges(since),
};

let imageResolver: MetadataImageResolver | null = null;

/**
 * The resolver behind `resolveArtwork`. Its answers stay in memory only: each one is needed once (copied into the
 * user's storage, or shown in an import picker), and writing them to the renderer's artwork store would let a
 * whole-library migration push the decrypted vault copies browsing reads out of that byte-bounded store.
 */
export const createDesktopImageResolver = (client: MetadataClient): MetadataImageResolver => createMetadataImageResolver(client);

const getImageResolver = (): MetadataImageResolver => {
  imageResolver ??= createDesktopImageResolver(metadataClient);
  return imageResolver;
};

/**
 * Artwork for `path` from the metadata service, as a `data:` URI. Only the import, refresh and copy paths ask
 * (META-ART-01: the copy into the user's storage, the heal of a lost copy); browsing never does, it shows the
 * user's own copy (`useMediaImage`). The desktop never asks TMDB's image CDN itself (META-DIRECT-03). Never
 * rejects; the outcome says why an image is missing.
 */
export const resolveArtwork = (kind: ImageKind, path: string): Promise<ImageOutcome> =>
  getImageResolver().resolveDetailed(kind, path);

/** Call once the user is signed in (token and user known) and again on every app start with a session. */
export const startMetadataTickets = (): void => {
  console.info("[metadata-tickets] refill schedule starting");
  openArtworkSession();
  void getDesktopMetadata().start();
};

export interface KeyStepWatch {
  isAcknowledged: () => Promise<boolean>;
  onAcknowledged: (listener: () => void) => () => void;
}

/**
 * META-ANON-11: starts the ticket refill (`start`, default {@link startMetadataTickets}) once the library key step is
 * done: at once when this device already acknowledged the key, else when it does. Signing and unblinding a refill
 * keeps the renderer busy for tens of seconds, which held the key page on "Loading key…" for 24 s right after
 * sign-in (release gate 34718). Nothing can be looked up before the key step: there is no library yet. Returns the
 * cancel, which stops waiting (a refill already started keeps running).
 */
export const startMetadataTicketsAfterKeyStep = (watch: KeyStepWatch, start: () => void = startMetadataTickets): (() => void) => {
  let settled = false;
  const go = () => {
    if (settled) return;
    settled = true;
    unsubscribe();
    start();
  };
  const unsubscribe = watch.onAcknowledged(go);
  void watch.isAcknowledged().then(
    (acknowledged) => {
      if (acknowledged) go();
    },
    () => undefined,
  );
  return () => {
    settled = true;
    unsubscribe();
  };
};

/**
 * Calls `listener` each time tickets arrive (a refill batch landed): a screen that showed "title search is
 * unavailable" looks up again without the user doing anything. Returns the unsubscribe.
 */
export const onMetadataTicketsAvailable = (listener: () => void): (() => void) =>
  getDesktopMetadata().reserve.onTickets(() => listener());

/** Call on sign-out: stops the schedule, clears the stored reserve and the artwork cache (memory and disk). */
export const stopMetadataTickets = async (): Promise<void> => {
  closeArtworkSession();
  await Promise.all([imageResolver?.clear(), getRendererArtworkStore().clear(), getDesktopMetadata().stop()]);
};
