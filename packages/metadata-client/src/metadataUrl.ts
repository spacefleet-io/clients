// Where an app sends lookups (META-ANON-08): an explicit value wins, then the metadata service of the API that issues
// the app's tickets. Never the build flavour: a dev-key build signed in to a dev stack must not send that stack's
// tickets to production, and a dev build signed in to production must not send production tickets to localhost.

export type MetadataUrlEnv = {
  /** A user or app setting; wins over everything. */
  override?: string | null;
  /** Generic runtime env (Node, Bun, the Jellyfin sidecar). */
  METADATA_URL?: string;
  /** Vite renderer env (desktop). */
  VITE_METADATA_URL?: string;
  /** Expo env (mobile, TV). */
  EXPO_PUBLIC_METADATA_URL?: string;
  /** The API the app's tickets come from; without an explicit value the URL is that API's metadata service. */
  apiBaseUrl?: string | null;
  /** `false` (a dev build with tickets off, `metadataTicketsForBuild`): an explicit value is required. */
  tickets?: boolean;
};

/**
 * Production default: the public name of the metadata service, reached through the Cloudflare tunnel from the Play
 * closed test on (REL-CD-09).
 */
export const DEFAULT_METADATA_URL = "https://metadata.spacefleet.io";

/** Dev: the local metadata service's port. */
export const DEV_METADATA_URL = "http://localhost:3002";

/**
 * Whether lookups carry anonymous tickets (META-ANON-06, Chris 2026-11-11): always in a release build, whatever the
 * flag; in a dev build (vite/electron-vite dev, Metro `__DEV__`) only when the build-time flag (`VITE_METADATA_TICKETS`;
 * `SF_METADATA_TICKETS` on Badger phones, `PARROT_METADATA_TICKETS` on Parrot phones) is `on`, which a dev stack
 * running its own metadata-api (`SF_LOCAL_METADATA=1`) sets. Read at build time only: no setting or screen changes it.
 */
export const metadataTicketsForBuild = (build: { devBuild: boolean; flag?: string | null }): boolean =>
  !build.devBuild || build.flag?.trim().toLowerCase() === "on";

/** Host name of the production API (REL-CD-09, REL-CD-15). */
const PRODUCTION_API_HOST = "api.spacefleet.io";

/** Every dev-stack profile and lane runs its metadata service two ports above its API (3000/3002, 3100/3102, lanes). */
const METADATA_PORT_OFFSET = 2;

/** Metadata port of a dev stack reached without an explicit API port (`DEV_METADATA_URL`). */
const DEV_METADATA_PORT = 3002;

// Regex rather than `URL`: React Native's URL polyfill does not implement `hostname` or `port`.
const API_URL_PATTERN = /^(https?):\/\/(\[[^\]\s]+\]|[^/:?#\s]+)(?::(\d{1,5}))?(?:[/?#]|$)/iu;

/**
 * The metadata service of the API at `apiBaseUrl`, without a trailing slash:
 * - the production API (or none, or a value that is not an http(s) URL): the production service;
 * - an API with an explicit port (a dev stack on loopback, the LAN, a lane): same host, two ports up;
 * - an `api.<domain>` host without a port: `metadata.<domain>`, beside it, as production names them;
 * - any other host: the dev stack's metadata port on that host.
 */
export const metadataUrlForApi = (apiBaseUrl: string | null | undefined): string => {
  const match = API_URL_PATTERN.exec(apiBaseUrl?.trim() ?? "");
  if (!match) return DEFAULT_METADATA_URL;
  const scheme = match[1].toLowerCase();
  const host = match[2].toLowerCase();
  if (host === PRODUCTION_API_HOST) return DEFAULT_METADATA_URL;
  if (match[3]) return `${scheme}://${host}:${Number(match[3]) + METADATA_PORT_OFFSET}`;
  if (host.startsWith("api.")) return `${scheme}://metadata.${host.slice("api.".length)}`;
  return `${scheme}://${host}:${DEV_METADATA_PORT}`;
};

/**
 * Returns the metadata service base URL without a trailing slash; throws on a value that is not http(s), and on a dev
 * build with tickets off that names no metadata service (META-ANON-06: the service it reaches is the developer's choice).
 */
export function resolveMetadataUrl(env: MetadataUrlEnv = {}): string {
  const chosen = [env.override, env.METADATA_URL, env.VITE_METADATA_URL, env.EXPO_PUBLIC_METADATA_URL]
    .map((value) => value?.trim())
    .find((value) => value);
  if (!chosen && env.tickets === false)
    throw new Error(
      "metadata-client: a dev build with tickets off needs METADATA_URL (server), VITE_METADATA_URL (desktop, web) or EXPO_PUBLIC_METADATA_URL (phones) set to a metadata service URL, or its tickets flag (VITE_METADATA_TICKETS, SF_METADATA_TICKETS for Badger phones, PARROT_METADATA_TICKETS for Parrot phones) set to on",
    );
  const url = chosen ?? metadataUrlForApi(env.apiBaseUrl);
  if (!/^https?:\/\/[^\s/]+/iu.test(url)) throw new Error("metadata-client: the metadata URL must start with http:// or https://");
  return url.replace(/\/+$/u, "");
}
