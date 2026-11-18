/**
 * DEV-LIB-01: the operations a tool session may run, and nothing else.
 *
 * Each operation is one named, zod-validated entry that calls the same library
 * methods the apps reach through `badger.db.call`, with the answer cut down to
 * the fields a tool needs: storage keys, chunk lists, object keys, backend and
 * session data never leave. There is deliberately no generic "call method X":
 * a method that is not listed here does not exist for a tool.
 */
import {
  TOOL_ACCESS_ERRORS,
  toolOperationInputSchemas,
  type ToolAccessError,
  type ToolOperation,
  type ToolOperationInput,
} from "@space/tool-access/contracts";
import type { DesktopHandoffManager } from "./desktopHandoff";

/** The slice of the library service the operations use (the real one is `BadgerLibraryDbService`). */
export type ToolLibrary = {
  isOpen(): boolean;
  call(method: string, args?: unknown[]): Promise<unknown>;
};

/** Who calls, and the hand-off manager the PLAT-WEB-04 operations run through. */
export type ToolOperationContext = {
  grantId: string;
  handoff: Pick<DesktopHandoffManager, "play" | "get">;
};

type FailureStatus = 400 | 404 | 409 | 423 | 500;
export type ToolOperationResult =
  | { status: 200; body: unknown }
  | { status: FailureStatus; error: ToolAccessError; message: string };

const failure = (status: FailureStatus, error: ToolAccessError, message: string): ToolOperationResult => ({
  status,
  error,
  message,
});
const ok = (body: unknown): ToolOperationResult => ({ status: 200, body });

type Row = Record<string, unknown>;
const pick = (row: Row, keys: readonly string[]): Row => {
  const out: Row = {};
  for (const key of keys) if (key in row) out[key] = row[key];
  return out;
};
const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

const MEDIA_FIELDS = [
  "id",
  "type",
  "catalogId",
  "externalIds",
  "title",
  "originalTitle",
  "originalLanguage",
  "overview",
  "year",
  "rating",
  "posterPath",
  "backdropPath",
  "genres",
  "addedAt",
  "updatedAt",
  "hasFiles",
  "progressPct",
  "lastWatchedAt",
  "totalEpisodes",
  "episodeCount",
] as const;
const PLAYLIST_FIELDS = ["id", "name", "slug", "isSystem", "createdAt"] as const;
const DOWNLOAD_FIELDS = ["id", "mediaId", "fileId", "formatId", "quality", "container", "totalBytes", "downloadedAt"] as const;

/** `getMediaDetails` without storage: no object keys, chunk lists, init keys or format internals. */
const projectMediaDetails = (details: Row): Row => ({
  ...pick(details, MEDIA_FIELDS),
  cast: rows(details.cast).map((member) => pick(member, ["name", "role", "catalogId"])),
  playlistIds: Array.isArray(details.playlistIds) ? details.playlistIds : [],
  seasons: rows(details.seasons).map((season) =>
    pick(season, ["id", "seasonNumber", "name", "overview", "episodeCount", "airDate"])
  ),
  episodes: rows(details.episodes).map((episode) =>
    pick(episode, ["id", "seasonNumber", "episodeNumber", "name", "overview", "airDate"])
  ),
  files: rows(details.files).map((file) => pick(file, ["id", "filename", "season", "episode"])),
  formats: rows(details.formats).map((format) =>
    pick(format, ["id", "fileId", "quality", "codec", "bitrateKbps", "sizeMb", "durationSeconds", "isSource"])
  ),
  audioTracks: rows(details.audioTracks).map((track) => pick(track, ["id", "language", "label", "isDefault", "codec"])),
  subtitleTracks: rows(details.subtitleTracks).map((track) =>
    pick(track, ["id", "language", "label", "format", "isDefault"])
  ),
  hasLocalFiles: details.hasLocalFiles === true,
});

type Handler<Op extends ToolOperation> = (
  library: ToolLibrary,
  input: ToolOperationInput<Op>,
  context: ToolOperationContext
) => Promise<ToolOperationResult>;

const mediaExists = async (library: ToolLibrary, mediaId: string) =>
  (await library.call("getMediaDetails", [mediaId])) !== null;
const playlistExists = async (library: ToolLibrary, playlistId: string) =>
  rows(await library.call("listPlaylists")).some((row) => row.id === playlistId);

const NO_MEDIA = failure(404, TOOL_ACCESS_ERRORS.notFound, "No such media item.");
const NO_PLAYLIST = failure(404, TOOL_ACCESS_ERRORS.notFound, "No such playlist.");

