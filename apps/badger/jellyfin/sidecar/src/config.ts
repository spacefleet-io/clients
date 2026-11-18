import os from "node:os";
import path from "node:path";
import { resolveMetadataUrl } from "@space/metadata-client";
import { uiLanguageOf } from "./localizedTexts";

/**
 * Environment of the integration sidecar (INTG-JF-04).
 *
 * The HTTP service ALWAYS binds 127.0.0.1 (INTG-JF-03): there is no host setting on purpose.
 */
export type IntegrationConfig = {
  port: number;
  host: "127.0.0.1";
  /**
   * The account API (ACCT-AUTH-09): HEADLESS_API_URL on a dev run (`devTicketKey`) only; any other run talks to the
   * production API whatever HEADLESS_API_URL says, because it trusts the production ticket key only.
   */
  apiUrl: string;
  /**
   * Explicit metadata service base URL for title lookups with anonymous tickets (META-RELAY-01), validated: HEADLESS_METADATA_URL,
   * then METADATA_URL, else null. Without one, lookups go to the metadata service of the API the tickets come from
   * (META-ANON-08): production for the production API, that stack's own service for a dev run's API (`runtime.ts`).
   */
  metadataUrlOverride: string | null;
  /**
   * Also trust the committed DEVELOPMENT ticket key, besides the production one (META-ANON-06, META-ANON-07): true only when
   * HEADLESS_DEV_TICKET_KEY is exactly `1`, an explicit opt-in for running against a dev stack. Never inferred from a
   * URL (a real server talks to LAN and loopback hosts too); the plugin does not set it, so a release pins production.
   * The same switch decides whether the account-server setting counts (ACCT-AUTH-09, {@link IntegrationConfig.apiUrl}).
   */
  devTicketKey: boolean;
  /**
   * Pre-obtained device session token (skips the login). It must be a session of this device, like the login
   * and pairing ones: ticket issuance (META-ANON-02) refuses personal tokens.
   */
  apiToken: string | null;
  email: string | null;
  password: string | null;
  twoFactorCode: string | null;
  clientType: string;
  libraryKeyBase64: string | null;
  /** 0600 file holding the library key (PRIV-KEY-04). Wiped on sign-out (PRIV-KEY-05). */
  libraryKeyFile: string | null;
  stateDir: string;
  syncIntervalMs: number;
  /** HEADLESS_OBJECT_CACHE_MB when set, else {@link defaultObjectCacheBytes} of this host's RAM. */
  objectCacheBytes: number;
  /**
   * Decrypted artwork kept on disk (state dir `image-cache`, META-ART-01): HEADLESS_IMAGE_CACHE_MB, else 256 MiB. Kept
   * across restarts, removed with the state dir on sign-out; past the bound the least recently shown pictures go.
   */
  imageCacheBytes: number;
  /** HEADLESS_PREFETCH_COUNT when set, else {@link defaultPrefetchPlan} of this host. */
  prefetchCount: number;
  /** Prefetches downloading at once, from {@link defaultPrefetchPlan}, never more than prefetchCount. */
  prefetchParallel: number;
  version: string;
  /** Shown in the phone approval prompt and the device list (ACCT-PAIR-01, ACCT-DEV-01). */
  deviceName: string;
  /**
   * Jellyfin's interface language (HEADLESS_UI_LANGUAGE, set by the plugin from the server's UI culture), reduced to
   * its language subtag; English when unset. Synopses and episode texts are shown in it (LIB-LANG-01).
   */
  uiLanguage: string;
};

const positiveInt = (raw: string | undefined, fallback: number) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const trimmed = (raw: string | undefined) => {
  const value = raw?.trim();
  return value ? value : null;
};

/** HEADLESS_METADATA_URL, then METADATA_URL, normalised and checked at startup (throws on a non-http(s) value), else null. */
const explicitMetadataUrl = (env: Record<string, string | undefined>): string | null => {
  const chosen = trimmed(env.HEADLESS_METADATA_URL) ?? trimmed(env.METADATA_URL);
  return chosen ? resolveMetadataUrl({ override: chosen }) : null;
};

const MIB = 1024 * 1024;

