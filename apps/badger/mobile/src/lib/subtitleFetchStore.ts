import type { MediaDetails } from "@space/shared/libraryTypes";
import {
  replaceFetchedSubtitle,
  storeFetchedSubtitle,
  storeSubtitleFile,
  subtitleFetchNeedsTitle,
  subtitleFetchTarget,
  subtitleTitleMatches,
  type FetchedSubtitleTrack as LibraryFetchedSubtitleTrack,
  type StoreFetchedSubtitleDeps,
  type StoredSubtitleFile,
  type SubtitleFetchEntry,
} from "@space/shared/subtitleFetch";
import type { SubtitleFetchFlowInput, TryAnotherSubtitleVersionInput } from "@space/shared/subtitleFetchFlow";
import { subtitlePickPatch, type TrackPrefsPatch } from "@space/shared/trackPrefs";
import type { MetadataClient } from "@space/metadata-client";
import { detectSubtitleFileLanguage } from "@space/ingest-core/subtitleLanguageDetection";

/**
 * A subtitle "Get subtitles" (PLAY-SUBGET-02) or "Try another version" (PLAY-SUBGET-07) just added, so the player can
 * turn it on. `source` is the fetched track's (`fetchedSubtitleSource(fileId)`), so the player can offer another version.
 */
export type FetchedSubtitleTrack = {
  id: string;
  language: string;
  label: string;
  objectKey: string;
  format: string;
  source: string;
};

export type SubtitleFetchPhoneActions = {
  uploadSubtitleContent: (mediaId: string, episodeId: string | null, content: string, format: string) => Promise<string>;
  addSubtitleTrack: (track: {
    mediaId: string;
    episodeId: string | null;
    language: string;
    label: string;
    objectKey: string;
    format: string | null;
    source: string;
  }) => Promise<string>;
  setTrackPrefs: (mediaId: string, patch: TrackPrefsPatch) => Promise<void>;
};

/**
 * The library writes "Try another version" needs on top of storing (PLAY-SUBGET-07): dropping the replaced track, then
 * deleting its stored file once no track names it.
 */
export type SubtitleReplacePhoneActions = SubtitleFetchPhoneActions & {
  removeSubtitleTrack: (trackId: string) => Promise<void>;
  subtitleObjectInUse: (objectKey: string) => Promise<boolean>;
  deleteStoredObjects: (keys: string[]) => Promise<void>;
};

/**
 * How the phone stores a subtitle it got, fetched or added from a file (PLAY-SUBGET-19, -23): sealed on the phone and
 * stored in the vault on the media's silo, added as a track, remembered as the film's or show's subtitle.
 */
const subtitleStorePhoneDeps = (params: {
  media: MediaDetails;
  episodeId: string | null;
  actions: SubtitleFetchPhoneActions;
  onTrackAdded?: (track: FetchedSubtitleTrack) => void;
}): Pick<StoreFetchedSubtitleDeps, "upload" | "addTrack" | "rememberChoice"> => {
  const { media, episodeId, actions, onTrackAdded } = params;
  return {
    upload: (content, format) => actions.uploadSubtitleContent(media.id, episodeId, content, format),
    addTrack: async (track) => {
      const id = await actions.addSubtitleTrack({ mediaId: media.id, episodeId, ...track });
      onTrackAdded?.({ id, language: track.language, label: track.label, objectKey: track.objectKey, format: track.format, source: track.source });
    },
    rememberChoice: async (choice) => {
      const patch = subtitlePickPatch(choice);
      if (patch) await actions.setTrackPrefs(media.id, patch);
    },
  };
};

/**
 * How the phone stores a fetched subtitle (PLAY-SUBGET-01, -03, -19): downloaded through the metadata service, then
 * stored like any subtitle it gets (`subtitleStorePhoneDeps`). Same steps as the computer app's
 * `subtitleFetchStoreDeps`; only the sealing differs (no main process).
 */
export const subtitleFetchPhoneDeps = (params: {
  media: MediaDetails;
  episodeId: string | null;
  client: Pick<MetadataClient, "subtitleFile">;
  actions: SubtitleFetchPhoneActions;
  onTrackAdded?: (track: FetchedSubtitleTrack) => void;
}): StoreFetchedSubtitleDeps => ({
  download: (fileId) => params.client.subtitleFile(fileId),
  ...subtitleStorePhoneDeps(params),
});

/**
 * The inputs of the shared "Get subtitles" flow (`useSubtitleFetchFlow`) for a film (`episodeId` null) or one episode:
 * the search by catalog id through the metadata service (PLAY-SUBGET-03, -14), the file name to rank against, the
 * subtitles it already has, and the phone's storage. A title without a catalog id starts with the title step
 * (PLAY-SUBGET-24): the metadata service's title search, then the subtitle search by the picked match's ID, for this
 * search only. Null when there is nothing to search by.
 */
