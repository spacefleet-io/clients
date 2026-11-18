/**
 * Wiring of the anonymous metadata tickets on this device: one ticket reserve (stored in AsyncStorage, the app's
 * private store, like the session), one direct client for the metadata service, the artwork copy's image fetch, one
 * lifecycle.
 *
 * `@space/metadata-client` is pure TypeScript (no node:*), so Metro bundles it for Hermes as is. Ticket material
 * uses `globalThis.crypto.getRandomValues`, installed by `react-native-get-random-values` in `index.js`.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Buffer } from "buffer";
import { createMetadataClient, createTicketReserve, describeRefill, metadataTicketsForBuild, NEUTRAL_USER_AGENT, NoTicketError, resolveMetadataUrl, RESERVE_STORAGE_KEY } from "@space/metadata-client";
import { metadataCreditsLoader, type CreditsSource } from "@space/metadata-client/credits";
import type { ArtworkFetchOutcome, ArtworkKind } from "@space/library-db-definition/artworkCopy";
import { getApiBaseUrl } from "@space/shared/api";
import { DEFAULT_SPACE_APP_ID, SPACE_APP_HEADER } from "@space/shared/appScope";
import { scopeLogger } from "@space/mobile-shell/logger";
import { createKeptTexts } from "./keptTexts";
import { createErasableStorage } from "./storage";
import { mobileTicketKeys } from "./ticketKey";
import { clearAssetUrlCache } from "../assets";
import { currentMobileBuildEnv } from "../devBuild";
import { createTicketLifecycle } from "./tickets";

/** Tickets blinded per issuance request (the library's maximum is 100). */
const TICKET_BATCH_SIZE = 25;

const log = scopeLogger("metadata");

const ticketStorage = createErasableStorage({
  get: (key) => AsyncStorage.getItem(key),
  set: (key, value) => AsyncStorage.setItem(key, value),
  remove: (key) => AsyncStorage.removeItem(key),
});

let sessionToken: string | null = null;
const pinnedKeys = mobileTicketKeys(currentMobileBuildEnv());

// Global fetch: every lookup sets `credentials: "omit"` itself and sends only the ticket (META-RELAY-02).
const reserve = createTicketReserve({
  storage: ticketStorage,
  fetch: (url, init) => fetch(url, init),
  // Issuance is the one call that names the account (the API checks it is paid up); the ticket it signs is blinded.
  getAuth: async () => {
    // Runs before every batch is blinded: let touches and animations through between batches.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return sessionToken ? { token: sessionToken, headers: { [SPACE_APP_HEADER]: DEFAULT_SPACE_APP_ID } } : null;
  },
  apiBaseUrl: getApiBaseUrl,
  pinnedKeys,
  // Blinding a ticket is BigInt arithmetic on the JS thread (Hermes speed unmeasured): 25 per request, not 100.
  options: { batchSize: TICKET_BATCH_SIZE },
  onRefill: (result) => {
    // Counts and the outcome class only (never a ticket); a key mismatch names the API's key and the trusted ones.
    const { level, detail } = describeRefill(result, pinnedKeys);
    log[level](result.status === "key_mismatch" ? "tickets.key_mismatch" : "tickets.refill", detail);
  },
});

let lastMetadataUrl: string | null = null;
// META-ANON-06: a Metro dev build sends no tickets unless built with SF_METADATA_TICKETS=on (babel-plugin-dev-ticket-key.js); a release always does.
const tickets = metadataTicketsForBuild({ devBuild: __DEV__, flag: process.env.SF_METADATA_TICKETS });

// The service of the API the tickets come from (META-ANON-08), never chosen by the build flavour; a dev build with
// tickets off must set EXPO_PUBLIC_METADATA_URL (META-ANON-06).
const metadataUrl = () => {
  const apiBaseUrl = getApiBaseUrl();
  const url = resolveMetadataUrl({ EXPO_PUBLIC_METADATA_URL: process.env.EXPO_PUBLIC_METADATA_URL, apiBaseUrl, tickets });
  if (url !== lastMetadataUrl) {
    lastMetadataUrl = url;
    log.info("service.url", { url, api: apiBaseUrl });
  }
  return url;
};

