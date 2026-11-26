import {
  ApiError,
  completeProviderSignIn as sharedCompleteProviderSignIn,
  getApiBaseUrl,
  getLibraryMeta as sharedGetLibraryMeta,
  getLibraryMetaForKeyStep as sharedGetLibraryMetaForKeyStep,
  login as sharedLogin,
  setApiBaseUrl,
  setApiClientType,
} from "@space/shared/api";
import { setClientIdentity, setLibraryReadOpStreamVersion } from "@space/shared/appVersion";
import { logFailedApiCalls } from "@space/shared/apiFailure";
import { DEFAULT_SPACE_APP_ID } from "@space/shared/appScope";
import { READ_OP_STREAM_VERSION } from "@space/library-db-definition/ops";
import type { KeyStepMetaOptions, MetadataSkipMarkersResult, TitleType } from "@space/shared/api";
import type { createUserStorageTunnelClient, StorageTunnelPurpose } from "@space/shared/storageTunnel";
import type { StorageObjectCounting } from "@space/shared/storageCounting";
import { resolveInitialApiBaseUrl } from "./lib/apiBaseUrl";
import { metadataClient } from "./lib/metadataTickets";
import { rendererLogger } from "./logger";

setApiBaseUrl(resolveInitialApiBaseUrl(import.meta.env));
// `<app>-<deviceType>` as Parrot's `parrot-desktop`: only such a session may hand the library key to the sister app on
// this computer (ACCT-PAIR-07); the Devices list already reads it as a computer.
const DESKTOP_CLIENT_TYPE = "badger-desktop";
setApiClientType(DESKTOP_CLIENT_TYPE);
// REL-CD-29: the window states the same build main does (read once by the preload).
setClientIdentity(typeof window === "undefined" ? null : (window.sf?.clientIdentity ?? null));
// REL-LOG-31: the window's own failed API calls (sign-in, account pages) get a console line with the server's request id.
logFailedApiCalls((fields) => rendererLogger.child({ scope: "api" }).warn({ ...fields }, "[api] call failed"));
// LIB-FMT-13: a 426 for the account's switch to an op stream this build reads is not "please update".
setLibraryReadOpStreamVersion(READ_OP_STREAM_VERSION); // op-stream: read
// REL-CD-29 / LIB-FMT-13: a "please update" refusal the runtime's own API call got (library sync, uploads) is raised
// again here as the API gave it, so this window's update gate (the `appVersion` latch every `ApiError` feeds) shows it.
if (typeof window !== "undefined") {
  window.sf?.onAppUpdateRequired?.((refusal) => {
    void new ApiError(refusal.status, refusal.payload);
  });
}

// Same alias @space/shared/api uses; type-only, so it does not pull the module in.
type UserStorageTunnelClient = ReturnType<typeof createUserStorageTunnelClient>;

// The tunnel client (@space/shared/storageTunnel, ~43 KiB) is only used after
// login, so it is loaded on first use instead of at module scope, keeping it out
// of the startup entry chunk (issue #25). It reads getApiBaseUrl on every call,
// so a base URL set before or after the load is still honoured.
let storageTunnelClient: Promise<UserStorageTunnelClient> | null = null;
const getStorageTunnelClient = (): Promise<UserStorageTunnelClient> => {
  if (storageTunnelClient) return storageTunnelClient;
  const load = import("@space/shared/storageTunnel").then(({ createUserStorageTunnelClient }) =>
    createUserStorageTunnelClient({
      getApiBaseUrl,
      preferWsDownloadStream: true,
    }),
  );
  storageTunnelClient = load;
  // A failed chunk fetch must not stick: the next tunnel call retries it.
  load.catch(() => {
    if (storageTunnelClient === load) storageTunnelClient = null;
  });
  return load;
};

// Title lookups go straight to the metadata service with an anonymous ticket (META-ANON-02, META-RELAY-01):
// no session token, no account header, no API hop. The `token` parameter is kept so callers stay as they are;
// it is never read. Errors are the metadata client's (NoTicketError, MetadataUnavailableError, ...).
export const getMetadataImageUrl = (
  _token: string,
  kind: "poster" | "backdrop" | "profile" | "still",
  path: string,
  language?: string
) => metadataClient.imageUrl(kind, path, language);

export const searchMetadata = (_token: string, type: TitleType, query: string, page = 1) =>
  metadataClient.search(type, query, page);

