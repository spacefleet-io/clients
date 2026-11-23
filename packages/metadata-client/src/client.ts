// Direct lookup client: one anonymous ticket per request, straight to the metadata service. A lookup carries
// `Authorization: PrivateToken ...` and `Content-Type`, plus the one neutral `User-Agent` every app sends where its
// fetch honours it (META-ANON-14), and no credentials, so the service can learn nothing about who asked
// (META-RELAY-01, META-RELAY-02). Nothing here logs.

import { privateTokenAuthorization } from "@space/privacy-pass";
import type {
  MetadataSkipMarkersResult,
  MusicAlbum,
  MusicAlbumsQuery,
  MusicCopyChanges,
  MusicArtistImage,
  MusicCoverSize,
  MusicImage,
  MusicLyrics,
  MusicLyricsQuery,
  MusicRecording,
  MusicRecordingsQuery,
  MusicSuggestion,
  MusicSuggestQuery,
  SubtitleFileResult,
  SubtitlesRequest,
  SubtitlesResult,
  TitleDetails,
  TitleSearchResult,
  TitleType,
  Trailer,
} from "@space/shared/api";
import { parseRetryAfterSeconds } from "@space/shared/retryAfter";
import type { TicketShortage } from "./reserve";
import type { FetchLike, FetchResponse } from "./types";

/**
 * The reserve holds no ticket and no refill is running that could bring one (or the one running ended without
 * tickets). The client never starts a refill (META-ANON-02): callers show "unavailable" and look up again when the
 * reserve reports new tickets (`TicketReserve.onTickets`). `shortage` says why the last refill failed when the reserve
 * knows (META-ANON-15): `rate_limited` with `retryAfterSeconds` is the account's hourly ticket ceiling (META-PUB-02).
 */
export class NoTicketError extends Error {
  readonly shortage: TicketShortage | null;
  constructor(shortage: TicketShortage | null = null) {
    super(shortage ? `no anonymous ticket available (last refill: ${shortage.status})` : "no anonymous ticket available");
    this.name = "NoTicketError";
    this.shortage = shortage;
  }
}

/** The service is rate limiting this connection (429) or temporarily down (503). */
export class MetadataUnavailableError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | undefined;
  /** The service's `error` code (`rate_limited`, `ticket_store_unavailable`, `upstream_capacity`), when the answer carried a readable one. */
  readonly code: string | undefined;
  constructor(status: number, retryAfterSeconds: number | undefined, code?: string) {
    super(`metadata service unavailable (${status})`);
    this.name = "MetadataUnavailableError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.code = code;
  }
}

/** Every ticket tried was refused with 401 (invalid or already spent); the retry budget is used up. */
export class TicketRejectedError extends Error {
  constructor() {
    super("metadata service refused the tickets");
    this.name = "TicketRejectedError";
  }
}

/** Any other non-success answer (bad request, unknown op, upstream failure). */
export class MetadataRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`metadata request failed (${status})`);
    this.name = "MetadataRequestError";
    this.status = status;
  }
}

/**
 * LIB-SHOW-05: the service answered 410 `deleted`: the title no longer exists. `item` is the last details the service
 * had, absent when it had none. Not an outage: callers offer the removal to the user.
 */
export class MediaDeletedError extends Error {
  readonly item: TitleDetails | undefined;
  constructor(item: TitleDetails | undefined) {
    super("media deleted from the catalog");
    this.name = "MediaDeletedError";
    this.item = item;
  }
}

/** What the client needs from the reserve: `take()`, and `put()` to give back a ticket the service did not spend. It never asks for a refill. */
export interface TicketSource {
  take(): Promise<string | null>;
  /** Preferred over `take()` when present: waits for a refill that is already running when the reserve is empty. */
  takeWhenReady?(): Promise<string | null>;
  /** Puts a ticket that was not spent back (META-ANON-05). Optional: without it such a ticket is simply lost. Must not reject. */
  put?(ticket: string): Promise<void>;
  /** Why the last refill failed (META-ANON-15), carried by the `NoTicketError` of an empty reserve. Optional. */
  shortage?(): TicketShortage | null;
}

export interface MetadataClientConfig {
  reserve: TicketSource;
  fetch: FetchLike;
  /** Metadata service base URL (see `resolveMetadataUrl`), read at every request. */
  metadataUrl: () => string;
  /** Clock in ms for HTTP-date Retry-After. Default Date.now. */
  now?: () => number;
  /**
   * `false`: lookups go without a ticket and the reserve is never touched (a dev build, `metadataTicketsForBuild`,
   * META-ANON-06). Default true.
   */
  tickets?: boolean;
  /**
   * META-ANON-14: sent as `User-Agent` on every lookup (`NEUTRAL_USER_AGENT`). Only for a host whose fetch honours
   * it (Node, Bun, React Native); a browser page leaves it out (the service's CORS allows only the two headers above).
   */
  userAgent?: string;
}

