/**
 * The phone's anonymous lookups (META-ANON-01/02, PAR-META-05): one ticket reserve stored in AsyncStorage (the app's
 * private store) and one client for the metadata service, through the session logic every client shares
 * (`createSessionMetadata`, @space/metadata-client). Started when the library opens after sign-in (`startLookup`,
 * META-ANON-02), stopped at sign-out, which drops every stored ticket. Only the ticket issuance carries the session;
 * a lookup carries one ticket and the song's names, never the account or a file.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createSessionMetadata, describeRefill, metadataTicketsForBuild, NEUTRAL_USER_AGENT, resolveMetadataUrl, type MetadataClient } from "@space/metadata-client";
import { metadataCreditsLoader, type CreditsSource } from "@space/metadata-client/credits";
import { ticketKeysForBuild } from "@space/privacy-pass";
import { getApiBaseUrl } from "@space/shared/api";
import { SPACE_APP_HEADER } from "@space/shared/appScope";
import { PRODUCTION_API_BASE_URL } from "@space/shared/productionApi";
import { API_BASE_URL } from "../config";
import { libraryToken } from "./library";
import { PARROT_COPY_TICKET_FLOOR } from "@space/parrot-core";

/**
 * A dev build, or a test build pointed at a dev stack (PARROT_API_BASE_URL inlined), trusts the dev stack's ticket key
 * as well as production's; a store build trusts production's only (META-ANON-06/07). Agent reading, approved by Main
 * (2026-11-10): the Parrot phone has no server picker, so the inlined API address is what marks a dev-stack build.
 */
const devBuild = __DEV__ || API_BASE_URL !== PRODUCTION_API_BASE_URL;
const pinnedKeys = ticketKeysForBuild(devBuild);
/** META-ANON-06: a Metro dev build sends no tickets unless built with PARROT_METADATA_TICKETS=on (babel-plugin-api-base-url.js); a release always does. */
const tickets = metadataTicketsForBuild({ devBuild: __DEV__, flag: process.env.PARROT_METADATA_TICKETS });

const log = (event: string, payload: Record<string, unknown>) => console.log(`parrot.lookup ${event} ${JSON.stringify(payload)}`);

// The service of the API the tickets come from (META-ANON-08), never chosen by the build flavour; a Metro dev build
// with tickets off (META-ANON-06, PARROT_METADATA_TICKETS unless `on`) must set EXPO_PUBLIC_METADATA_URL.
const metadataUrl = () => resolveMetadataUrl({ EXPO_PUBLIC_METADATA_URL: process.env.EXPO_PUBLIC_METADATA_URL, apiBaseUrl: getApiBaseUrl(), tickets });

/** Settings' data credits (META-SRC-09): from the lookups' metadata service, the last answer kept in AsyncStorage. */
export const parrotCreditsSource: CreditsSource = { load: metadataCreditsLoader(metadataUrl), store: AsyncStorage };

const metadata = createSessionMetadata({
  storage: {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
  },
  fetch: (url, init) => fetch(url, init),
  getAuth: () => {
    const token = libraryToken();
    return token ? { token, headers: { [SPACE_APP_HEADER]: "parrot" } } : null;
  },
  apiBaseUrl: getApiBaseUrl,
  tickets,
  metadataUrl,
  pinnedKeys,
  // META-ANON-14: React Native's own User-Agent names the app and its build.
  userAgent: NEUTRAL_USER_AGENT,
  // Counts and the outcome class only, never a ticket or a title.
  onRefill: (result) => log("tickets.refill", { detail: describeRefill(result, pinnedKeys).detail }),
});

let started: Promise<unknown> | null = null;

/** META-ANON-02: the library opened after sign-in starts the reserve, never the first lookup. Idempotent until sign-out. */
export const startLookup = (): void => {
  started ??= metadata.start();
};

/** The lookup client; a lookup waits for the running refill's first batch only (META-ANON-10). */
export const lookupClient = async (): Promise<MetadataClient> => {
  startLookup();
  await metadata.scheduleRunning();
  return metadata.client;
};

/**
 * PAR-COPY-01: the background copy passes (lyrics, album covers, artist photos) stop at the ticket floor, so the tickets
 * left are kept for what the user asks. Read once the sign-in refill ended and its random delay passed (META-ANON-13);
 * a build whose lookups carry no ticket (META-ANON-06) has no floor and no delay.
 */
export const aboveTicketFloor = async (): Promise<boolean> => {
  if (!tickets) return true;
  startLookup();
  await started;
  await metadata.backgroundReady();
  return (await metadata.reserve.count()) > PARROT_COPY_TICKET_FLOOR;
};

/** Sign-out: stops the reserve and drops every stored ticket. */
export const stopLookup = (): void => {
  started = null;
  void metadata.stop().catch((error: unknown) => log("tickets.drop_failed", { message: error instanceof Error ? error.message : String(error) }));
};
