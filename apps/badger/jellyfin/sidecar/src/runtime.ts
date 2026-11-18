import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  ARTWORK_COPY_PAUSE_MS,
  artworkDisplaySource,
  buildArtworkAssetRef,
  copyMediaArtwork,
  createArtworkCopyQueue,
  createVaultArtworkUpload,
  newArtworkObjectKey,
  scheduleArtworkMigration,
  type ArtworkCopyQueue,
  type ArtworkFetchOutcome,
  type ArtworkKind,
} from "@space/library-db-definition/artworkCopy";
import { LibraryDb } from "@space/library-db-runtime";
import { getLibraryMeta } from "@space/library-db-runtime/api";
import {
  createDetailsTexts,
  createMetadataClient,
  createTicketReserve,
  describeRefill,
  MetadataRequestError,
  MetadataUnavailableError,
  NEUTRAL_USER_AGENT,
  NoTicketError,
  resolveMetadataUrl,
  TicketRejectedError,
  type MetadataClient,
  type TicketReserve,
} from "@space/metadata-client";
import { ticketKeysForBuild } from "@space/privacy-pass";
import type { ApiProfile } from "@space/shared/profiles";
import { createUserStorageTunnelClient } from "@space/shared/storageTunnel";
import { withPlaybackProfile } from "./playbackProfile";
import { createStreamSlotsClient } from "@space/stream-slots";
import { JellyfinStreamSlots } from "./streamSlots";
import { mergeTrackPrefs, type TrackPrefs } from "@space/shared/trackPrefs";
import type { IntegrationConfig } from "./config";
import { errorMessage, errorPayload, errorStatus, isUnauthorizedError } from "./errors";
import { buildIntegrationLibrary, type IntegrationLibrary } from "./library";
import { askTexts, episodeKeysOf, needsTexts, pacedDetails, TextsHeldError } from "./localizedTexts";
import { decryptAssetObject, deriveMediaMasterKey, encryptLibraryEnvelope, parseLibraryKey, verifyKeyProbe } from "./mediaCrypto";
import { ObjectStore } from "./objectStore";
import { PairingFlow, type PairingResult, type PairingSnapshot } from "./pairing";
import { chosenProfileOf, fetchProfiles, followChosenProfile, readTrackPrefs, writeProgress, writeTrackPrefs, type ChosenProfile } from "./profile";
import type { IntegrationDeps, IntegrationProfiles, IntegrationStatus } from "./server";
import { createFileKeyValueStorage, type TicketStorage } from "@space/metadata-client/fileStorage";

type AuthState = { token: string; email: string | null; userId: string | null; apiUrl: string };

type AccessSnapshot = {
  state: IntegrationStatus["accessState"];
  paidUntil: string | null;
  wipeAt: string | null;
};

type LogFn = (message: string, meta?: Record<string, unknown>) => void;

const trackPrefsView = (prefs: TrackPrefs | null) => ({
  audioLanguage: prefs?.audioLanguage ?? null,
  subtitle: prefs?.subtitle ?? null,
  updatedAt: prefs?.updatedAt ?? null,
});

/** The artwork copy stops while the ticket reserve is at or below this, keeping tickets for matches (META-ANON-02). */
const ARTWORK_COPY_TICKET_FLOOR = 100;
/** Pause after the metadata service answered 429/503 without a Retry-After, or could not be reached at all. */
const METADATA_PAUSE_DEFAULT_MS = 60_000;
const METADATA_PAUSE_NETWORK_MS = 30_000;
const METADATA_PAUSE_MAX_MS = 60 * 60 * 1000;

const ASSET_REF = /^asset:([^:]*(?::[^:]+)*)::(.+)$/;

const guessImageType = (bytes: Uint8Array, fallback = "image/jpeg") => {
  if (bytes.length > 3 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 12 && bytes[8] === 0x57 && bytes[9] === 0x45) return "image/webp";
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return fallback;
};

/**
 * Owns the sidecar's account + library: sign-in, library snapshot/ops sync, 401 => wipe, change
 * notifications, image resolution. The HTTP layer (server.ts) only sees `IntegrationDeps`.
 */
