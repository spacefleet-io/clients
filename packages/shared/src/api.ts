import * as sdk from "@space/sdk";
import { ApiError, createSpaceClient, unwrap, type ApiErrorPayload } from "@space/sdk";
import { createUserStorageTunnelClient, type StorageTunnelPurpose, type TunnelUploadSource } from "./storageTunnel";
import type { StorageObjectCounting } from "./storageCounting";
import { DEFAULT_SPACE_APP_ID, SPACE_APP_HEADER, type SpaceAppId } from "./appScope";
import { clientIdentityHeaders } from "./appVersion";
import { parseLibraryOpsResponse, type ChunkRefsSource, type LibraryOpsResponse } from "./contracts/library";
import { postLibraryOp, type LibraryOpLineage, type LibraryWriterFormats } from "./libraryOpUpload";
import type { AccountAccess, BillingPeriod } from "./accountAccess";
import type { BillingStatus, PaidPlanId, PaymentOutcome, SubscriptionChangeOutcome } from "./billingCheckout";
import type { CheckoutReturnApp } from "./checkoutReturn";
import type { ApiProfile, ProfilesResponse } from "./profiles";
import type { ProfileAvatarId } from "./profileAvatars";
import type { ProfileFeatures } from "./appFeatures";
import type { AccountLanguage } from "./i18n";
import { REQUEST_TIMEOUT_ERROR, SIGN_IN_TIMEOUT_MS } from "./signInError";
import { FOUNDER_NOTICE_SEEN_PATH, FOUNDER_STATUS_PATH, type FounderStatusResponse } from "./founder";

// One error class for the whole workspace: the SDK's (DEV-API-02), so `instanceof ApiError` works
// whether a call went through the SDK or through the hand-written `apiRequest` below.
export { ApiError, type ApiErrorPayload };

/**
 * True only when the server explicitly rejected the stored token. Any other failure (no network, timeout, 5xx) must
 * keep the stored session so the app still opens offline. Shared by Badger phone/TV, Parrot phone and Parrot web.
 */
export const isSessionRejected = (error: unknown): boolean =>
  error instanceof ApiError && (error.status === 401 || error.status === 403);

type RequestOptions = {
  method?: string;
  body?: Record<string, unknown>;
  token?: string | null;
  appId?: SpaceAppId;
};

let apiBaseUrl = "/api";
let apiClientType = "client-web";

/** The one SDK client behind every account call of this module; `setApiBaseUrl` re-points it. */
const sdkClient = createSpaceClient({ baseUrl: apiBaseUrl });

export const setApiBaseUrl = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return;
  apiBaseUrl = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  sdkClient.setConfig({ baseUrl: apiBaseUrl });
};

export const getApiBaseUrl = () => apiBaseUrl;

export const setApiClientType = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return;
  apiClientType = trimmed;
};

/** Per-call SDK options: the shared client, the `x-space-app` scope and the bearer token (when given). */
const scoped = (token?: string | null, appId: SpaceAppId = DEFAULT_SPACE_APP_ID) => ({
  client: sdkClient,
  headers: { [SPACE_APP_HEADER]: appId },
  ...(token ? { auth: token } : {}),
});

const resolveUrl = (path: string) => {
  if (!path.startsWith("/")) {
    return `${apiBaseUrl}/${path}`;
  }
  return `${apiBaseUrl}${path}`;
};
const toBinaryBody = (payload: Uint8Array) => Uint8Array.from(payload);
let storageTunnelClient: ReturnType<typeof createUserStorageTunnelClient> | null = null;
type StorageTunnelOptions = {
  preferWsDownloadStream?: boolean;
  preferWebSocket?: boolean;
  tunnelMode?: "direct" | "waterfall";
  log?: (event: string, payload: Record<string, unknown>) => void;
  /** The suite app the tunnel's sessions are scoped to (`x-space-app`); Badger when unset. */
  appId?: SpaceAppId;
  /** The profile playback sessions are for (STOR-BW-11); a playback session naming none is refused with `profile_required`. */
  getProfileId?: () => string | null | undefined;
};
let storageTunnelOptions: StorageTunnelOptions = { preferWsDownloadStream: true };

export const setStorageTunnelOptions = (options: StorageTunnelOptions) => {
  storageTunnelOptions = { ...storageTunnelOptions, ...options };
  storageTunnelClient = null;
};

const getStorageTunnelClient = () => {
  if (storageTunnelClient) return storageTunnelClient;
  const { appId, ...options } = storageTunnelOptions;
  storageTunnelClient = createUserStorageTunnelClient({
    getApiBaseUrl,
    getAppId: () => appId,
    ...options,
  });
  return storageTunnelClient;
};

export type StorageTunnelSession = {
  sessionId: string;
  protocolVersion: 1;
  createdAt: number;
  expiresAt: number;
  qosTier?: "free" | "paid";
  gatewayUrl?: string;
  shardId?: string;
  placementEpoch?: number;
  resolvedObjectKey?: string | null;
  objectKeyPrefix?: string;
  features: {
    upload: boolean;
    download: boolean;
  };
};

export type StorageTunnelFrame = Record<string, unknown>;

/**
 * Hand-written fetch for the routes the SDK does not cover: the admin routes (not in the
 * published OpenAPI description). Account routes go through the SDK.
 */