/** META-ANON-14: the one User-Agent of every app's lookups, the same the Kodi add-on sends. */
export const NEUTRAL_USER_AGENT = "Mozilla/5.0";

export type ImageKind = "poster" | "backdrop" | "profile" | "still";

export type LookupBody = Record<string, unknown> & {
  op:
    | "search"
    | "details"
    | "videos"
    | "image"
    | "skipMarkers"
    | "musicRecordings"
    | "musicAlbums"
    | "musicSuggest"
    | "musicCopyChanges"
    | "musicLyrics"
    | "musicCover"
    | "musicArtistImage"
    | "subtitles"
    | "subtitleFile";
};

/** One movie, or one episode of a show. `durationSeconds` (the file's length) only closes an end-of-file credits time. */
export type SkipMarkersRequest =
  | { type: "movie"; id: number; durationSeconds?: number }
  | { type: "tv"; id: number; season: number; episode: number; durationSeconds?: number };

/**
 * The two refusals the service sends before it has taken the ticket (META-ANON-05): 429 `rate_limited` (the per-connection
 * limit, answered before the ticket is read) and 503 `ticket_store_unavailable` (the nonce could not be recorded, the
 * ticket "stays unspent for a retry"). A 503 `upstream_capacity` comes after the ticket was spent, so it is not listed.
 */
const UNSPENT_REFUSALS: ReadonlyMap<number, string> = new Map([
  [429, "rate_limited"],
  [503, "ticket_store_unavailable"],
]);

/** The `error` code of a refusal's JSON body, or undefined when there is none or it cannot be read. */
async function refusalCode(response: FetchResponse): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { error?: unknown } | null;
    return typeof body?.error === "string" ? body.error : undefined;
  } catch {
    return undefined;
  }
}

/** The body of a 410 `deleted` answer (LIB-SHOW-05), or null for any other or unreadable 410. */
async function deletedBody(response: FetchResponse): Promise<{ item: TitleDetails | undefined } | null> {
  try {
    const body = (await response.json()) as { error?: unknown; item?: TitleDetails } | null;
    return body?.error === "deleted" ? { item: body.item ?? undefined } : null;
  } catch {
    return null;
  }
}

/**
 * META-SRC-09: the ops that ask for the neutral lookup contract 2 (`contract: 2` in the body). The service answers
 * them without naming where its data comes from.
 */
const CONTRACT_2_OPS: Partial<Record<LookupBody["op"], true>> = {
  search: true,
  details: true,
  videos: true,
  image: true,
  skipMarkers: true,
  subtitles: true,
  subtitleFile: true,
};

/** One ticket is spent per attempt; a 401 drops it and the next ticket is tried, at most this many more times. */
export const MAX_TICKET_RETRIES = 2;

export interface MetadataClient {
  /** POST /lookup with one ticket. Throws NoTicketError, MetadataUnavailableError, TicketRejectedError, MediaDeletedError, MetadataRequestError, or the transport's own error. */
  lookup<T = unknown>(body: LookupBody): Promise<T>;
  search(type: TitleType, query: string, page?: number): Promise<{ results: TitleSearchResult[]; page: number; totalPages: number }>;
  details(type: TitleType, id: number, language?: string): Promise<{ item: TitleDetails }>;
  videos(type: TitleType, id: number, language: string): Promise<{ trailers: Trailer[] }>;
  imageUrl(kind: ImageKind, path: string, language?: string): Promise<{ url: string | null }>;
  /** Intro and credits times through the metadata service (META-SKIP-01): apps never ask a source themselves. */
  skipMarkers(request: SkipMarkersRequest): Promise<MetadataSkipMarkersResult>;
  /**
   * Parrot's music lookups through the metadata service, in lookup contract 2 (META-SRC-09): every music id is one
   * opaque `id` sent back as is. Not configured on the service: `MetadataRequestError` 501. Busy:
   * `MetadataUnavailableError` 503.
   */
  musicRecordings(query: MusicRecordingsQuery): Promise<{ results: MusicRecording[] }>;
  musicAlbums(query: MusicAlbumsQuery): Promise<{ results: MusicAlbum[] }>;
  /** PAR-COPY-01: the albums each music copy newer than `since` changed (null: only the current copy's version), one list for every app. */
  musicCopyChanges(since?: string | null): Promise<MusicCopyChanges>;
  /** PAR-META-18: the edit dialog's autocomplete, best fit first; build the query with parrot-core `parrotMusicSuggestQuery`. */
  musicSuggest(query: MusicSuggestQuery): Promise<{ results: MusicSuggestion[] }>;
  /** Lyrics past the user's own file (PAR-LYR-01). */
  musicLyrics(query: MusicLyricsQuery): Promise<MusicLyrics>;
  /** One album cover by the album's `id`, `size` 500 (default) or 1200 px; `cover: null` when the service has none. */
  musicCover(album: string, size?: MusicCoverSize): Promise<{ cover: MusicImage | null }>;
  /** One artist's photo by the artist's `id` (PAR-META-15); `credit` is set when its licence asks for one, `image: null` when the service has none. */
  musicArtistImage(artist: string): Promise<{ image: MusicArtistImage | null }>;
  /**
   * Every subtitle the subtitle provider has for one movie or episode, through the metadata service (PLAY-SUBGET-09):
   * apps never call the provider. `reachable: false` means only `ready` files are listed (PLAY-SUBGET-11).
   */
  subtitles(request: SubtitlesRequest): Promise<SubtitlesResult>;
  /** One listed file's text. Not `ready` and the provider out of reach: `MetadataUnavailableError` code `subtitles_unavailable`. */
  subtitleFile(fileId: number): Promise<SubtitleFileResult>;
}