export class IntegrationRuntime {
  private auth: AuthState | null = null;
  private db: LibraryDb | null = null;
  private opening: Promise<void> | null = null;
  private libraryKey: Buffer | null = null;
  private access: AccessSnapshot = { state: "unknown", paidUntil: null, wipeAt: null };
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private signedOutReason: string | null = null;
  private changeSeq = 1;
  private localRevision = 0;
  private libraryCache: { key: string; library: IntegrationLibrary } | null = null;
  private readonly waiters = new Set<() => void>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  /**
   * True until `start()` has loaded the stored state and run its first tick (login, profile, library open).
   * main.ts opens the port before that, so /status answers `starting` instead of a refused connection.
   */
  private starting = true;
  readonly objectStore: ObjectStore;
  private readonly tunnel;
  private readonly pairing: PairingFlow;
  /** Anonymous metadata tickets (META-ANON-02): refilled on its own schedule while signed in, never by a lookup. */
  private readonly tickets: TicketReserve;
  private readonly ticketStorage: TicketStorage;
  private readonly metadata: MetadataClient;
  /** While in the future no lookup is attempted: a service that is rate limiting or down would only burn tickets
   * (a dropped connection spends one). It outlives one title's copy, so the next title does not ask again early. */
  private metadataPausedUntil = 0;
  /** A key the library's key probe refused: not retried until the user supplies another. */
  private rejectedKey: string | null = null;
  /** The one profile this server follows (INTG-PROF-01), `profile.json`; null until picked. */
  private profile: ChosenProfile | null = null;
  /** The account's profiles from the last `GET /profiles`. */
  private profiles: ApiProfile[] | null = null;
  /** A pairing approved for an account with several profiles: nothing is stored until the owner picks one. */
  private pendingPairing: PairingResult | null = null;
  /**
   * INTG-PROF-01: no profile can be followed. `deleted` = the followed one was deleted elsewhere (missing from
   * `GET /profiles`, or the api refused it); `choose` = a session from before profiles on an account with several.
   * Never switches: until the owner picks on the settings page, state is `needs_profile`, no viewing state is written,
   * nothing syncs and no further `GET /profiles` is sent (in memory: a restart asks the api once and lands here again).
   */
  private profileNeeded: "deleted" | "choose" | null = null;
  /** META-ART-01: copies provider-path artwork into the user's storage, one title at a time; null until a library opens. */
  private artworkQueue: ArtworkCopyQueue | null = null;
  /** LIB-LANG-02: asks the synopses and episode texts no library row keeps yet, one title at a time; null until a library opens. */
  private textsQueue: ArtworkCopyQueue | null = null;
  /** Decrypted artwork on disk by file base name (size, last shown); scanned from disk on the first write after a start. */
  private imageCacheIndex: Map<string, { size: number; shownAt: number }> | null = null;
  private imageCacheGeneration = 0;
  private imageCacheWrites: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: IntegrationConfig,
    private readonly log: LogFn
  ) {
    // Remote hosts cannot use the loopback gatewayUrl: try every shard address, then gatewayUrl (waterfall); no API fallback.
    // STOR-BW-11: every playback session and traffic read names the followed profile. The fetch wrapper sends it on any shared
    // client; `getProfileId` is the shared client's own hook (PR 826) and is ignored by a client without it.
    const getProfileId = () => this.followedProfileId;
    const tunnelOptions = { getApiBaseUrl: () => this.apiUrl, tunnelMode: "waterfall" as const, getProfileId, fetchImpl: withPlaybackProfile(getProfileId) };
    this.tunnel = createUserStorageTunnelClient(tunnelOptions);
    this.objectStore = new ObjectStore({
      fetcher: (key, purpose, onChunk) => this.downloadObject(key, purpose, onChunk),
      masterKey: null,
      maxBytes: config.objectCacheBytes,
      prefetchCount: config.prefetchCount,
      prefetchParallel: config.prefetchParallel,
      log,
    });
    // `fetch` is read at call time so the sidecar and its tests can swap the global.
    const fetchFn = (url: string, init: Parameters<typeof fetch>[1]) => fetch(url, init);
    this.ticketStorage = createFileKeyValueStorage(path.join(config.stateDir, "metadata-tickets"));
    const pinnedKeys = ticketKeysForBuild(config.devTicketKey);
    this.tickets = createTicketReserve({
      storage: this.ticketStorage,
      fetch: fetchFn,
      // The same session credential the sidecar uses for every other API call; issuance refuses personal tokens.
      getAuth: () => (this.auth ? { token: this.auth.token, headers: { "x-space-app": "badger" } } : null),
      apiBaseUrl: () => this.apiUrl,
      pinnedKeys,
      // Counts only, never a ticket or a title; a key mismatch names the API's key and the trusted ones (META-ANON-07).
      onRefill: (result) => {
        this.log("metadata ticket refill", describeRefill(result, pinnedKeys).detail);
        // A copy or a texts run that stopped at the ticket floor (META-ART-01, LIB-LANG-02) resumes once tickets came in.
        if (result.added > 0) {
          void this.startArtworkCopies("tickets-refilled");
          this.startTexts("tickets-refilled");
        }
      },
    });
    // The service of the API the tickets come from (this.apiUrl: the saved session's, else the configured one;
    // META-ANON-08), unless HEADLESS_METADATA_URL / METADATA_URL names one.
    this.metadata = createMetadataClient({
      reserve: this.tickets,
      fetch: fetchFn,
      metadataUrl: () => resolveMetadataUrl({ override: config.metadataUrlOverride, apiBaseUrl: this.apiUrl }),
      // META-ANON-14: Node's fetch would otherwise send its own User-Agent.
      userAgent: NEUTRAL_USER_AGENT,
    });
    this.pairing = new PairingFlow({
      log,
      deviceType: "jellyfin",
      onApproved: (result) => this.onPairingApproved(result),
    });
  }

  private get apiUrl() {
    return this.auth?.apiUrl ?? this.config.apiUrl;
  }

  /**
   * A server address the plugin or a saved session asks for counts on a dev run only (ACCT-AUTH-09, the
   * HEADLESS_DEV_TICKET_KEY switch); any other run uses the production API (`config.apiUrl`), a stale saved one ignored.
   */
  private accountApiUrl(requested: string | null | undefined): string {
    const picked = this.config.devTicketKey && requested ? requested : this.config.apiUrl;
    return picked.replace(/\/+$/, "");
  }

  private get authPath() {
    return path.join(this.config.stateDir, "auth.json");
  }

  /** The private key file (PRIV-KEY-04: 0600 where the OS has modes; wiped on sign-out, PRIV-KEY-05). */
  private get keyPath() {
    return this.config.libraryKeyFile ?? path.join(this.config.stateDir, "library.key");
  }

  /** The followed profile (INTG-PROF-01): `{id, name, prefix}`, removed with the rest of the state on sign-out. */
  private get profilePath() {
    return path.join(this.config.stateDir, "profile.json");
  }

  /** API uuid of the followed profile (INTG-PROF-01), null until picked; for playback tunnel sessions (STOR-BW-11). */
  get followedProfileId(): string | null {
    return this.profile?.id ?? null;
  }

  // --- lifecycle ---------------------------------------------------------

  async start() {
    try {
      await fsp.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
      process.env.SF_USER_DATA_PATH = path.join(this.config.stateDir, "library-client");
      process.env.SF_API_BASE_URL = this.apiUrl;
      this.auth = await this.loadAuth();
      this.signedOutReason = await this.loadSignedOut();
      this.profile = await this.loadProfile();
      if (this.auth) {
        process.env.SF_API_BASE_URL = this.auth.apiUrl;
      }
      this.startTickets();
      this.timers.push(setInterval(() => void this.tick(), 5_000));
      this.timers.push(setInterval(() => void this.syncOnce("interval"), this.config.syncIntervalMs));
      this.timers.push(setInterval(() => void this.refreshAccess(), 60_000));
      await this.tick();
    } finally {
      this.starting = false;
    }
  }

  async stop() {
    this.stopped = true;
    this.tickets.stop();
    this.artworkQueue?.stop();
    this.artworkQueue = null;
    this.textsQueue?.stop();
    this.textsQueue = null;
    this.timers.forEach((timer) => clearInterval(timer));
    this.timers = [];
    this.db?.close();
    this.db = null;
    this.wake();
  }

  /** Starts the ticket schedule once a session exists; `start()` never rejects and `refill` is single flight. */
  private startTickets() {
    if (!this.auth || this.stopped) return;
    this.ticketStorage.open();
    void this.tickets.start();
  }

  private async loadAuth(): Promise<AuthState | null> {
    if (this.config.apiToken) {
      return { token: this.config.apiToken, email: this.config.email, userId: null, apiUrl: this.config.apiUrl };
    }
    try {
      const parsed = JSON.parse(await fsp.readFile(this.authPath, "utf8")) as Partial<AuthState>;
      if (typeof parsed.token === "string" && parsed.token) {
        return {
          token: parsed.token,
          email: parsed.email ?? null,
          userId: parsed.userId ?? null,
          apiUrl: this.accountApiUrl(parsed.apiUrl),
        };
      }
    } catch {
      // no stored session
    }
    return null;
  }

  private async loadSignedOut(): Promise<string | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.signedOutPath, "utf8")) as { reason?: string };
      return parsed.reason ?? "signed_out";
    } catch {
      return null;
    }
  }

  private async saveAuth(auth: AuthState) {
    await fsp.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.authPath, JSON.stringify(auth), { mode: 0o600 });
    await fsp.chmod(this.authPath, 0o600).catch(() => undefined);
  }

  private readLibraryKey(): string | null {
    if (this.config.libraryKeyBase64) return this.config.libraryKeyBase64;
    try {
      const text = fs.readFileSync(this.keyPath, "utf8").trim();
      return text || null;
    } catch {
      return null;
    }
  }

  private async writeLibraryKey(keyBase64: string) {
    await fsp.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.keyPath, `${keyBase64}\n`, { mode: 0o600 });
    await fsp.chmod(this.keyPath, 0o600).catch(() => undefined);
  }

  /** State machine step: sign in if possible, open the library once token + key exist. */
  private async tick() {
    if (this.stopped || this.opening || this.db) return;
    if (this.signedOutReason) return;
    if (!this.auth && this.config.email && this.config.password) {
      try {
        await this.performLogin({
          email: this.config.email,
          password: this.config.password,
          twoFactorCode: this.config.twoFactorCode,
        });
      } catch (error) {
        this.lastError = `login_failed: ${errorMessage(error)}`;
        this.log("sidecar login failed", { error: errorMessage(error), detail: errorPayload(error) });
        return;
      }
    }
    if (!this.auth) return;
    const keyText = this.readLibraryKey();
    if (!keyText || keyText === this.rejectedKey) return;
    this.opening = (async () => {
      // INTG-PROF-01: nothing syncs until the followed profile is known.
      if (await this.ensureProfile()) await this.openLibrary(keyText);
    })().finally(() => {
      this.opening = null;
    });
    await this.opening;
  }

  // --- profile (INTG-PROF-01) ----------------------------------------------

  private async loadProfile(): Promise<ChosenProfile | null> {
    try {
      const parsed = JSON.parse(await fsp.readFile(this.profilePath, "utf8")) as Partial<ChosenProfile>;
      if (typeof parsed.id === "string" && parsed.id && typeof parsed.prefix === "string") {
        return { id: parsed.id, name: typeof parsed.name === "string" ? parsed.name : "", prefix: parsed.prefix };
      }
    } catch {
      // never picked
    }
    return null;
  }

  private async saveProfile(profile: ChosenProfile) {
    await fsp.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(this.profilePath, JSON.stringify(profile), { mode: 0o600 });
    this.profile = profile;
  }

  /** Stores the followed profile; a new key prefix swaps the viewing state the plugin sees (the media stay). A pick also ends a pause. */
  private async applyProfile(profile: ChosenProfile, reason: string) {
    const previous = this.profile;
    const resumed = this.profileNeeded;
    this.profileNeeded = null;
    await this.saveProfile(profile);
    this.log("followed profile stored", { reason, profileId: profile.id, isMain: profile.prefix === "", previousId: previous?.id ?? null, previousPrefix: previous?.prefix ?? null, resumedFrom: resumed });
    if ((previous?.prefix !== profile.prefix || resumed) && this.db) {
      // The change feed moves, so the plugin re-applies resume / watched / track choices from this profile.
      this.libraryCache = null;
      this.localRevision += 1;
      this.bump();
    }
  }

  /** INTG-PROF-01: stop and ask; never switch to another profile. */
  private pauseForProfile(kind: "deleted" | "choose", reason: string, detail: Record<string, unknown> = {}) {
    if (this.profileNeeded === kind) return;
    this.profileNeeded = kind;
    this.log(
      kind === "deleted"
        ? "followed profile was deleted: viewing state paused until a profile is picked in the plugin settings"
        : "session from before profiles on an account with several: waiting for a profile pick in the plugin settings",
      { reason, profileId: this.profile?.id ?? null, ...detail }
    );
    this.bump();
  }

  /**
   * Fresh `GET /profiles` (the prefix follows `isMain`, which moves when the main profile is deleted elsewhere).
   * Failure keeps the last list and the stored choice.
   */
  private async refreshProfiles(reason: string) {
    const auth = this.auth;
    if (!auth || this.stopped || this.profileNeeded) return;
    let profiles: ApiProfile[];
    try {
      profiles = await fetchProfiles(auth.apiUrl, auth.token);
    } catch (error) {
      this.log("profile list unavailable", { reason, error: errorMessage(error) });
      if (isUnauthorizedError(error)) await this.refreshAccess();
      return;
    }
    if (this.auth !== auth) return;
    this.profiles = profiles;
    const stored = this.profile;
    if (!stored) return;
    const follow = followChosenProfile(stored, profiles);
    if (follow.kind === "missing") {
      this.pauseForProfile("deleted", `list_${reason}`, { listed: profiles.map((entry) => entry.id) });
      return;
    }
    if (follow.changed) await this.applyProfile(follow.profile, `list_${reason}`);
  }

  /**
   * True once a profile is followed. A session stored before profiles existed takes the account's only profile; with
   * several the owner picks (state `needs_profile`), as when pairing.
   */
  private async ensureProfile() {
    if (this.profileNeeded) return false;
    await this.refreshProfiles("open");
    if (this.profileNeeded) return false;
    if (this.profile) return true;
    const profiles = this.profiles;
    if (!profiles?.length) {
      this.lastError = "profiles_unavailable";
      return false;
    }
    if (profiles.length > 1) {
      this.pauseForProfile("choose", "session_before_profiles", { count: profiles.length });
      return false;
    }
    this.log(`profile: session from before profiles: following the account's only profile ${profiles[0].id}`);
    await this.applyProfile(chosenProfileOf(profiles[0]), "session_before_profiles");
    return true;
  }

  /** The api refused the followed profile on a playback session (403 profile_not_owned / 400 profile_required). */
  private noteProfileRefusal(error: unknown) {
    const status = errorStatus(error);
    const code = errorPayload(error).error;
    if ((status === 403 && code === "profile_not_owned") || (status === 400 && code === "profile_required")) {
      this.pauseForProfile(this.profile ? "deleted" : "choose", `api_${code}`);
    }
  }

  /** Viewing writes need a followed profile (INTG-PROF-01): refused while paused, so nothing lands in another profile's history. */
  private requireFollowedProfile() {
    if (this.profileNeeded) throw Object.assign(new Error("profile_needed"), { status: 409 });
  }

  private statusProfile() {
    return this.profile ? { id: this.profile.id, name: this.profile.name, isMain: this.profile.prefix === "" } : null;
  }

  /** Picks the followed profile: finishes a pairing waiting for it, or changes it from the settings. */
  async chooseProfile(profileId: string): Promise<IntegrationStatus> {
    const pending = this.pendingPairing;
    if (pending) {
      const profiles = await fetchProfiles(pending.apiUrl, pending.token);
      this.profiles = profiles;
      const picked = profiles.find((entry) => entry.id === profileId);
      if (!picked) throw Object.assign(new Error("profile_not_found"), { status: 404 });
      this.pendingPairing = null;
      try {
        await this.applyProfile(chosenProfileOf(picked), "pairing_pick");
        await this.commitPairing(pending);
        this.pairing.settleProfilePick(null);
      } catch (error) {
        this.pairing.settleProfilePick(errorMessage(error));
        throw error;
      }
      return this.status();
    }
    const auth = this.auth;
    if (!auth || this.signedOutReason) throw Object.assign(new Error("not_signed_in"), { status: 409 });
    const profiles = await fetchProfiles(auth.apiUrl, auth.token);
    this.profiles = profiles;
    const picked = profiles.find((entry) => entry.id === profileId);
    if (!picked) throw Object.assign(new Error("profile_not_found"), { status: 404 });
    await this.applyProfile(chosenProfileOf(picked), this.profile ? "settings_change" : "first_pick");
    if (!this.db) await this.tick();
    return this.status();
  }

  async listProfiles(): Promise<IntegrationProfiles> {
    const pending = this.pendingPairing;
    if (pending) this.profiles = await fetchProfiles(pending.apiUrl, pending.token);
    // Paused for a pick: the owner opened the settings page, so this one request is theirs (the sync loop sends none).
    else if (this.profileNeeded && this.auth) this.profiles = await fetchProfiles(this.auth.apiUrl, this.auth.token);
    else await this.refreshProfiles("settings");
    return { profile: this.statusProfile(), profiles: this.profiles ?? [], required: this.status().state === "needs_profile" };
  }

  private async openLibrary(keyText: string) {
    const auth = this.auth;
    if (!auth) return;
    try {
      const key = parseLibraryKey(keyText);
      await this.verifyKeyProbe(auth.token, keyText);
      this.libraryKey = key;
      this.objectStore.setMasterKey(deriveMediaMasterKey(key));
      const started = Date.now();
      this.log("opening library", { tokenTail: auth.token.slice(-6), apiUrl: auth.apiUrl, envApiUrl: process.env.SF_API_BASE_URL, fromEnvToken: Boolean(this.config.apiToken), keyChars: keyText.length });
      const db = await LibraryDb.open(auth.token, keyText.replace(/\s+/g, ""));
      this.db = db;
      this.lastError = null;
      this.lastSyncAt = new Date().toISOString();
      this.localRevision += 1;
      this.bump();
      this.log("library opened", { version: db.getVersion(), ms: Date.now() - started });
      void this.startArtworkCopies("library-open");
      this.startTexts("library-open");
      await this.refreshAccess();
    } catch (error) {
      this.lastError = `library_open_failed: ${errorMessage(error)}`;
      this.log("library open failed", { error: errorMessage(error), stack: error instanceof Error ? error.stack : null });
      if (errorMessage(error) === "library_key_mismatch" || errorMessage(error) === "library_key_invalid") this.rejectedKey = keyText;
      // Only /auth/me answering 401 wipes the key and state; an error string alone never does.
      if (isUnauthorizedError(error)) await this.refreshAccess();
    }
  }

  /** Same check as typing the key by hand on the desktop: the library's key probe must decrypt with this key. */
  private async verifyKeyProbe(token: string, keyText: string) {
    const meta = await getLibraryMeta(token);
    if (!meta.exists || !meta.keyProbe) return;
    if (!(await verifyKeyProbe(keyText, meta.keyProbe))) throw new Error("library_key_mismatch");
  }

  async syncOnce(reason: string) {
    const db = this.db;
    // INTG-PROF-01: paused for a profile pick: nothing syncs and no request is sent until the owner picks.
    if (!db || this.stopped || this.profileNeeded) return;
    await this.refreshProfiles(reason);
    try {
      const before = db.getVersion();
      const changed = await db.syncFromRemoteIfNewer();
      this.lastSyncAt = new Date().toISOString();
      this.lastError = null;
      if (changed || db.getVersion() !== before) {
        this.log("library changed remotely", { reason, from: before, to: db.getVersion() });
        this.localRevision += 1;
        this.bump();
        // Titles matched or refreshed on another device may hold provider paths that device could not copy yet.
        void this.startArtworkCopies(`sync:${reason}`);
        // New titles and new episodes need texts in the interface language (LIB-LANG-02).
        this.startTexts(`sync:${reason}`);
      }
    } catch (error) {
      this.lastError = `sync_failed: ${errorMessage(error)}`;
      this.log("library sync failed", { reason, error: errorMessage(error) });
      if (isUnauthorizedError(error)) await this.refreshAccess();
    }
  }

  private async refreshAccess() {
    const auth = this.auth;
    if (!auth || this.stopped) return;
    try {
      const res = await fetch(`${auth.apiUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${auth.token}`, "x-space-app": "badger" },
      });
      if (res.status === 401) {
        await this.wipe("api_401");
        return;
      }
      if (!res.ok) {
        this.log("auth/me failed", { status: res.status });
        return;
      }
      const body = (await res.json()) as {
        user?: { id?: string; email?: string };
        access?: { state?: string; paidUntil?: string | null; wipeAt?: string | null };
      };
      const state = body.access?.state;
      this.access = {
        state: state === "free" || state === "paid" || state === "unpaid" ? state : "unknown",
        paidUntil: body.access?.paidUntil ?? null,
        wipeAt: body.access?.wipeAt ?? null,
      };
      if (body.user?.id && auth.userId !== body.user.id) {
        auth.userId = body.user.id;
        auth.email = body.user.email ?? auth.email;
        if (!this.config.apiToken) await this.saveAuth(auth);
      }
    } catch (error) {
      this.log("auth/me unreachable", { error: errorMessage(error) });
    }
  }

  /** 401 from the api: the device was revoked or the account is gone. Wipe key + state (PRIV-KEY-05). */
  private async wipe(reason: string) {
    this.log("signing out: wiping key file and state", { reason });
    this.signedOutReason = reason;
    this.pairing.cancel();
    this.tickets.stop();
    // No refill may write tickets back once the state is gone (it would survive the sign-out).
    await this.ticketStorage.close();
    this.metadataPausedUntil = 0;
    this.artworkQueue?.stop();
    this.artworkQueue = null;
    this.textsQueue?.stop();
    this.textsQueue = null;
    this.imageCacheIndex = null;
    // A picture still downloading or being written for the old session must not recreate the cache after the wipe.
    this.imageCacheGeneration += 1;
    const db = this.db;
    this.db = null;
    db?.close();
    this.auth = null;
    this.libraryKey = null;
    this.rejectedKey = null;
    this.objectStore.setMasterKey(null);
    this.libraryCache = null;
    this.profile = null;
    this.profiles = null;
    this.pendingPairing = null;
    this.profileNeeded = null;
    await fsp.rm(this.keyPath, { force: true }).catch(() => undefined);
    await fsp.rm(this.config.stateDir, { recursive: true, force: true }).catch(() => undefined);
    await fsp.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 }).catch(() => undefined);
    // Survives a restart so the Jellyfin plugin still learns it must remove the generated library.
    await fsp.writeFile(this.signedOutPath, JSON.stringify({ reason, at: new Date().toISOString() }), { mode: 0o600 }).catch(() => undefined);
    this.access = { state: "unknown", paidUntil: null, wipeAt: null };
    this.log("signed out: key file, session and cached library removed", { reason });
    this.bump();
  }

  private get signedOutPath() {
    return path.join(this.config.stateDir, "signed-out.json");
  }

  private async clearSignedOut() {
    this.signedOutReason = null;
    await fsp.rm(this.signedOutPath, { force: true }).catch(() => undefined);
  }

  // --- pairing (ACCT-PAIR-01, PRIV-KEY-05) ---------------------------------

  /** Asks the api for a code the user approves with the phone app. */
  async startPairing(input: { deviceName: string; apiUrl?: string | null }): Promise<PairingSnapshot> {
    if (this.auth && !this.signedOutReason) throw Object.assign(new Error("already_signed_in"), { status: 409 });
    this.dropPendingPairing("pairing_restarted");
    const apiUrl = this.accountApiUrl(input.apiUrl);
    return this.pairing.start({ apiUrl, deviceName: input.deviceName || this.config.deviceName });
  }

  cancelPairing() {
    this.dropPendingPairing("pairing_cancelled");
    this.pairing.cancel();
  }

  /** An approved pairing still waiting for its profile pick: its session is revoked, nothing was stored. */
  private dropPendingPairing(reason: string) {
    const pending = this.pendingPairing;
    if (!pending) return;
    this.pendingPairing = null;
    this.profiles = null;
    this.log("pairing dropped before the profile pick: revoking its session", { reason });
    void fetch(`${pending.apiUrl}/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${pending.token}`, "x-space-app": "badger" },
    }).catch((error) => this.log("logout request failed", { error: errorMessage(error) }));
    this.bump();
  }

  /**
   * ACCT-PAIR-01 + INTG-PROF-01: one profile is followed without asking; several keep the approval in memory only
   * (no key file, no session, no library) until the owner picks one in the plugin's settings.
   */
  private async onPairingApproved(result: PairingResult): Promise<"approved" | "needs_profile"> {
    const profiles = await fetchProfiles(result.apiUrl, result.token);
    this.log("pairing approved: account profiles", { count: profiles.length, ids: profiles.map((entry) => entry.id) });
    if (profiles.length === 1) {
      await this.applyProfile(chosenProfileOf(profiles[0]), "single_profile");
      await this.commitPairing(result);
      return "approved";
    }
    // A key the library refuses fails the pairing now, not after the owner picked a profile.
    await this.verifyKeyProbe(result.token, result.libraryKeyBase64);
    this.profiles = profiles;
    this.pendingPairing = result;
    this.bump();
    return "needs_profile";
  }

  /** Stores the approved session and key, then opens the library. */
  private async commitPairing(result: PairingResult) {
    // The key goes to the private key file first; the session only counts once the library accepts that key.
    await this.writeLibraryKey(result.libraryKeyBase64);
    this.auth = { token: result.token, email: result.email, userId: result.userId, apiUrl: result.apiUrl };
    process.env.SF_API_BASE_URL = result.apiUrl;
    this.rejectedKey = null;
    this.lastError = null;
    await this.clearSignedOut();
    await this.saveAuth(this.auth);
    this.startTickets();
    await this.tick();
    if (this.rejectedKey) {
      const reason = this.lastError ?? "library_key_mismatch";
      await this.wipe("pairing_key_rejected");
      await this.clearSignedOut();
      throw new Error(reason);
    }
    this.bump();
  }

  // --- auth --------------------------------------------------------------

  private async performLogin(input: { email: string; password: string; twoFactorCode?: string | null; apiUrl?: string | null }) {
    const apiUrl = this.accountApiUrl(input.apiUrl);
    const res = await fetch(`${apiUrl}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-space-app": "badger" },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        clientType: this.config.clientType,
        deviceType: "jellyfin",
        deviceName: this.config.deviceName,
        ...(input.twoFactorCode ? { twoFactorCode: input.twoFactorCode } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; user?: { id?: string; email?: string }; error?: string };
    if (!res.ok || !body.token) {
      const error = new Error(body.error ?? `api_${res.status}`);
      Object.assign(error, { status: res.status, payload: body });
      throw error;
    }
    this.auth = { token: body.token, email: body.user?.email ?? input.email, userId: body.user?.id ?? null, apiUrl };
    process.env.SF_API_BASE_URL = apiUrl;
    await this.clearSignedOut();
    await this.saveAuth(this.auth);
    this.startTickets();
    this.log("signed in", { email: this.auth.email, clientType: this.config.clientType, tokenTail: this.auth.token.slice(-6) });
  }

  async login(input: { email: string; password: string; twoFactorCode?: string | null; apiUrl?: string | null }) {
    if (this.auth && !this.signedOutReason) {
      throw new Error("already_signed_in");
    }
    await this.performLogin(input);
    await this.tick();
    return this.status();
  }

  /** User-initiated sign-out: revoke this device, then wipe like a 401. */
  async signOut() {
    const auth = this.auth;
    if (auth) {
      await fetch(`${auth.apiUrl}/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "x-space-app": "badger" },
      }).catch((error) => this.log("logout request failed", { error: errorMessage(error) }));
    }
    await this.wipe("user_signout");
    await this.clearSignedOut();
  }

  // --- status / library --------------------------------------------------

  status(): IntegrationStatus {
    const db = this.db;
    const hasKey = Boolean(this.readLibraryKey());
    let state = "starting";
    if (this.starting) state = "starting";
    else if (this.pendingPairing) state = "needs_profile";
    else if (this.signedOutReason) state = "signed_out";
    else if (!this.auth) state = "needs_login";
    else if (!hasKey) state = "needs_key";
    else if (this.profileNeeded) state = "needs_profile";
    else if (db) state = "ok";
    else if (this.lastError) state = "error";
    return {
      state,
      signedIn: Boolean(this.auth),
      email: this.auth?.email ?? null,
      userId: this.auth?.userId ?? null,
      accessState: this.access.state,
      paidUntil: this.access.paidUntil,
      wipeAt: this.access.wipeAt,
      libraryVersion: db ? db.getVersion() : null,
      mediaCount: db ? db.listMedia().length : 0,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError ?? this.signedOutReason,
      apiUrl: this.apiUrl,
      version: this.config.version,
      pairing: this.pairing.snapshot(),
      signedOutReason: this.signedOutReason,
      keyRejected: this.rejectedKey !== null && this.rejectedKey === this.readLibraryKey(),
      profile: this.statusProfile(),
      profiles: this.profiles,
      profileNeeded: this.profileNeeded,
    };
  }

  private requireDb() {
    if (!this.db) throw Object.assign(new Error("library_not_ready"), { status: 503 });
    return this.db;
  }

  getLibrary(): IntegrationLibrary {
    const db = this.requireDb();
    const prefix = this.profile?.prefix ?? "";
    const key = `${db.getVersion()}:${this.localRevision}:${prefix}`;
    if (this.libraryCache?.key !== key) {
      const started = Date.now();
      const library = buildIntegrationLibrary(db, prefix, this.config.uiLanguage);
      this.libraryCache = { key, library };
      this.log("library model built", { key, movies: library.movies.length, shows: library.shows.length, ms: Date.now() - started });
    }
    return this.libraryCache.library;
  }

  // --- change notifications ---------------------------------------------

  private bump() {
    this.changeSeq += 1;
    this.wake();
  }

  private wake() {
    for (const waiter of [...this.waiters]) waiter();
  }

  async waitForChange(since: number, timeoutMs: number, signal: AbortSignal): Promise<number> {
    if (this.changeSeq !== since || timeoutMs <= 0 || signal.aborted) return this.changeSeq;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.waiters.add(resolve);
    const timer = setTimeout(resolve, timeoutMs);
    signal.addEventListener("abort", () => resolve(), { once: true });
    await promise;
    clearTimeout(timer);
    this.waiters.delete(resolve);
    return this.changeSeq;
  }

  currentVersion() {
    return this.changeSeq;
  }

  // --- storage -----------------------------------------------------------

  private async downloadObject(key: string, purpose: "playback" | "export" | "library", onChunk?: () => Promise<void> | void): Promise<Uint8Array<ArrayBuffer>> {
    const auth = this.auth;
    if (!auth) throw Object.assign(new Error("signed_out"), { status: 401 });
    try {
      return await this.tunnel.downloadObject(auth.token, key, {
        clientType: this.config.clientType,
        clientVersion: this.config.version,
        purpose,
        onChunk,
      });
    } catch (error) {
      if (isUnauthorizedError(error)) void this.refreshAccess();
      if (purpose === "playback") this.noteProfileRefusal(error);
      throw error;
    }
  }

  /**
   * META-ART-01/02: a picture for Jellyfin's library, from the user's vault only: the local decrypted cache first, then
   * the user's storage. A provider path (its copy is not made yet) or any other value is a placeholder (404): the
   * metadata service is never asked while the library is shown; the artwork copy fills the path in and the next sync
   * writes the picture.
   */
  async loadImage(ref: string, _kind: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const source = artworkDisplaySource(ref);
    const asset = ASSET_REF.exec(ref);
    if (source !== "vault" || (!asset && !ref.startsWith("assets/"))) {
      throw Object.assign(new Error(source === "pending" ? "image_pending" : "image_unavailable"), { status: 404 });
    }
    const name = crypto.createHash("sha256").update(ref).digest("hex");
    const file = path.join(this.imageCacheDir, name);
    try {
      const [bytes, contentType] = await Promise.all([fsp.readFile(file), fsp.readFile(`${file}.type`, "utf8")]);
      await this.noteImageShown(name, file);
      return { bytes, contentType };
    } catch {
      // cache miss
    }
    const key = this.libraryKey;
    if (!key) throw Object.assign(new Error("library_not_ready"), { status: 503 });
    const generation = this.imageCacheGeneration;
    // Posters of the user's own library: readable when unpaid, exempt at saturation (STOR-BW-09), like the desktop's.
    const encrypted = await this.downloadObject(asset ? asset[2]! : ref, "library");
    const bytes = decryptAssetObject(key, encrypted);
    const contentType = asset?.[1] || guessImageType(bytes);
    await this.cacheImage(generation, name, file, bytes, contentType);
    return { bytes, contentType };
  }

  private get imageCacheDir() {
    return path.join(this.config.stateDir, "image-cache");
  }

  /** A cache hit: stamps the picture as just shown, so the bound drops the least recently shown ones first. */
  private async noteImageShown(name: string, file: string) {
    const now = Date.now();
    await fsp.utimes(file, now / 1000, now / 1000).catch(() => undefined);
    const entry = this.imageCacheIndex?.get(name);
    if (entry) entry.shownAt = now;
  }

  /** The cache on disk, read once per start: each picture's size (with its `.type`) and when it was last shown. */
  private async loadImageCacheIndex(generation: number) {
    if (this.imageCacheIndex) return this.imageCacheIndex;
    const index = new Map<string, { size: number; shownAt: number }>();
    for (const entry of await fsp.readdir(this.imageCacheDir).catch(() => [] as string[])) {
      const stat = await fsp.stat(path.join(this.imageCacheDir, entry)).catch(() => null);
      if (!stat) continue;
      const name = entry.endsWith(".type") ? entry.slice(0, -".type".length) : entry;
      const item = index.get(name) ?? { size: 0, shownAt: 0 };
      item.size += stat.size;
      if (name === entry) item.shownAt = stat.mtimeMs;
      index.set(name, item);
    }
    if (generation === this.imageCacheGeneration) this.imageCacheIndex = index;
    return index;
  }

  /**
   * Writes a decrypted picture, then removes the least recently shown ones past `imageCacheBytes`
   * (HEADLESS_IMAGE_CACHE_MB). Writes run one at a time, so parallel `/image` misses share one index and the bound
   * holds; a write for a session signed out meanwhile (`generation`) is dropped.
   */
  private cacheImage(generation: number, name: string, file: string, bytes: Uint8Array, contentType: string) {
    const write = this.imageCacheWrites.then(() => this.writeCachedImage(generation, name, file, bytes, contentType));
    this.imageCacheWrites = write;
    return write;
  }

  private async writeCachedImage(generation: number, name: string, file: string, bytes: Uint8Array, contentType: string) {
    try {
      if (generation !== this.imageCacheGeneration) return;
      // Never recursive: a wiped state dir stays gone.
      await fsp.mkdir(this.imageCacheDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const index = await this.loadImageCacheIndex(generation);
      if (generation !== this.imageCacheGeneration) return;
      await Promise.all([fsp.writeFile(file, bytes, { mode: 0o600 }), fsp.writeFile(`${file}.type`, contentType, { mode: 0o600 })]);
      const now = Date.now();
      await fsp.utimes(file, now / 1000, now / 1000);
      index.set(name, { size: bytes.byteLength + Buffer.byteLength(contentType), shownAt: now });
      let total = 0;
      for (const item of index.values()) total += item.size;
      if (total <= this.config.imageCacheBytes) return;
      const before = total;
      let removed = 0;
      for (const [oldest, item] of [...index].sort((a, b) => a[1].shownAt - b[1].shownAt)) {
        if (total <= this.config.imageCacheBytes) break;
        if (oldest === name) continue;
        const oldFile = path.join(this.imageCacheDir, oldest);
        await Promise.all([fsp.rm(oldFile, { force: true }), fsp.rm(`${oldFile}.type`, { force: true })]);
        index.delete(oldest);
        total -= item.size;
        removed += 1;
      }
      this.log("image cache trimmed", { before, after: total, removed, limit: this.config.imageCacheBytes });
    } catch (error) {
      this.log("image cache write failed", { error: errorMessage(error) });
    }
  }

  /**
   * META-ART-01: copies every picture the library still holds as a provider path into the user's storage, one title
   * at a time (`ARTWORK_COPY_PAUSE_MS` between titles), keeping the ticket reserve above its floor. Runs at library
   * open (existing libraries migrate once) and after a sync brought changes (titles matched or refreshed elsewhere);
   * never on a display path. Returns how many titles were scheduled.
   */
  private async startArtworkCopies(reason: string): Promise<number> {
    const db = this.db;
    if (!db || this.stopped) return 0;
    this.artworkQueue ??= this.createArtworkQueue();
    try {
      const scheduled = await scheduleArtworkMigration({
        listMediaIds: () => db.listMedia().map((media) => media.id),
        hasArtworkToCopy: (mediaId) => db.listArtworkToCopy(mediaId).length > 0,
        queue: this.artworkQueue,
      });
      this.log("artwork copy scheduled", { reason, titles: scheduled });
      return scheduled;
    } catch (error) {
      this.log("artwork copy scheduling failed", { reason, error: errorMessage(error) });
      return 0;
    }
  }

  private createArtworkQueue(): ArtworkCopyQueue {
    const upload = createVaultArtworkUpload({
      fetchImage: (kind, ref) => this.fetchArtworkImage(kind, ref),
      storeEncrypted: (bytes, contentType) => this.storeArtwork(bytes, contentType),
      onError: (stage, error) => this.log("artwork copy step failed", { stage, error: errorMessage(error) }),
    });
    return createArtworkCopyQueue({
      pauseMs: ARTWORK_COPY_PAUSE_MS,
      run: async (mediaId, control) => {
        const db = this.db;
        if (!db) return;
        // A run outliving a sign-out (or a stop) spends no ticket and writes nothing into the closed library.
        const current = () => this.db === db;
        const result = await copyMediaArtwork({
          store: {
            listArtworkToCopy: (id) => db.listArtworkToCopy(id),
            applyArtworkCopies: (id, copies) => (current() ? db.applyArtworkCopies(id, copies) : { applied: 0, skipped: copies.length }),
          },
          mediaId,
          upload,
          canSpend: async () => current() && (await this.tickets.count()) > ARTWORK_COPY_TICKET_FLOOR,
          shouldYield: control.shouldYield,
        });
        // Counts and the title id only, never a path or a key.
        this.log("artwork copy done", { ...result });
        if (result.applied === 0 || !current()) return result;
        await this.flush("artwork");
        this.localRevision += 1;
        this.bump();
        return result;
      },
      onError: (mediaId, error) => this.log("artwork copy failed", { mediaId, error: errorMessage(error) }),
    });
  }

  /**
   * The copy's picture fetch (import and refresh only, never display): the metadata service's `image` op with one
   * anonymous ticket (META-RELAY-01, META-ART-02). A service that says "slow down" (429/503) or cannot be reached
   * pauses lookups (its Retry-After, else 60 s, or 30 s for a dropped connection) and answers `rate_limited` with
   * the time left: the shared copy waits it out and asks for the same picture again.
   */
  private async fetchArtworkImage(kind: ArtworkKind, ref: string): Promise<ArtworkFetchOutcome> {
    const pausedFor = this.metadataPausedUntil - Date.now();
    if (pausedFor > 0) return { status: "rate_limited", retryAfterMs: pausedFor };
    let url: string | null;
    try {
      ({ url } = await this.metadata.imageUrl(kind, ref));
    } catch (error) {
      if (error instanceof NoTicketError) return { status: "no_ticket" };
      if (error instanceof TicketRejectedError || error instanceof MetadataRequestError) {
        this.log("artwork lookup failed", { kind, error: errorMessage(error) });
        return { status: "unavailable" };
      }
      const unavailable = error instanceof MetadataUnavailableError;
      const retryAfterMs = this.pauseMetadata(
        unavailable ? (error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : METADATA_PAUSE_DEFAULT_MS) : METADATA_PAUSE_NETWORK_MS
      );
      this.log("artwork lookup paused", { kind, status: unavailable ? error.status : "unreachable", retryAfterMs });
      return { status: "rate_limited", retryAfterMs };
    }
    if (!url) return { status: "missing" };
    let image: Response;
    try {
      image = await fetch(url);
    } catch (error) {
      this.log("artwork download failed", { kind, error: errorMessage(error) });
      return { status: "unavailable" };
    }
    if (!image.ok) return { status: image.status === 404 ? "missing" : "unavailable" };
    const bytes = new Uint8Array(await image.arrayBuffer());
    return { status: "ok", bytes, contentType: image.headers.get("content-type")?.split(";")[0] || guessImageType(bytes) };
  }

  /** Same object as the desktop's `uploadEncryptedAssetBytes`: base64 text of a library envelope under `assets/<uuid>.txt`. */
  private async storeArtwork(bytes: Uint8Array, contentType: string) {
    const auth = this.auth;
    const key = this.libraryKey;
    if (!auth || !key) throw new Error("library_not_ready");
    const payload = new TextEncoder().encode(encryptLibraryEnvelope(key, Buffer.from(bytes)).toString("base64"));
    const objectKey = newArtworkObjectKey(crypto.randomUUID());
    const persisted = await this.tunnel.uploadObject(auth.token, objectKey, payload, {
      clientType: this.config.clientType,
      clientVersion: this.config.version,
      objectNamespace: "library",
      logicalRef: objectKey,
    });
    return buildArtworkAssetRef(persisted, contentType);
  }

  /** Pauses lookups for `ms` (the service's own Retry-After is kept as is, up to an hour); answers the pause. */
  private pauseMetadata(ms: number) {
    const pause = Math.min(Math.max(ms, 1), METADATA_PAUSE_MAX_MS);
    this.metadataPausedUntil = Date.now() + pause;
    return pause;
  }

  /**
   * LIB-LANG-02: schedules every title whose synopsis or episode texts in Jellyfin's interface language (and English
   * where that language lacks some) no library row keeps yet. Runs at library open, after a sync brought changes (new
   * titles, new episodes) and after a ticket refill; never on a display path. Returns how many titles were scheduled.
   */
  private startTexts(reason: string): number {
    const db = this.db;
    if (!db || this.stopped) return 0;
    this.textsQueue ??= this.createTextsQueue();
    const language = this.config.uiLanguage;
    let scheduled = 0;
    try {
      for (const media of db.listMedia()) {
        if (!media.tmdbId || (media.type !== "movie" && media.type !== "tv")) continue;
        const episodeKeys = media.type === "tv" ? episodeKeysOf(db.getMediaDetails(media.id)?.episodes ?? []) : [];
        if (!needsTexts(db, media.type, media.tmdbId, language, episodeKeys)) continue;
        this.textsQueue.schedule(media.id, { background: true });
        scheduled += 1;
      }
    } catch (error) {
      this.log("texts scheduling failed", { reason, error: errorMessage(error) });
    }
    // Counts and the language only, never a title.
    this.log("texts scheduled", { reason, language, titles: scheduled });
    return scheduled;
  }

  private createTextsQueue(): ArtworkCopyQueue {
    const db = this.db;
    const current = () => db !== null && this.db === db && !this.stopped;
    let written = 0;
    // One adapter per library: the shared texts keep this session's rows per open library.
    const library = db
      ? {
          read: async (key: string) => db.getSetting(key)?.value ?? null,
          write: async (key: string, value: string) => {
            // A run outliving a sign-out (or a stop) writes nothing into the closed library.
            if (!current()) return;
            db.setSetting(key, value);
            written += 1;
          },
        }
      : null;
    const details = pacedDetails({
      details: (type, id, language) => this.metadata.details(type, id, language),
      countTickets: () => this.tickets.count(),
      pausedForMs: () => this.metadataPausedUntil - Date.now(),
      alive: current,
      onFailure: (error) => {
        if (error instanceof NoTicketError || error instanceof TicketRejectedError || error instanceof MetadataRequestError) return false;
        const unavailable = error instanceof MetadataUnavailableError;
        const retryAfterMs = this.pauseMetadata(
          unavailable ? (error.retryAfterSeconds !== undefined ? error.retryAfterSeconds * 1000 : METADATA_PAUSE_DEFAULT_MS) : METADATA_PAUSE_NETWORK_MS
        );
        this.log("texts lookup paused", { status: unavailable ? error.status : "unreachable", retryAfterMs });
        return true;
      },
    });
    // One shared texts per title run: an answer of an earlier run never stands for an episode a later sync brought
    // (the shared texts treat a lacking episode of an answer under a minute old as absent upstream).
    const textsOfRun = () =>
      createDetailsTexts({
        // A failed lookup with an older row kept answers that row and throws nothing: say why nothing was asked.
        details: async (type, tmdbId, language) => {
          try {
            return await details(type, tmdbId, language);
          } catch (error) {
            // The language and the reason only, never a title.
            this.log("texts lookup not sent or failed", {
              language,
              held: error instanceof TextsHeldError,
              error: errorMessage(error),
            });
            throw error;
          }
        },
        library: () => (current() ? library : null),
        onError: (stage, error) => this.log("texts row step failed", { stage, error: errorMessage(error) }),
      });
    return createArtworkCopyQueue({
      pauseMs: ARTWORK_COPY_PAUSE_MS,
      run: async (mediaId) => {
        const media = current() ? db?.getMediaDetails(mediaId) : null;
        if (!media?.tmdbId || (media.type !== "movie" && media.type !== "tv")) return;
        const episodeKeys = media.type === "tv" ? episodeKeysOf(media.episodes) : [];
        const before = written;
        try {
          await askTexts(textsOfRun(), media.type, media.tmdbId, this.config.uiLanguage, episodeKeys);
        } finally {
          // Counts and the title id only, never a text.
          this.log("texts done", { mediaId, written: written - before });
          if (written > before && current()) {
            await this.flush("texts");
            this.localRevision += 1;
            this.bump();
          }
        }
      },
      onError: (mediaId, error) => this.log("texts failed", { mediaId, held: error instanceof TextsHeldError, error: errorMessage(error) }),
    });
  }

  // --- writes ------------------------------------------------------------

  private async flush(label: string) {
    try {
      await this.db?.flushPending();
    } catch (error) {
      this.log("flush pending ops failed", { label, error: errorMessage(error) });
    }
  }

  buildDeps(): IntegrationDeps {
    // ACCT-STREAM-01..04: this server's one place for the followed profile, with the device's own session token.
    const streams = new JellyfinStreamSlots({
      client: createStreamSlotsClient({ baseUrl: () => this.apiUrl, getToken: () => this.auth?.token ?? null }),
      getProfileId: () => this.followedProfileId,
      log: this.log,
    });
    return {
      getStatus: () => this.status(),
      isLibraryReady: () => this.db !== null,
      isStarting: () => this.starting,
      getLibrary: () => this.getLibrary(),
      getDetails: (mediaId) => this.requireDb().getMediaDetails(mediaId),
      objectStore: this.objectStore,
      loadImage: (ref, kind) => this.loadImage(ref, kind),
      // INTG-PROF-01: every viewing read / write goes through the followed profile's key prefix.
      recordProgress: async ({ mediaId, episodeId, write }) => {
        this.requireFollowedProfile();
        const db = this.requireDb();
        const prefix = this.profile?.prefix ?? "";
        await writeProgress(
          db,
          prefix,
          write.kind === "clear"
            ? { mediaId, episodeId, progressPct: 0 }
            : { mediaId, episodeId, progressPct: write.progressPct, positionSeconds: write.positionSeconds, durationSeconds: write.durationSeconds }
        );
        this.localRevision += 1;
        this.log("progress recorded", { mediaId, episodeId, kind: write.kind, progressPct: write.progressPct, profileId: this.profile?.id ?? null, isMain: prefix === "" });
        await this.flush("progress");
      },
      getTrackPrefs: (mediaId) => trackPrefsView(readTrackPrefs(this.requireDb(), this.profile?.prefix ?? "", mediaId)),
      setTrackPrefs: async (mediaId, patch) => {
        this.requireFollowedProfile();
        const db = this.requireDb();
        const prefix = this.profile?.prefix ?? "";
        const before = readTrackPrefs(db, prefix, mediaId);
        const after = mergeTrackPrefs(before, patch, new Date().toISOString());
        // Same choice again (a client re-reporting what is already remembered): no new op.
        if (before && before.audioLanguage === after.audioLanguage && JSON.stringify(before.subtitle) === JSON.stringify(after.subtitle)) {
          return trackPrefsView(before);
        }
        await writeTrackPrefs(db, prefix, mediaId, patch);
        this.localRevision += 1;
        const saved = readTrackPrefs(db, prefix, mediaId);
        this.log("track preferences set", {
          mediaId,
          patch,
          audioLanguage: saved?.audioLanguage ?? null,
          subtitle: saved?.subtitle ?? null,
          profileId: this.profile?.id ?? null,
          isMain: prefix === "",
        });
        await this.flush("tracks");
        return trackPrefsView(saved);
      },
      deleteMedia: async (mediaId) => {
        const db = this.requireDb();
        const result = await db.deleteMedia(mediaId);
        this.localRevision += 1;
        this.log("media deleted", { mediaId, ...result });
        await this.flush("delete");
        this.bump();
        return result;
      },
      deleteEpisode: async (mediaId, episodeId) => {
        const db = this.requireDb();
        const result = await db.deleteEpisode(mediaId, episodeId);
        this.localRevision += 1;
        this.log("episode deleted", { mediaId, episodeId, ...result });
        await this.flush("delete");
        this.bump();
        return result;
      },
      currentVersion: () => this.currentVersion(),
      waitForChange: (since, timeoutMs, signal) => this.waitForChange(since, timeoutMs, signal),
      login: (input) => this.login(input),
      startPairing: (input) => this.startPairing(input),
      cancelPairing: () => this.cancelPairing(),
      signOut: () => this.signOut(),
      chooseProfile: (profileId) => this.chooseProfile(profileId),
      listProfiles: () => this.listProfiles(),
      streams,
      log: this.log,
    };
  }
}