/**
 * Decrypted-segment cache size when HEADLESS_OBJECT_CACHE_MB is unset: 1/16 of RAM, kept within 64..256 MiB (#934).
 * A fixed 256 MiB was a large share of a 2–4 GB NAS that also runs Jellyfin and its transcoder; 64 MiB still holds
 * the playing segment plus the prefetched ones.
 */
export const defaultObjectCacheBytes = (totalMemBytes: number) =>
  Math.min(256 * MIB, Math.max(64 * MIB, Math.floor(totalMemBytes / 16 / MIB) * MIB));

const GIB = 1024 * MIB;

/**
 * How far ahead the sidecar fetches segments, from this host's cores and RAM (INTG-JF-06, #955). The low-end target is a
 * 4-core box with 8 GB (PERF-HOST-01): it fetches 2 segments ahead, one at a time, so the segment the player waits for
 * shares the link and the processor with at most one prefetch. A weaker box (2 cores or under 6 GB, a small NAS) fetches
 * one ahead; anything stronger keeps the former 3 ahead, 2 at a time.
 */
export const defaultPrefetchPlan = (cpuCount: number, totalMemBytes: number) => {
  if (cpuCount <= 2 || totalMemBytes < 6 * GIB) return { count: 1, parallel: 1 };
  if (cpuCount <= 4 || totalMemBytes < 12 * GIB) return { count: 2, parallel: 1 };
  return { count: 3, parallel: 2 };
};

/** The account API every run outside dev mode talks to (ACCT-AUTH-09). */
export const PRODUCTION_API_URL = "https://api.spacefleet.io";

export const loadIntegrationConfig = (
  env: Record<string, string | undefined>,
  cwd = process.cwd(),
  totalMemBytes = os.totalmem(),
  cpuCount = os.availableParallelism()
): IntegrationConfig => {
  const plan = defaultPrefetchPlan(cpuCount, totalMemBytes);
  const prefetchCount = env.HEADLESS_PREFETCH_COUNT === undefined ? plan.count : Math.max(0, Number(env.HEADLESS_PREFETCH_COUNT) || 0);
  return {
    port: positiveInt(env.HEADLESS_INTEGRATION_PORT, 8790),
    host: "127.0.0.1",
    apiUrl: ((env.HEADLESS_DEV_TICKET_KEY?.trim() === "1" ? trimmed(env.HEADLESS_API_URL) : null) ?? PRODUCTION_API_URL).replace(/\/+$/, ""),
    metadataUrlOverride: explicitMetadataUrl(env),
    devTicketKey: env.HEADLESS_DEV_TICKET_KEY?.trim() === "1",
    apiToken: trimmed(env.HEADLESS_API_TOKEN),
    email: trimmed(env.HEADLESS_EMAIL),
    password: env.HEADLESS_PASSWORD && env.HEADLESS_PASSWORD.length > 0 ? env.HEADLESS_PASSWORD : null,
    twoFactorCode: trimmed(env.HEADLESS_TWO_FACTOR_CODE),
    clientType: trimmed(env.HEADLESS_CLIENT_TYPE) ?? "badger-jellyfin",
    libraryKeyBase64: trimmed(env.HEADLESS_LIBRARY_KEY_BASE64),
    libraryKeyFile: trimmed(env.HEADLESS_LIBRARY_KEY_FILE),
    stateDir: path.resolve(trimmed(env.HEADLESS_STATE_DIR) ?? path.join(cwd, ".headless", "integration-state")),
    syncIntervalMs: positiveInt(env.HEADLESS_SYNC_INTERVAL_MS, 15_000),
    objectCacheBytes: positiveInt(env.HEADLESS_OBJECT_CACHE_MB, 0) * MIB || defaultObjectCacheBytes(totalMemBytes),
    imageCacheBytes: positiveInt(env.HEADLESS_IMAGE_CACHE_MB, 256) * MIB,
    prefetchCount,
    prefetchParallel: Math.max(1, Math.min(plan.parallel, prefetchCount)),
    version: trimmed(env.HEADLESS_VERSION) ?? "0.1.0",
    deviceName: trimmed(env.HEADLESS_DEVICE_NAME) ?? "Jellyfin server",
    uiLanguage: uiLanguageOf(env.HEADLESS_UI_LANGUAGE),
  };
};