export const subtitleFetchPhoneInput = (params: {
  media: MediaDetails;
  episodeId: string | null;
  uiLanguage: string;
  client: Pick<MetadataClient, "subtitles" | "subtitleFile" | "search">;
  actions: SubtitleFetchPhoneActions;
  onTrackAdded?: (track: FetchedSubtitleTrack) => void;
}): SubtitleFetchFlowInput | null => {
  const { media, episodeId, client } = params;
  const target = subtitleFetchTarget(media, episodeId);
  const titleSearch = target ? null : subtitleFetchNeedsTitle(media, episodeId);
  // The file name and the existing tracks don't depend on the ID: without one, read them for any.
  const shape = target ?? (titleSearch ? subtitleFetchTarget(media, episodeId, 0) : null);
  if (!shape) return null;
  const deps = subtitleFetchPhoneDeps(params);
  return {
    uiLanguage: params.uiLanguage,
    libraryFileName: shape.libraryFileName,
    existingTracks: shape.existingTracks,
    search: (match) => {
      const request = match ? subtitleFetchTarget(media, episodeId, match.catalogId)?.request : target?.request;
      if (!request) return Promise.reject(new Error("subtitle_fetch.no_target"));
      return client.subtitles(request);
    },
    ...(titleSearch
      ? {
          findTitle: {
            query: titleSearch.query,
            find: async (query: string) => subtitleTitleMatches((await client.search(titleSearch.type, query)).results),
          },
        }
      : {}),
    store: (entry: SubtitleFetchEntry, report, signal) => storeFetchedSubtitle(entry, report, deps, signal),
  };
};

/**
 * "Add a subtitle file…" on the phone (PLAY-SUBGET-23): the picked file stored like a fetched subtitle, named after
 * the file (the phone has no language detection, so the file name applies), source "added-file". Throws
 * `UnreadableSubtitleFileError` before storing anything when it isn't a readable .srt, .ass, .ssa or .vtt.
 */
export const storeSubtitleFilePhone = (
  file: { name: string; content: string },
  params: {
    media: MediaDetails;
    episodeId: string | null;
    uiLanguage: string;
    actions: SubtitleFetchPhoneActions;
    onTrackAdded?: (track: FetchedSubtitleTrack) => void;
  },
): Promise<StoredSubtitleFile> =>
  storeSubtitleFile(file, {
    ...subtitleStorePhoneDeps(params),
    uiLanguage: params.uiLanguage,
    takenLabels: params.media.subtitleTracks.filter((track) => (track.episodeId ?? null) === params.episodeId).map((track) => track.label),
    detectLanguage: async (text) => (await detectSubtitleFileLanguage(text))?.language ?? null,
  });

/**
 * The inputs of the shared "Try another version" (`tryAnotherSubtitleVersion`, PLAY-SUBGET-07) for one fetched track of
 * a film or episode: the same search as "Get subtitles", and the phone's storage plus
 * dropping the old track (`replaceFetchedSubtitle`), so the title keeps one track of that name, and deleting the old
 * track's stored file once nothing names it. Null when the title has no catalog id (nothing to search by).
 */
export const subtitleTryAnotherPhoneInput = (params: {
  media: MediaDetails;
  episodeId: string | null;
  uiLanguage: string;
  track: LibraryFetchedSubtitleTrack;
  client: Pick<MetadataClient, "subtitles" | "subtitleFile">;
  actions: SubtitleReplacePhoneActions;
  onTrackAdded?: (track: FetchedSubtitleTrack) => void;
}): TryAnotherSubtitleVersionInput | null => {
  const target = subtitleFetchTarget(params.media, params.episodeId);
  if (!target) return null;
  // The player knows the track by id; its stored file is the library's.
  const track = {
    ...params.track,
    objectKey: params.track.objectKey ?? params.media.subtitleTracks.find((item) => item.id === params.track.id)?.objectKey ?? null,
  };
  const deps = {
    ...subtitleFetchPhoneDeps(params),
    removeTrack: params.actions.removeSubtitleTrack,
    objectInUse: params.actions.subtitleObjectInUse,
    deleteObject: (key: string) => params.actions.deleteStoredObjects([key]),
    onDeleteFailed: (key: string, error: unknown) =>
      console.warn("subtitle_version.old_file_kept", JSON.stringify({ mediaId: params.media.id, key, error: String(error) })),
  };
  return {
    uiLanguage: params.uiLanguage,
    libraryFileName: target.libraryFileName,
    track,
    search: () => params.client.subtitles(target.request),
    replace: (file, report, signal) => replaceFetchedSubtitle(track, file, report, deps, signal),
  };
};