const HANDLERS: { [Op in ToolOperation]: Handler<Op> } = {
  async listMedia(library, input) {
    const all = rows(await library.call("listMedia", input.type ? [input.type] : []));
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 500;
    return ok({
      items: all.slice(offset, offset + limit).map((row) => pick(row, MEDIA_FIELDS)),
      total: all.length,
      offset,
      limit,
    });
  },
  async getMediaDetails(library, input) {
    const details = (await library.call("getMediaDetails", [input.mediaId])) as Row | null;
    return details ? ok(projectMediaDetails(details)) : NO_MEDIA;
  },
  async listPlaylists(library) {
    return ok({ items: rows(await library.call("listPlaylists")).map((row) => pick(row, PLAYLIST_FIELDS)) });
  },
  async listPlaylistItems(library, input) {
    const ids = await library.call("listPlaylistItems", [input.playlistId]);
    return ok({ playlistId: input.playlistId, mediaIds: Array.isArray(ids) ? ids : [] });
  },
  async listLocalDownloads(library, input) {
    const items = rows(await library.call("listLocalDownloads", input.mediaIds ? [input.mediaIds] : []));
    return ok({ items: items.map((row) => pick(row, DOWNLOAD_FIELDS)) });
  },
  async setProgress(library, input) {
    const details = (await library.call("getMediaDetails", [input.mediaId])) as Row | null;
    if (!details) return NO_MEDIA;
    if (input.episodeId && !rows(details.episodes).some((episode) => episode.id === input.episodeId)) {
      return failure(404, TOOL_ACCESS_ERRORS.notFound, "No such episode on this media item.");
    }
    const timing =
      input.positionSeconds !== undefined || input.durationSeconds !== undefined
        ? { positionSeconds: input.positionSeconds ?? null, durationSeconds: input.durationSeconds ?? null }
        : null;
    await library.call("setProgress", [input.mediaId, input.progressPct, input.episodeId ?? null, timing]);
    return ok({ ok: true });
  },
  async updateMediaMetadata(library, input) {
    if (!(await mediaExists(library, input.mediaId))) return NO_MEDIA;
    await library.call("updateMediaMetadata", [{ mediaId: input.mediaId, media: input.media }]);
    return ok({ ok: true });
  },
  async createPlaylist(library, input) {
    const before = new Set(rows(await library.call("listPlaylists")).map((row) => row.id));
    await library.call("createPlaylist", [input.name]);
    const created = rows(await library.call("listPlaylists")).find((row) => !before.has(row.id));
    return ok({ ok: true, playlistId: created?.id ?? null });
  },
  async addToPlaylist(library, input) {
    if (!(await playlistExists(library, input.playlistId))) return NO_PLAYLIST;
    if (!(await mediaExists(library, input.mediaId))) return NO_MEDIA;
    await library.call("addToPlaylist", [input.playlistId, input.mediaId]);
    return ok({ ok: true });
  },
  async removeFromPlaylist(library, input) {
    if (!(await playlistExists(library, input.playlistId))) return NO_PLAYLIST;
    await library.call("removeFromPlaylist", [input.playlistId, input.mediaId]);
    return ok({ ok: true });
  },
  // PLAT-WEB-04: hand playback to the Badger desktop player (the web player's grant).
  async playOnDesktop(library, input, context) {
    if (!(await mediaExists(library, input.mediaId))) return NO_MEDIA;
    const started = context.handoff.play(context.grantId, input.mediaId);
    if (!started.ok) {
      return failure(409, TOOL_ACCESS_ERRORS.noDesktopPlayer, "No Badger desktop player is running on this computer.");
    }
    return ok({ handoffId: started.handoffId });
  },
  async getDesktopPlayback(_library, input, context) {
    const state = context.handoff.get(context.grantId, input.handoffId);
    return state ? ok(state) : failure(404, TOOL_ACCESS_ERRORS.notFound, "No such hand-off.");
  },
};

/**
 * Run `operation` for a tool: locked library first (423), then input
 * validation (400), then the operation. Any failure inside the library becomes
 * a generic 500: the raw error text stays in the runtime log.
 */
export const runToolOperation = async (
  library: ToolLibrary,
  operation: ToolOperation,
  rawInput: unknown,
  context: ToolOperationContext
): Promise<ToolOperationResult> => {
  if (!library.isOpen()) {
    return failure(423, TOOL_ACCESS_ERRORS.libraryLocked, "The library is locked. Open SpaceFleet and unlock your library, then try again.");
  }
  const parsed = toolOperationInputSchemas[operation].safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    return failure(400, TOOL_ACCESS_ERRORS.invalidPayload, issues);
  }
  try {
    const handler = HANDLERS[operation] as Handler<ToolOperation>;
    return await handler(library, parsed.data as ToolOperationInput<ToolOperation>, context);
  } catch (error) {
    console.warn(`[runtime] tool operation ${operation} failed:`, error instanceof Error ? error.message : "unknown error");
    return failure(500, TOOL_ACCESS_ERRORS.operationFailed, "The library operation failed.");
  }
};