export const getMetadataDetails = (_token: string, type: TitleType, id: number, language = "en") =>
  metadataClient.details(type, id, language);

export const getMetadataTrailers = (_token: string, type: TitleType, id: number, language: string) =>
  metadataClient.videos(type, id, language);

/**
 * Intro and credits times for one episode, through the metadata service with one anonymous ticket
 * (META-SKIP-01): the desktop never calls a source itself.
 */
export const getMetadataSkipMarkers = (
  _token: string,
  type: TitleType,
  id: number,
  season: number,
  episode: number,
  durationSeconds?: number | null
): Promise<MetadataSkipMarkersResult> => {
  if (type !== "tv") {
    return Promise.resolve({ fetchedAt: new Date().toISOString(), markers: [], coverage: [] });
  }
  return metadataClient.skipMarkers({
    type: "tv",
    id,
    season,
    episode,
    ...(typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? { durationSeconds }
      : {}),
  });
};

export const createStorageTunnelSession = async (
  token: string,
  objectKey?: string,
  options?: { purpose?: StorageTunnelPurpose }
) => (await getStorageTunnelClient()).createSession(token, objectKey, options);

export const sendStorageTunnelFrame = async (
  token: string,
  sessionId: string,
  frame: Record<string, unknown>
) => (await getStorageTunnelClient()).sendFrame(token, sessionId, frame);

export const uploadStorageObjectViaTunnel = async (
  token: string,
  objectKey: string,
  payload: Uint8Array,
  options?: {
    objectNamespace?: string;
    logicalRef?: string;
    contentType?: string;
    chunkSize?: number;
    clientType?: string;
    clientVersion?: string;
    uploadId?: string;
    checksumFn?: (chunk: Uint8Array, seq: number) => string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  }
) => (await getStorageTunnelClient()).uploadObject(token, objectKey, payload, options);

export const downloadStorageObjectViaTunnel = async (
  token: string,
  objectKey: string,
  options?: {
    clientType?: string;
    clientVersion?: string;
    downloadId?: string;
    receiveWindow?: number;
    /** Session purpose (#145): `export` and `library` keep working once the account is unpaid. */
    purpose?: StorageTunnelPurpose;
  }
) => (await getStorageTunnelClient()).downloadObject(token, objectKey, options);

/** Which of `objectKeys` exist in the user's storage (`POST /storage/head`). Throws when any gateway fails to answer. */
export const headStorageObjects = async (token: string, objectKeys: string[]) =>
  (await getStorageTunnelClient()).headObjects(token, objectKeys);

/**
 * Password sign-in (the "Sign in with email and password instead" path of ACCT-PAIR-01). The shared call
 * (the SDK's POST /auth/login) plus the device's name and type so ACCT-DEV-01's device list shows
 * "<computer name> · Computer".
 */
export const login = async (email: string, password: string, twoFactorCode?: string, resendTwoFactor?: boolean) => {
  const deviceName = await window.sf?.pairing?.deviceName().catch(() => null);
  return sharedLogin(email, password, twoFactorCode, resendTwoFactor, {
    deviceType: "desktop",
    ...(deviceName ? { deviceName } : {}),
  });
};

/** ACCT-SIGNIN-05: the Google, Apple or Microsoft sign-in's code traded for a session, named like {@link login}. */
export const completeProviderSignIn = async (code: string, clientVerifier: string, twoFactorCode?: string, resendTwoFactor?: boolean) => {
  const deviceName = await window.sf?.pairing?.deviceName().catch(() => null);
  return sharedCompleteProviderSignIn(code, clientVerifier, twoFactorCode, resendTwoFactor, {
    deviceType: "desktop",
    ...(deviceName ? { deviceName } : {}),
  });
};

/**
 * LIB-FMT-13: this window's library reads state the op stream this build reads, so a switched account answers them
 * instead of refusing with "please update". These named exports win over the shared ones re-exported below.
 */
export const getLibraryMeta = (token: string) =>
  sharedGetLibraryMeta(token, DEFAULT_SPACE_APP_ID, READ_OP_STREAM_VERSION); // op-stream: read

export const getLibraryMetaForKeyStep = (token: string, onRead?: KeyStepMetaOptions["onRead"]) =>
  sharedGetLibraryMetaForKeyStep(token, DEFAULT_SPACE_APP_ID, { readOpStreamVersion: READ_OP_STREAM_VERSION, onRead }); // op-stream: read

export * from "@space/shared/api";