export const metadataClient = createMetadataClient({
  reserve,
  fetch: (url, init) => fetch(url, init),
  // META-ANON-14: React Native's own User-Agent names the app and its build.
  userAgent: NEUTRAL_USER_AGENT,
  tickets,
  metadataUrl,
});

/** Settings › About's data credits (META-SRC-09), phone and TV: from the lookups' service, the last answer in AsyncStorage. */
export const mobileCreditsSource: CreditsSource = { load: metadataCreditsLoader(metadataUrl), store: AsyncStorage };

// The detail pages' texts, kept in the library (LIB-LANG-02): a page reads the kept row; only a title never shown in
// that language (or with episodes the row never heard of) asks the service, once, and keeps the answer.
const keptTexts = createKeptTexts({
  details: (type, id, language) => metadataClient.details(type, id, language),
  onError: (stage, error) => log.warn("texts.library.failed", { stage, error: error instanceof Error ? error.message : String(error) }),
});
/** A title's synopsis in one language, for `useLocalizedOverview` on the phone and TV detail pages (LIB-LANG-01/02). */
export const fetchOverview = keptTexts.fetchOverview;
/** A show's episode names and synopses in one language, for `useLocalizedEpisodes` on the same pages (LIB-LANG-01/02). */
export const fetchEpisodes = keptTexts.fetchEpisodes;

const DATA_IMAGE_URI = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/isu;

/**
 * The artwork copy's image fetch (META-ART-01/02): one picture from the metadata service, as bytes. Only the copy
 * (`lib/artworkCopy.ts`, run after a library change or for an existing library) calls it; screens never do, they show
 * the user's own stored copy (`useMediaImage`).
 */
export const fetchArtworkImage = async (kind: ArtworkKind, path: string): Promise<ArtworkFetchOutcome> => {
  let url: string | null;
  try {
    ({ url } = await metadataClient.imageUrl(kind, path));
  } catch (error) {
    if (error instanceof NoTicketError) return { status: "no_ticket" };
    // MetadataUnavailableError, a rejected ticket, a bad status, a network error: all "try again later".
    log.warn("image.failed", { reason: error instanceof Error ? error.name : "unknown" });
    return { status: "unavailable" };
  }
  if (!url) return { status: "missing" };
  const match = DATA_IMAGE_URI.exec(url);
  if (!match) {
    log.warn("image.failed", { reason: "not_data_uri" });
    return { status: "unavailable" };
  }
  return { status: "ok", bytes: new Uint8Array(Buffer.from(match[2]!, "base64")), contentType: match[1]!.toLowerCase() };
};

/** Tickets held now: the artwork copy leaves a floor of them for the user's own lookups. */
export const ticketsHeld = () => reserve.count();

reserve.onTickets((count) => {
  log.info("tickets.batch", { held: count });
});

/** Calls `listener` each time a refill batch landed (the artwork copy goes on). Returns the unsubscribe. */
export const onTicketsArrived = (listener: () => void) => reserve.onTickets(() => listener());

export const ticketLifecycle = createTicketLifecycle({
  reserve,
  setSessionToken: (token) => {
    sessionToken = token;
  },
  // The first refills blind tickets (BigInt arithmetic) on the JS thread: not while the first screens are animating.
  // React Native 0.87 removed InteractionManager; requestIdleCallback is its replacement.
  defer: (run) => {
    requestIdleCallback(() => run());
  },
  eraseOnSignOut: async () => {
    // Through the storage's own gate, not a bare removeItem: a take() or a refill still running must not write the
    // blob back after the erase. The decrypted artwork goes with the tickets.
    await ticketStorage.erase(RESERVE_STORAGE_KEY);
    await clearAssetUrlCache();
  },
});
