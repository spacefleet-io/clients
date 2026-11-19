// Client entry of @space/metadata-client. Portable: no node:* import and no DOM-only API in its graph (a test
// enforces it), so it runs in the Electron renderer, React Native / Hermes, Bun and Node.

export { createTicketReserve, RATE_LIMITED_MAX_SPREAD_MS, RATE_LIMITED_MIN_RETRY_MS, RESERVE_STORAGE_KEY } from "./reserve";
export type { RefillResult, RefillStatus, TicketAuth, TicketReserve, TicketReserveConfig, TicketReserveOptions, TicketShortage } from "./reserve";
export { describeRefill, refillLogLine } from "./refillLog";
export type { RefillLogEntry } from "./refillLog";
export {
  createMetadataClient,
  MAX_TICKET_RETRIES,
  MediaDeletedError,
  MetadataRequestError,
  MetadataUnavailableError,
  NoTicketError,
  NEUTRAL_USER_AGENT,
  TicketRejectedError,
} from "./client";
export { withLookupRetry } from "./retry";
export type { LookupRetryOptions } from "./retry";
export type { ImageKind, LookupBody, MetadataClient, MetadataClientConfig, SkipMarkersRequest, TicketSource } from "./client";
export type {
  MusicAlbum,
  MusicAlbumTrack,
  MusicAlbumsQuery,
  MusicArtistImage,
  MusicArtistRef,
  MusicCoverSize,
  MusicImage,
  MusicLyrics,
  MusicLyricsQuery,
  MusicPhotoCredit,
  MusicRecording,
  MusicRecordingsQuery,
} from "@space/shared/api";
export type { SubtitleCandidate, SubtitleFileResult, SubtitleFormat, SubtitlesRequest, SubtitlesResult } from "@space/shared/api";
export { BACKGROUND_LOOKUP_DELAY_MS, createSessionMetadata, syncStorageAdapter } from "./session";
export type { SessionMetadata, SessionMetadataDeps, SyncStringStorage } from "./session";
export { createMetadataImageResolver, DEFAULT_IMAGE_CACHE_ENTRIES, DEFAULT_IMAGE_FAILURE_TTL_MS } from "./images";
export type { ArtworkStore, ImageOutcome, MetadataImageResolver, MetadataImageResolverOptions } from "./images";
export { createLocalizedOverviews, detailsOverview, localizedOverviews, OVERVIEW_FALLBACK_LANGUAGE } from "./overviews";
export type { FetchOverview, LocalizedOverviews } from "./overviews";
export {
  createLocalizedEpisodes,
  detailsEpisodes,
  EMPTY_EPISODES,
  episodeKey,
  localizedEpisodeOverview,
  localizedEpisodes,
} from "./episodes";
export type { EpisodeText, FetchEpisodes, LocalizedEpisode, LocalizedEpisodeMap, LocalizedEpisodes } from "./episodes";
export { createDetailsTexts } from "./localizedTexts";
export type { AskDetails, DetailsTextItem, DetailsTexts, DetailsTextsDeps, LocalizedTextLibrary } from "./localizedTexts";
export { reconcileTitleVariants, TITLE_VARIANTS_PAUSE_MS } from "./titleVariants";
export type {
  AskTitleArt,
  ReconcileTitleVariantsDeps,
  ReconcileTitleVariantsResult,
  TitleArtItem,
  TitleVariantsLibrary,
  TitleVariantsMedia,
} from "./titleVariants";
export { DEFAULT_METADATA_URL, DEV_METADATA_URL, metadataTicketsForBuild, metadataUrlForApi, resolveMetadataUrl } from "./metadataUrl";
export type { MetadataUrlEnv } from "./metadataUrl";
export { MAX_TIMER_MS, defaultRandom, defaultTimers, parseRetryAfterSeconds } from "./types";
export type { AbortSignalLike, FetchInit, FetchLike, FetchResponse, KeyValueStorage, RandomFn, Timers } from "./types";