export const apiRequest = async <T>(
  path: string,
  options: RequestOptions = {}
): Promise<T> => {
  const appId = options.appId ?? DEFAULT_SPACE_APP_ID;
  const res = await fetch(resolveUrl(path), {
    method: options.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      [SPACE_APP_HEADER]: appId,
      ...clientIdentityHeaders(),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as ApiErrorPayload;
    throw new ApiError(res.status, payload);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
};

/**
 * `uiLanguage`: the account's language (emails, ACCT-EMAIL-01); the API keeps `en` when it is absent. `newsOptIn`: the
 * sign-up's unticked "send me SpaceFleet news" box (ACCT-NEWS-01), recorded as `signup:<clientType>`: `desktop` for the
 * computer apps, `mobile` for the phones (ACCT-AUTH-10).
 */
export const signup = (
  email: string,
  password: string,
  uiLanguage?: AccountLanguage,
  newsOptIn = false,
  clientType: "desktop" | "mobile" = "desktop"
): Promise<{ user: User }> =>
  unwrap(sdk.signup({ ...scoped(), body: { email, password, newsOptIn, clientType, ...(uiLanguage ? { uiLanguage } : {}) } }));

/** What the device calls itself in the account's device list (`deviceType`: desktop, tv, kodi, jellyfin or mobile). */
export type LoginDevice = { deviceType?: string; deviceName?: string };

/**
 * Runs one sign-in request and gives up after `timeoutMs` with `ApiError(0, { error: "timeout" })`, so a server that
 * never answers ends in "the server did not answer", not an endless spinner (ACCT-AUTH-11).
 */
const withSignInTimeout = async <T>(send: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Race the request against the clock as well as aborting it: a fetch that ignores the abort still ends here.
  // Executor form on purpose: this runs on the phones' Hermes engine, where `Promise.withResolvers` is not guaranteed.
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError(0, { error: REQUEST_TIMEOUT_ERROR }));
    }, timeoutMs);
  });
  try {
    return await Promise.race([send(controller.signal), timedOut]);
  } catch (err) {
    if (controller.signal.aborted) throw new ApiError(0, { error: REQUEST_TIMEOUT_ERROR });
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const deviceFields = (device?: LoginDevice) => ({
  ...(device?.deviceType ? { deviceType: device.deviceType } : {}),
  ...(device?.deviceName ? { deviceName: device.deviceName } : {}),
});

/** Signs in with the password. Gives up after `timeoutMs` (default {@link SIGN_IN_TIMEOUT_MS}). */
export const login = (
  email: string,
  password: string,
  twoFactorCode?: string,
  resendTwoFactor?: boolean,
  device?: LoginDevice,
  timeoutMs: number = SIGN_IN_TIMEOUT_MS
): Promise<{ token: string; user: User }> =>
  withSignInTimeout(
    (signal) =>
      unwrap(
        sdk.login({
          ...scoped(),
          signal,
          body: { email, password, clientType: apiClientType, twoFactorCode, resendTwoFactor, ...deviceFields(device) },
        })
      ),
    timeoutMs
  );

/** ACCT-SIGNIN-05: the sign-in providers that are on, in row order (Google, Apple, Microsoft); empty when none is configured. */
export type SignInProvider = "google" | "apple" | "microsoft";
export const listSignInProviders = (): Promise<{ providers: SignInProvider[] }> => unwrap(sdk.listSignInProviders(scoped()));

/** ACCT-SIGNIN-05: the provider address to open in the system browser; it comes back to `returnTo` with `signinCode` or `signinError`. */
export const startProviderSignIn = (
  provider: SignInProvider,
  input: { returnTo: string; surface: "web" | "desktop" | "phone"; clientChallenge: string; uiLanguage?: AccountLanguage }
): Promise<{ url: string }> => unwrap(sdk.startProviderSignIn({ ...scoped(), path: { provider }, body: input }));

/** ACCT-SIGNIN-05: trades the returned `signinCode` and the app's secret for a session (two-factor as in {@link login}). */
export const completeProviderSignIn = (
  code: string,
  clientVerifier: string,
  twoFactorCode?: string,
  resendTwoFactor?: boolean,
  device?: LoginDevice
): Promise<{ token: string; user: User }> =>
  unwrap(
    sdk.completeProviderSignIn({
      ...scoped(),
      body: { code, clientVerifier, clientType: apiClientType, twoFactorCode, resendTwoFactor, ...deviceFields(device) },
    })
  );

export const verifyEmail = (email: string, code: string, device?: LoginDevice): Promise<{ token: string; user: User }> =>
  unwrap(sdk.verifyEmail({ ...scoped(), body: { email, code, clientType: apiClientType, ...deviceFields(device) } }));

export const resendVerification = (email: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.resendVerification({ ...scoped(), body: { email } }));

export const logout = (token: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.logout(scoped(token)));

export const getMe = (
  token: string
): Promise<{ user: User; access?: AccountAccess; qosTier?: "free" | "paid"; maxProfiles?: number }> =>
  unwrap(sdk.getMe(scoped(token)));

/** The account's profiles, oldest (main) first, and the plan's limit (ACCT-PROF-01, ACCT-SQUAD-02). */
export const listProfiles = (token: string): Promise<ProfilesResponse> => unwrap(sdk.listProfiles(scoped(token)));

/** Refused with 409 `profile_limit` at the plan's limit, 400 `invalid_profile` for a bad name or avatar. */
export const createProfile = (
  token: string,
  body: { name: string; avatarId?: ProfileAvatarId; features?: ProfileFeatures }
): Promise<ProfilesResponse & { profile: ApiProfile }> => unwrap(sdk.createProfile({ ...scoped(token), body }));

export const updateProfile = (
  token: string,
  id: string,
  body: { name?: string; avatarId?: ProfileAvatarId; features?: ProfileFeatures }
): Promise<ProfilesResponse & { profile: ApiProfile }> => unwrap(sdk.updateProfile({ ...scoped(token), path: { id }, body }));

/** Refused with 409 `last_profile` for the only profile left (ACCT-PROF-02); returns the remaining profiles. */
export const deleteProfile = (token: string, id: string): Promise<ProfilesResponse> =>
  unwrap(sdk.deleteProfile({ ...scoped(token), path: { id } }));

/** The move booked for the next payment (ACCT-PLAN-07/08/12), with whether the library fits it today (ACCT-PLAN-11). */
export type ScheduledPlanChange = NonNullable<sdk.ScheduledPlanChange>;

export type SubscriptionSummary = {
  plan: string;
  /** `null` = unlimited (admin, ACCT-PLAN-14): no plan is shown, nothing is billed or blocked. */
  storageLimitGb: number | null;
  storageUsedGb: number;
  storageAddonCount: number;
  access?: AccountAccess;
  paidUntil?: string | null;
  billingPeriod?: BillingPeriod | null;
  scheduledChange?: ScheduledPlanChange | null;
  /** ACCT-PLAN-11: the renewal held because the booked yearly move down did not fit; charged on `chargeAt`. */
  renewalHold?: { chargeAt: string } | null;
};

export const getSubscription = (token: string): Promise<SubscriptionSummary> => unwrap(sdk.getSubscription(scoped(token)));

/**
 * ACCT-OVER-01/03/04: what an account over its storage would lose, by media placement id, in deletion order, and the
 * placements already removed for exceeding storage. The server never knows titles; the app maps each id from its library.
 */
export type AccountOverQuotaTitles = sdk.AccountOverQuotaTitles;

export const getAccountOverQuotaTitles = (token: string): Promise<AccountOverQuotaTitles> =>
  unwrap(sdk.getAccountOverQuotaTitles(scoped(token)));

export type AccountStorageAppUsage = {
  appId: string;
  label: string;
  usedBytes: number;
};

export type AccountStorageSummary = {
  plan: string;
  storageAddonCount: number;
  /** `null` = unlimited (admin, ACCT-PLAN-14): `usageRatio` is 0 and `warningLevel` "ok". */
  limitBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
  usageRatio: number;
  warningLevel: "ok" | "warning" | "blocked";
  apps: AccountStorageAppUsage[];
  lastReconciledAt: string | null;
};

export const getAccountStorage = (token: string): Promise<AccountStorageSummary> =>
  unwrap(sdk.getAccountStorage(scoped(token)));

export type UpdateSubscriptionOptions = {
  addonCount?: number;
  billingPeriod?: BillingPeriod;
};

/**
 * Chooses a plan (ACCT-PLAN-06/07/08/11/12). The server applies it, books a move down or a period switch for
 * the next payment (`outcome` `booked`, `effectiveAt`), drops a booking when the current plan is chosen again,
 * refuses a plan the library does not fit (409 `library_too_large` with `excessBytes`), or answers 409
 * `checkout_required` when the plan is paid through `startCheckout` (Stancer: a first payment or a move up).
 * Plan ids are `free` | `tier1` | `tier2` | `tier3`; the period travels in `billingPeriod`. Callers go through
 * `@space/shared/billingCheckout` to pick the right path.
 */
export const updateSubscription = (
  token: string,
  plan: string,
  options: UpdateSubscriptionOptions = {}
): Promise<{ user: User; access?: AccountAccess; outcome: SubscriptionChangeOutcome; effectiveAt?: string | null }> =>
  unwrap(
    sdk.updateSubscription({
      ...scoped(token),
      body: {
        plan,
        ...(options.billingPeriod ? { billingPeriod: options.billingPeriod } : {}),
        ...(options.addonCount !== undefined ? { addonCount: options.addonCount } : {}),
      },
    })
  );

// --- Billing (Stancer hosted payment; ACCT-PAY-01) ---

/** Which billing provider the server runs (`standin` | `stancer`) and, with Stancer, the account's subscription. */
export const getBillingStatus = (token: string): Promise<BillingStatus> =>
  unwrap(sdk.getBillingStatus(scoped(token)));

/**
 * Starts paying a paid plan: `url` is Stancer's hosted payment page, `paymentId` what to complete it with. A desktop
 * app names itself in `returnApp` so the payment page comes back to it (ACCT-PAY-05); the website leaves it out.
 */
export const startCheckout = (
  token: string,
  input: { plan: PaidPlanId; billingPeriod: BillingPeriod; addonCount: number; lang: string; returnApp?: CheckoutReturnApp }
): Promise<{ url: string; paymentId: string; paid: boolean }> =>
  unwrap(sdk.createCheckoutSession({ ...scoped(token), body: input }));

/** The payment's result; the API asks Stancer. Safe to repeat; `pending` until Stancer settles it. */
export const completeStancerPayment = (token: string, paymentId: string): Promise<{ outcome: PaymentOutcome }> =>
  unwrap(sdk.completeStancerPayment({ ...scoped(token), path: { paymentId } }));

export const listDevices = (token: string): Promise<{ sessions: Session[] }> =>
  unwrap(sdk.listDevices(scoped(token)));

/** A "Send feedback" message (UX-SUP-05): `log` only when the user ticked the box, never a title or a file name. */
export type FeedbackInput = {
  message: string;
  app: "badger-mobile" | "parrot-mobile" | "badger-desktop" | "badger-tv" | "parrot-desktop" | "web";
  appVersion?: string | null;
  platform?: string | null;
  deviceModel?: string | null;
  log?: string | null;
};

export const sendFeedback = (token: string, body: FeedbackInput): Promise<{ id: string }> =>
  unwrap(sdk.sendFeedback({ ...scoped(token), body }));

/** Pairing, approver side (contract routes 3-5): the signed-in phone approves or denies a new device. */
export type PairingLookup = {
  requestId: string;
  /** The app asking to sign in (ACCT-PAIR-05). */
  app: SpaceAppId;
  deviceType: string;
  deviceName: string;
  publicKey: string;
  expiresAt: string;
};

export type PairingSealedKey = { v: 1; epk: string; iv: string; ct: string };

export const lookupPairing = (token: string, code: string): Promise<PairingLookup> =>
  unwrap(sdk.lookupPairing({ ...scoped(token), query: { code } }));

export const approvePairing = (
  token: string,
  requestId: string,
  sealedKey: PairingSealedKey,
  /** Push device id of the approving phone, so it is not notified about the device it just added. */
  approverDeviceId?: string,
  /** Account password, for approvers with no device unlock of their own (TV); the API checks it before approving. */
  password?: string,
  /**
   * Sent instead of `password` when the account has none (`user.hasPassword` false, ACCT-AUTH-04 / ACCT-PAIR-02): the
   * authenticator code, or the emailed code. An empty string asks the API for the code (401 `two_factor_required`).
   */
  twoFactorCode?: string
): Promise<{ ok: boolean; sessionId?: string }> =>
  unwrap(
    sdk.approvePairing({
      ...scoped(token),
      path: { requestId },
      body: {
        sealedKey,
        ...(approverDeviceId ? { approverDeviceId } : {}),
        ...(password !== undefined ? { password } : {}),
        ...(twoFactorCode !== undefined ? { twoFactorCode } : {}),
      },
    })
  );

export const denyPairing = (token: string, requestId: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.denyPairing({ ...scoped(token), path: { requestId } }));

export const revokeDevice = (token: string, sessionId: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.revokeDevice({ ...scoped(token), body: { sessionId } }));

export const requestPasswordReset = (email: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.requestPasswordReset({ ...scoped(), body: { email } }));

export const confirmPasswordReset = (email: string, code: string, newPassword: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.confirmPasswordReset({ ...scoped(), body: { email, code, newPassword } }));

export const bootstrapStatus = (): Promise<{ needsSetup: boolean }> =>
  unwrap(sdk.bootstrapStatus(scoped()));

/** Creates the first admin (ACCT-AUTH-13): `setupSecret` is the server's `API_BOOTSTRAP_SECRET`. */
export const bootstrapAdmin = (email: string, password: string, setupSecret: string): Promise<{ user: User }> =>
  unwrap(sdk.bootstrapAdmin({ ...scoped(), body: { email, password, setupSecret } }));

export const getSettings = (
  token: string
): Promise<{
  email: string;
  displayName: string | null;
  preferences: UserPreferences;
  twoFactorEnabled: boolean;
  twoFactorMethod: TwoFactorMethod | null;
  /** ACCT-NEWS-01: News emails on or off. */
  newsOptIn: boolean;
}> => unwrap(sdk.getAccountSettings(scoped(token)));

export const updateSettings = (
  token: string,
  input: Partial<{
    displayName: string | null;
    preferences: Partial<UserPreferences>;
    twoFactorEnabled: boolean;
    /** ACCT-NEWS-01: turns News emails on or off. */
    newsOptIn: boolean;
  }>
): Promise<{ user: User }> => unwrap(sdk.updateAccountSettings({ ...scoped(token), body: input }));

export type Sponsorship = {
  id: string;
  referredEmailMasked: string;
  status: "pending" | "validated";
  createdAt: string;
  eligibleAt: string;
  daysRemaining: number;
};

export const getSponsorships = (token: string): Promise<{ sponsorCode: string; sponsorships: Sponsorship[] }> =>
  unwrap(sdk.getSponsorships(scoped(token)));

/** ACCT-AUTH-04: with the second step on, the first call answers `two_factor_required` (with `method`); retry with the code. */
export const changePassword = (
  token: string,
  currentPassword: string,
  newPassword: string,
  twoFactorCode?: string
): Promise<{ ok: boolean }> =>
  unwrap(
    sdk.changePassword({
      ...scoped(token),
      body: { currentPassword, newPassword, ...(twoFactorCode ? { twoFactorCode } : {}) },
    })
  );

/**
 * The password, plus the code of the second step the account has on now, that turning a second step on, replacing it or
 * turning it off asks (ACCT-AUTH-04). Without the code the API answers 401 `two_factor_required` with the `method`.
 */
export type ReauthInput = { password: string; twoFactorCode?: string };

const reauthBody = ({ password, twoFactorCode }: ReauthInput) => ({ password, ...(twoFactorCode ? { twoFactorCode } : {}) });

export const requestEmailTwoFactorEnable = (token: string, reauth: ReauthInput): Promise<{ ok: boolean }> =>
  unwrap(sdk.requestEmailTwoFactorEnable({ ...scoped(token), body: reauthBody(reauth) }));

export const confirmEmailTwoFactorEnable = (token: string, code: string): Promise<{ user: User }> =>
  unwrap(sdk.confirmEmailTwoFactorEnable({ ...scoped(token), body: { code } }));

export const setupTotp = (
  token: string,
  reauth: ReauthInput
): Promise<{
  secret: string;
  otpauthUrl: string;
  qrCode: string;
}> => unwrap(sdk.setupTotp({ ...scoped(token), body: reauthBody(reauth) }));

export const confirmTotp = (token: string, code: string): Promise<{ user: User }> =>
  unwrap(sdk.confirmTotp({ ...scoped(token), body: { code } }));

export const disableTwoFactor = (token: string, reauth: ReauthInput): Promise<{ user: User }> =>
  unwrap(sdk.disableTwoFactor({ ...scoped(token), body: reauthBody(reauth) }));

export type TitleType = "movie" | "tv";

export type TitleSearchResult = {
  id: number;
  type: TitleType;
  title: string;
  originalTitle: string | null;
  originalLanguage: string | null;
  overview: string | null;
  year: string | null;
  rating: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  posterUrl?: string | null;
  backdropUrl?: string | null;
};

/** A person in a title's cast; `personId` is the metadata service's id of that person. */
export type CastMember = {
  personId: number | null;
  name: string;
  role: string | null;
  profilePath: string | null;
  order: number | null;
  profileUrl?: string | null;
};

export type Trailer = {
  provider: "youtube";
  key: string;
  name: string | null;
  language: string;
  official: boolean;
  size?: number | null;
};

export type TitleSeason = {
  seasonNumber: number;
  name: string;
  overview: string | null;
  posterPath: string | null;
  episodeCount: number;
  airDate: string | null;
};

export type TitleEpisode = {
  seasonNumber: number;
  episodeNumber: number;
  name: string;
  overview: string | null;
  stillPath: string | null;
  airDate: string | null;
};

/** A crew credit as the metadata service returns it (`credits.crew`). */
export type CrewMember = {
  personId: number | null;
  name: string;
  job: string | null;
  department: string | null;
  profilePath: string | null;
};

export type TitleDetails = TitleSearchResult & {
  cast: CastMember[];
  /** Crew credits (LIB-CREW-01); absent from older answers. */
  crew?: CrewMember[];
  trailers: Trailer[];
  totalEpisodes: number | null;
  seasons: TitleSeason[];
  episodes: TitleEpisode[];
  genres: number[];
  /** A show's status ("Returning Series", "Ended", "Canceled", ...); null or absent when unknown. */
  status?: string | null;
  /** The air date (YYYY-MM-DD) of a show's next episode; null or absent when none is known. */
  nextEpisodeAirDate?: string | null;
};

export type MetadataSkipMarker = {
  type: "intro" | "credits";
  startSeconds: number;
  endSeconds: number | null;
  extendsToEof: boolean;
  confidence: number | null;
  source: string;
  version: string;
  meta: Record<string, unknown> | null;
};

/**
 * The metadata service's answer to a `skipMarkers` lookup (META-SKIP-01): the best intro and credits times it knows
 * for one movie or episode (META-SKIP-02). `fetchedAt` is when the service last looked them up. `coverage` has one
 * entry for an episode (none for a movie): `hit` when it has times, `miss` otherwise.
 */
export type MetadataSkipMarkersResult = {
  fetchedAt: string;
  markers: MetadataSkipMarker[];
  coverage: Array<{
    seasonNumber: number;
    episodeNumber: number;
    status: "hit" | "miss";
    markerTypes?: Array<"intro" | "credits">;
  }>;
};

/**
 * Parrot's music lookups through the metadata service, lookup contract 2 (META-SRC-09). Every music id (artist, album,
 * recording, track) is one opaque `id` the app keeps and sends back as is; the service tells the id kinds apart. An
 * empty `results` or a `null` means "the metadata service has none".
 */
export type MusicArtistRef = { id: string | null; name: string };

export type MusicRecording = {
  id: string | null;
  title: string;
  durationMs: number | null;
  artist: MusicArtistRef;
  /**
   * The album the recording is shown with. `kind` is its type as `MusicAlbum.kind` writes it ("Album",
   * "Album + Compilation"), `official` whether that edition is an official release; both absent when the service
   * does not know.
   */
  album: {
    id: string | null;
    title: string;
    year: number | null;
    trackNumber: number | null;
    disc: number | null;
    kind?: string | null;
    official?: boolean;
  } | null;
};

export type MusicAlbumTrack = { disc: number; number: number; title: string; durationMs: number | null; id: string | null };

export type MusicAlbum = {
  id: string | null;
  title: string;
  year: number | null;
  kind: string | null;
  /** The album's first credited artist. */
  artist: MusicArtistRef;
  /** Every credited artist in credit order, given only when the album credits several (PAR-UP-06). */
  artists?: MusicArtistRef[];
  tracks: MusicAlbumTrack[];
};

/** A song's lyrics; all null when the metadata service has none. */
export type MusicLyrics = { plain: string | null; synced: string | null };

/** A picture as base64 bytes, so it rides the anonymous lookup like any answer. */
export type MusicImage = { mime: string; base64: string };

/**
 * Who took an artist's photo and under which licence (PAR-META-15): shown as "Photo: <author>, <licence>" with the
 * licence linked. `licenceUrl` is null for a public-domain photo that has none.
 */
export type MusicPhotoCredit = { author: string; licence: string; licenceUrl: string | null };

/** An artist's photo (PAR-META-15); `credit` is set when the photo's licence asks for one. */
export type MusicArtistImage = MusicImage & { credit: MusicPhotoCredit | null };

export type MusicCoverSize = 500 | 1200;

export type MusicRecordingsQuery = { artist: string; title: string; album?: string; durationMs?: number; limit?: number };
/**
 * `id` asks for that album by its id instead of by name (a held album refreshed after a new copy, PAR-COPY-01);
 * `copyVersion` names the copy the answer must come from, so an answer cached on an older copy is not reused.
 */
export type MusicAlbumsQuery = { artist: string; album: string; limit?: number; id?: string; copyVersion?: string };
/**
 * The albums each copy changed since `since` (PAR-COPY-01): `version` is the current copy (null before the first one),
 * `changes` one entry per newer copy, oldest first, each with the album ids whose details it changed.
 */
export type MusicCopyChanges = { version: string | null; changes: Array<{ version: string; albums: string[] }> };
export type MusicLyricsQuery = { artist: string; title: string; album?: string; durationMs?: number; id?: string };
/** A field of the edit dialog that autocompletes (PAR-META-18): a song's title, its artist, its album. */
export type MusicSuggestField = "title" | "artist" | "album";
/** `field`: the field being typed in; `text`: what is typed there; the other fields as they stand (context). */
export type MusicSuggestQuery = { field: MusicSuggestField; text: string; title?: string; artist?: string; album?: string; limit?: number };
/** One autocomplete result of `music_suggest` (PAR-META-18), ranked by how well it fits every field together. */
export type MusicSuggestion = {
  kind: "song" | "album" | "artist";
  artist: MusicArtistRef;
  /** For kind song: the album the song is on (original album first, PAR-META-13); for album: the album itself; null for artist. */
  album: { id: string | null; title: string; year: number | null; kind: string | null; trackNumber: number | null; disc: number | null } | null;
  /** kind song only. */
  song: { id: string | null; title: string; durationMs: number | null } | null;
  /** Which fields this result fits (the typed field always true). */
  fits: { title: boolean; artist: boolean; album: boolean };
};
/** One movie, or one episode of a show: all a subtitle search carries (PLAY-SUBGET-14, never the user's file). */
export type SubtitlesRequest =
  | { type: "movie"; id: number }
  | { type: "tv"; id: number; season: number; episode: number };

/**
 * One subtitle file the metadata service lists (PLAY-SUBGET-09). Machine- and AI-translated files never appear
 * (PLAY-SUBGET-16). `language` is the subtitle provider's code, lower case ("es", "pt-br"); `ready` is true when
 * `subtitleFile` can answer for it right away.
 */
export type SubtitleCandidate = {
  fileId: number;
  language: string;
  hearingImpaired: boolean;
  foreignPartsOnly: boolean;
  release: string;
  fileName: string;
  downloadCount: number;
  ready: boolean;
};

/**
 * The credit a subtitle source's terms ask for where subtitles are picked (META-SRC-09, PLAY-SUBGET-25): the app shows
 * `text` followed by `name` as a link to `url`, as sent. The service names the source; the app holds no source name.
 */
export type SubtitleCredit = { text: string; name: string; url: string };

/**
 * The answer to a `subtitles` lookup. `reachable: false` means the subtitle provider could not be asked (down, slow,
 * over the download allowance, or not configured) and the list holds only `ready` files (PLAY-SUBGET-11, -12).
 * `credit` is shown with the list when present (PLAY-SUBGET-25); a service before it sends none.
 */
export type SubtitlesResult = { reachable: boolean; subtitles: SubtitleCandidate[]; credit?: SubtitleCredit | null };

export type SubtitleFormat = "srt" | "ass" | "ssa" | "vtt";

/** The answer to a `subtitleFile` lookup: the file's text, UTF-8. */
export type SubtitleFileResult = { fileId: number; format: SubtitleFormat; content: string };

export type LibraryMeta = {
  exists: boolean;
  bootstrapRequired: boolean;
  syncUnavailable: boolean;
  version: number;
  snapshotVersion: number;
  hash: string | null;
  stateHash: string | null;
  lastOpId: string | null;
  consistency: "ok" | "missing_snapshot";
  updatedAt: string | null;
  keyProbe: string | null;
  keyProbeUpdatedAt: string | null;
  blobEncoding: "binary";
  snapshotId: string | null;
  manifestKey: string | null;
  chunkSize: number | null;
  /** The last snapshots, at most three. */
  snapshotHistory: Array<{ snapshotId: string; manifestKey: string; createdAt: string }>;
  /** The newest op since the snapshot only (the full ledger needs `opsHistory=all`, which no app asks for). */
  opsHistory: Array<{ opId: string; version: number; createdAt: string; size: number; objectKey: string }>;
  /**
   * Badger only: the op-stream version writers of this account declare (`writeOpStreamVersion` of
   * @space/library-db-definition/ops): 4 once the account is switched (LIB-FMT-13), else 3. Absent from older servers
   * and for Parrot.
   */
  targetOpStreamVersion?: number;
  /**
   * Parrot only: whether this account's imports store each song in parts (PAR-FMT-01, `PARROT_SPLIT_ORIGINALS` on the
   * API). Absent from older servers and for Badger: store whole.
   */
  splitOriginals?: boolean;
};

/**
 * The scope of a library READ (meta, snapshot, ops). `readOpStreamVersion` is the highest op-stream version the caller
 * reads (`READ_OP_STREAM_VERSION`), sent as `x-library-op-stream-version`; a switched account answers 426
 * `app_update_required` to a read without it (LIB-FMT-13). Omitted = no header (Parrot, builds that read no v4).
 */
const libraryReadScope = (token: string, appId: SpaceAppId, readOpStreamVersion: number | undefined) => {
  const base = scoped(token, appId);
  return readOpStreamVersion === undefined
    ? base
    : { ...base, headers: { ...base.headers, "x-library-op-stream-version": String(readOpStreamVersion) } };
};

export const getLibraryMeta = (
  token: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  readOpStreamVersion?: number
): Promise<LibraryMeta> => unwrap(sdk.getLibraryMeta(libraryReadScope(token, appId, readOpStreamVersion)));

/** The waits between tries of the key step's meta read: about 7 s in all, which covers one server copy restarting. */
export const KEY_STEP_META_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

/**
 * `getLibraryMeta` for the library key step (STOR-GATEWAY-01). An update restarts the API and the storage gateway one
 * copy at a time, and a request that lands on a copy just going away gets a 502/503 or no answer at all. The key step
 * would read that as "the key cannot be checked" and show its error, so such a failure is tried again after each of
 * `delaysMs` first. Any other answer, a refused session (401/403) above all, is final at once.
 */
export const getLibraryMetaForKeyStep = async (
  token: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  delaysMs: readonly number[] = KEY_STEP_META_RETRY_DELAYS_MS,
  readOpStreamVersion?: number
): Promise<LibraryMeta> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await getLibraryMeta(token, appId, readOpStreamVersion);
    } catch (error) {
      const transient =
        error instanceof ApiError ? error.status === 0 || error.status === 502 || error.status === 503 : error instanceof TypeError;
      const delayMs = delaysMs[attempt];
      if (!transient || delayMs === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

export const getLibraryDb = (
  token: string,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  readOpStreamVersion?: number
): Promise<{
  exists: boolean;
  version: number;
  snapshotVersion: number;
  hash: string | null;
  downloadUrl: string | null;
  manifestKey: string | null;
  updatedAt: string | null;
  blobEncoding: "binary";
  snapshotId: string | null;
  chunkSize: number | null;
  /** As `LibraryMeta.targetOpStreamVersion`. */
  targetOpStreamVersion?: number;
}> => unwrap(sdk.getLibraryDb(libraryReadScope(token, appId, readOpStreamVersion)));

export const getLibraryOps = async (
  token: string,
  sinceVersion: number,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  readOpStreamVersion?: number
): Promise<LibraryOpsResponse> => {
  const raw = await unwrap(
    sdk.getLibraryOps({ ...libraryReadScope(token, appId, readOpStreamVersion), query: { since: String(sinceVersion) } })
  );
  return parseLibraryOpsResponse(raw);
};

export type { LibraryWriterFormats };

export const putLibraryOp = (
  token: string,
  baseVersion: number,
  opId: string,
  payload: Uint8Array,
  lineage?: LibraryOpLineage,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  // Formats this build writes (see `LibraryWriterFormats`).
  formats?: LibraryWriterFormats
) =>
  postLibraryOp(
    { client: sdkClient, ...(token ? { auth: token } : {}), headers: { [SPACE_APP_HEADER]: appId } },
    baseVersion,
    opId,
    payload,
    lineage,
    formats
  );

/** What the server answers once it has taken a library snapshot (the new library version and its stamps). */
export type LibraryDbPutResult = { version: number; stateHash: string | null; lastOpId: string | null; snapshotVersion?: number };

/**
 * Send a snapshot PUT to /library/db. The new JSON-body contract carries
 * chunkRefs in the body (no header-size cap) — every snapshot's chunk refs
 * are now mandatory, so the server can authoritatively refcount chunks and
 * GC them on rotation.
 *
 * The legacy putLibraryDbBinary path remains for emergency-large-manifest
 * cases but the JSON body is the primary entry point.
 */
export const putLibraryDb = (
  token: string,
  version: number,
  blobBase64: string,
  snapshotId: string,
  chunkSize: number,
  keyProbe?: string | null,
  force?: boolean,
  stateHash?: string | null,
  lastOpId?: string | null,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  chunkRefs?: string[],
  // Pass only when chunkRefs is exactly the published manifest's chunk set
  // (see TRUSTED_CHUNK_REFS_VERSION); omitted = the orphan sweep keeps the
  // user's bucket.
  chunkRefsSource?: ChunkRefsSource,
  // Formats this build writes; omitted = the server assumes 1 and answers
  // 409 `library_format_downgrade` once the library is stamped higher.
  formats?: LibraryWriterFormats
): Promise<LibraryDbPutResult> =>
  unwrap(
    sdk.putLibraryDb({
      ...scoped(token, appId),
      body: {
        expectedVersion: version,
        manifest: blobBase64,
        manifestEncoding: "base64",
        snapshotId,
        chunkSize,
        chunkRefs: Array.isArray(chunkRefs) ? chunkRefs : [],
        ...(chunkRefsSource ? { chunkRefsSource } : {}),
        keyProbe: keyProbe ?? null,
        force: Boolean(force),
        stateHash: stateHash ?? null,
        lastOpId: lastOpId ?? null,
        ...(formats ? { storageFormatVersion: formats.storageFormatVersion, opStreamVersion: formats.opStreamVersion } : {}),
      },
    })
  );

// Kept on raw fetch: the generated `putLibraryDb` types its body as the JSON `PutLibraryDbRequest`
// and sets `Content-Type: application/json` (the published spec does not model the
// `application/octet-stream` variant), so the binary body would need a cast plus a serializer and
// content-type override on every call.
export const putLibraryDbBinary = async (
  token: string,
  version: number,
  payload: Uint8Array,
  snapshotId: string,
  chunkSize: number,
  keyProbe?: string | null,
  force?: boolean,
  stateHash?: string | null,
  lastOpId?: string | null,
  appId: SpaceAppId = DEFAULT_SPACE_APP_ID,
  chunkRefs?: string[]
) => {
  // The binary path is now an emergency fallback. We forward the chunkRefs as
  // a JSON-encoded header for compatibility, but new code paths should prefer
  // the JSON body via putLibraryDb so there's no size cap to worry about.
  const chunkRefsHeader = Array.isArray(chunkRefs) && chunkRefs.length > 0
    ? JSON.stringify(chunkRefs)
    : undefined;
  const res = await fetch(resolveUrl("/library/db"), {
    method: "PUT",
    headers: {
      "Content-Type": "application/octet-stream",
      [SPACE_APP_HEADER]: appId,
      ...clientIdentityHeaders(),
      "x-library-version": String(version),
      "x-library-snapshot-id": snapshotId,
      "x-library-chunk-size": String(chunkSize),
      "x-library-force": String(Boolean(force)),
      ...(keyProbe ? { "x-library-key-probe": keyProbe } : {}),
      ...(stateHash ? { "x-library-state-hash": stateHash } : {}),
      ...(lastOpId ? { "x-library-last-op-id": lastOpId } : {}),
      ...(chunkRefsHeader ? { "x-library-chunk-refs": chunkRefsHeader } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: toBinaryBody(payload),
  });

  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as ApiErrorPayload;
    throw new ApiError(res.status, payload);
  }

  return res.json() as Promise<{ version: number; stateHash: string | null; lastOpId: string | null }>;
};

export const rotateLibraryKey = (
  token: string,
  blobBase64: string,
  keyProbe: string,
  password: string,
  twoFactorCode?: string
): Promise<{ version: number }> =>
  unwrap(sdk.rotateLibraryKey({ ...scoped(token), body: { blobBase64, keyProbe, password, twoFactorCode } }));

export const resetLibrary = (token: string, password: string, twoFactorCode?: string): Promise<{ ok: boolean }> =>
  unwrap(sdk.resetLibrary({ ...scoped(token), body: { password, twoFactorCode } }));

export const reauthSession = (
  token: string,
  password: string,
  twoFactorCode?: string
): Promise<{ ok: boolean; method?: "email" | "totp" }> =>
  unwrap(sdk.reauthSession({ ...scoped(token), body: { password, twoFactorCode } }));

export const createStorageTunnelSession = (
  token: string,
  objectKey?: string,
  options?: {
    purpose?: StorageTunnelPurpose;
    /** The profile this playback is for, over `getProfileId` (STOR-BW-11). */
    profileId?: string | null;
  }
) =>
  getStorageTunnelClient().createSession(token, objectKey, options) as Promise<StorageTunnelSession>;

export const sendStorageTunnelFrame = (
  token: string,
  sessionId: string,
  frame: StorageTunnelFrame
) =>
  getStorageTunnelClient().sendFrame(token, sessionId, frame);

export const uploadStorageObjectViaTunnel = (
  token: string,
  objectKey: string,
  payload: Uint8Array | TunnelUploadSource,
  options?: {
    objectNamespace?: string;
    logicalRef?: string;
    contentType?: string;
    chunkSize?: number;
    clientType?: string;
    clientVersion?: string;
    uploadId?: string;
    checksumFn?: (chunk: Uint8Array, seq: number) => string | Promise<string>;
    /** Per-media silo (#145): store under media/<placementId>/ on the placement's silo. */
    placementId?: string;
    /** How the object counts toward the allowance (STOR-USE-02). */
    counting?: StorageObjectCounting;
  }
) => getStorageTunnelClient().uploadObject(token, objectKey, payload, options);

export const downloadStorageObjectViaTunnel = (
  token: string,
  objectKey: string,
  options?: {
    clientType?: string;
    clientVersion?: string;
    downloadId?: string;
    /** `export` for offline downloads / exports (allowed when the subscription is unpaid). */
    purpose?: StorageTunnelPurpose;
    /** The profile this playback is for, over `getProfileId` (STOR-BW-11). */
    profileId?: string | null;
  }
) => getStorageTunnelClient().downloadObject(token, objectKey, options);

/**
 * Per-media silo placement (#145): the silo serving `media/<placementId>/…`
 * keys (cached 60 s). Throws `StorageMediaPlacementError` — 404
 * `placement_not_found` / 503 `placement_silo_unavailable`.
 */
export const resolveMediaPlacement = (token: string, placementId: string) =>
  getStorageTunnelClient().resolveMediaPlacement(token, placementId);

/** The storage placement policy: which silo shards exist and which are active (`GET /storage/placement`). */
export const getStoragePlacementPolicy = (token: string) => unwrap(sdk.getStoragePlacement(scoped(token)));

/**
 * Push registration (`POST /push/register`). `baseUrl` is the API origin the device's session belongs to,
 * passed per call as the push handler's caller supplies it.
 */
export const registerPushDevice = (
  baseUrl: string,
  token: string,
  device: { deviceId: string; platform: "ios" | "android"; token: string }
) => unwrap(sdk.registerPushDevice({ client: createSpaceClient({ baseUrl, token }), body: device }));

/** Removes the device's push registration (`DELETE /push/unregister`). */
export const unregisterPushDevice = (baseUrl: string, token: string, deviceId: string) =>
  unwrap(sdk.unregisterPushDevice({ client: createSpaceClient({ baseUrl, token }), body: { deviceId } }));

export const listStorageObjects = (token: string): Promise<{ keys: string[] }> =>
  unwrap(sdk.listStorageObjects(scoped(token)));

/** The API frees the sizes it recorded for these keys (STOR-QUOTA-06); a client never says how many bytes it frees. */
export const deleteStorageObjects = (token: string, keys: string[]): Promise<{ deleted: number }> =>
  unwrap(sdk.deleteStorageObjects({ ...scoped(token), body: { keys } }));

/**
 * Account deletion (#145, ACCT-DEL-03). `confirm` MUST be the literal "DELETE"; the API re-checks the password (and the
 * 2FA code when enabled). Immediate (`deletion_scheduled`, every session revoked), except on a paid yearly plan past its
 * 14-day guarantee: there the default `mode: "end_of_period"` books the deletion for `deleteAt`, the end of the paid
 * year, and the account keeps working until then; `mode: "now"` deletes at once with no refund.
 */
export type DeleteAccountInput = {
  password: string;
  confirm: "DELETE";
  twoFactorCode?: string;
  mode?: "end_of_period" | "now";
};

export type DeleteAccountResult = { status: "deletion_scheduled" } | { status: "deletion_scheduled_for_period_end"; deleteAt: string };

/**
 * ACCT-DEL-03: `periodEndDeleteAt` is the end of the paid year a delete request would be booked for (null: deleting is
 * immediate); `scheduledFor` the date of a deletion already booked.
 */
export const getDeletionOptions = (token: string): Promise<{ periodEndDeleteAt: string | null; scheduledFor: string | null }> =>
  unwrap(sdk.getDeletionOptions(scoped(token)));

/** ACCT-DEL-03: cancels a deletion booked for the end of the paid year; answers the account. */
export const cancelScheduledDeletion = (token: string): Promise<{ user: User }> =>
  unwrap(sdk.cancelScheduledDeletion(scoped(token)));

export const deleteAccount = (token: string, input: DeleteAccountInput): Promise<DeleteAccountResult> =>
  unwrap(
    sdk.deleteAccount({
      ...scoped(token),
      body: {
        password: input.password,
        confirm: input.confirm,
        ...(input.twoFactorCode ? { twoFactorCode: input.twoFactorCode } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
      },
    })
  );

export type SystemContractApp = {
  supported: boolean;
  releaseStage: "ga" | "preview" | "planned";
  minClientVersion: string | null;
  dbSchemaGeneration: number;
  libraryProtocolVersion: number;
  migrationRequired: boolean;
  migrationReason: string | null;
};

export type SystemContract = {
  apiVersion: string;
  generatedAt: string;
  libraryProtocolVersion: number;
  features: {
    appScopedLibrarySync: boolean;
    storageTunnelV2: boolean;
    explicitBootstrapOnly: boolean;
  };
  apps: Record<SpaceAppId, SystemContractApp>;
};

export const getSystemContract = (): Promise<SystemContract> =>
  unwrap(sdk.getSystemContract(scoped()));

export const getSystemContractIssue = (
  contract: SystemContract | null | undefined,
  appId: SpaceAppId
): string | null => {
  const app = contract?.apps?.[appId];
  if (!app) return null;
  if (!app.supported) return app.migrationReason ?? "unsupported_app";
  if (app.migrationRequired) return app.migrationReason ?? "migration_required";
  return null;
};

export type User = {
  id: string;
  email: string;
  isAdmin: boolean;
  emailVerified: boolean;
  plan: string;
  storageLimitGb: number;
  storageUsedGb: number;
  storageAddonCount: number;
  twoFactorEnabled: boolean;
  twoFactorMethod: TwoFactorMethod | null;
  /** ACCT-AUTH-04: false for an account without a password; its re-checks ask a code instead. Absent on older APIs. */
  hasPassword?: boolean;
  preferences: UserPreferences;
  displayName: string | null;
  /** Paid/unpaid/free state computed by the API (#145). Absent on pre-#145 API builds. */
  access?: AccountAccess;
  uiLanguage?: AccountLanguage;
  /** ACCT-NEWS-01: the user chose to receive SpaceFleet News. Absent on API builds before it. */
  newsOptIn?: boolean;
  /** End of the current paid period (ISO 8601); null on the free plan. */
  paidUntil?: string | null;
  billingPeriod?: BillingPeriod | null;
  /** ACCT-DEL-03: the end of the paid year at which the account will be deleted; null when no deletion is booked. */
  deletionScheduledFor?: string | null;
};

export type Session = {
  id: string;
  userAgent?: string | null;
  clientType?: string | null;
  createdAt?: string;
  lastSeen?: string;
  current?: boolean;
  /** "desktop" | "tv" | "kodi" | "jellyfin" | "mobile" for devices added by pairing; null for older sessions. */
  deviceType?: string | null;
  /** Name the device gave itself when it was paired (ACCT-DEV-01). */
  deviceName?: string | null;
};

export type UserPreferences = {
  securityAlerts: boolean;
  deviceApprovals: boolean;
  onboardingComplete: boolean;
  billingPeriod?: "annual" | "monthly";
  /** Account language (emails, ACCT-EMAIL-01), mirrored to `users.ui_language` so server emails match the UI (#145). */
  uiLanguage?: AccountLanguage;
};

export type TwoFactorMethod = "email" | "totp";

/** WAIT-FOUND-04: the account's founder status; on a verified account the API first claims a matching waitlist place. */
export const getFounderStatus = (token: string): Promise<FounderStatusResponse> =>
  apiRequest<FounderStatusResponse>(FOUNDER_STATUS_PATH, { token });

/** WAIT-FOUND-04: the one-time founder notice was shown; the API never flags it again on any device. */
export const markFounderNoticeSeen = (token: string): Promise<{ ok: true }> =>
  apiRequest<{ ok: true }>(FOUNDER_NOTICE_SEEN_PATH, { method: "POST", token });