export function createMetadataClient(config: MetadataClientConfig): MetadataClient {
  const now = config.now ?? Date.now;

  const lookup = async <T>(body: LookupBody): Promise<T> => {
    const payload = JSON.stringify(CONTRACT_2_OPS[body.op] ? { ...body, contract: 2 } : body);
    for (let attempt = 0; attempt <= MAX_TICKET_RETRIES; attempt += 1) {
      // The ticket is already gone from the store when it resolves: a crash from here on can never reuse it. An empty
      // reserve right after sign-in waits for the running refill's first batch rather than failing the lookup.
      const ticket = config.tickets === false ? null : await (config.reserve.takeWhenReady?.() ?? config.reserve.take());
      if (ticket === null && config.tickets !== false) throw new NoTicketError(config.reserve.shortage?.() ?? null);
      const response = await config.fetch(`${config.metadataUrl()}/lookup`, {
        method: "POST",
        headers: {
          ...(ticket === null ? {} : { Authorization: privateTokenAuthorization(ticket) }),
          "Content-Type": "application/json",
          ...(config.userAgent ? { "User-Agent": config.userAgent } : {}),
        },
        body: payload,
        credentials: "omit",
      });
      if (response.status === 401 && ticket !== null) continue;
      if (response.status === 429 || response.status === 503) {
        const code = await refusalCode(response);
        // Unknown or unreadable means spent: a spent ticket put back would only be refused later.
        if (code !== undefined && code === UNSPENT_REFUSALS.get(response.status)) {
          try {
            if (ticket !== null) await config.reserve.put?.(ticket);
          } catch {
            // The ticket is lost, as it was before this rule; the answer below is what the caller needs to see.
          }
        }
        throw new MetadataUnavailableError(response.status, parseRetryAfterSeconds(response.headers.get("retry-after"), now()), code);
      }
      if (response.status === 410) {
        const body = await deletedBody(response);
        if (body) throw new MediaDeletedError(body.item);
      }
      if (response.status < 200 || response.status >= 300) throw new MetadataRequestError(response.status);
      return (await response.json()) as T;
    }
    throw new TicketRejectedError();
  };

  return {
    lookup,
    search: (type, query, page = 1) => lookup({ op: "search", type, query, page }),
    details: (type, id, language = "en") => lookup({ op: "details", type, id, language }),
    videos: (type, id, language) => lookup({ op: "videos", type, id, language }),
    imageUrl: (kind, path, language) => lookup({ op: "image", kind, path, ...(language ? { language } : {}) }),
    skipMarkers: (request) => lookup({ op: "skipMarkers", ...request }),
    musicRecordings: (query) => lookup({ op: "musicRecordings", ...query, contract: 2 }),
    musicAlbums: (query) => lookup({ op: "musicAlbums", ...query, contract: 2 }),
    musicLyrics: (query) => lookup({ op: "musicLyrics", ...query, contract: 2 }),
    musicCopyChanges: (since) => lookup({ op: "musicCopyChanges", ...(since ? { since } : {}), contract: 2 }),
    musicSuggest: (query) => lookup({ op: "musicSuggest", ...query, contract: 2 }),
    musicCover: (album, size = 500) => lookup({ op: "musicCover", id: album, size, contract: 2 }),
    musicArtistImage: (artist) => lookup({ op: "musicArtistImage", id: artist, contract: 2 }),
    subtitles: (request) => lookup({ op: "subtitles", ...request }),
    subtitleFile: (fileId) => lookup({ op: "subtitleFile", fileId }),
  };
}
