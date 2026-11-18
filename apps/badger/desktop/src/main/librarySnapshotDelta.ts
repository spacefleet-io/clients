/**
 * #671 R3: pure helpers for the delta `badger.library.updated` frames.
 *
 * The runtime no longer ships the whole library snapshot on every write. A
 * frame says which version it follows (`previousVersion`) and which media'
 * details changed (`changedMediaIds`, `null` = unknown). The proxy fetches a
 * delta snapshot for those media (`badger.db.snapshot` with `mediaIds`: every
 * list complete, `mediaDetails` only for them) and merges it into its cache.
 */
import type { LibrarySnapshot, MediaDetails } from "../shared/libraryTypes";

/** A `badger.db.snapshot` response for `mediaIds`: `partial` marks `mediaDetails` as covering only those media. */
export type LibrarySnapshotDelta = LibrarySnapshot & { partial?: boolean };

/** The `badger.library.updated` payload fields the proxy reads (all optional on the wire). */
type LibraryFramePayload = {
  version?: unknown;
  previousVersion?: unknown;
  reason?: unknown;
  changedMediaIds?: unknown;
  snapshot?: unknown;
};

export type LibraryFrame = {
  version: number | undefined;
  previousVersion: number | undefined;
  reason: string;
  /** Media whose details changed; `null` = the runtime could not say (refetch everything). */
  changedMediaIds: string[] | null;
  /** The embedded snapshot (only the `opened` frame carries one). */
  snapshot: LibrarySnapshot | null;
};

/** Narrow a frame payload. Unknown shapes degrade to "no delta information". */
export const readLibraryFrame = (payload: unknown): LibraryFrame => {
  // Frames come from the runtime's own typed publisher; every field is still
  // checked below because replayed frames may predate this shape.
  const body: LibraryFramePayload = typeof payload === "object" && payload !== null ? payload : {};
  const changed = body.changedMediaIds;
  return {
    version: typeof body.version === "number" ? body.version : undefined,
    previousVersion: typeof body.previousVersion === "number" ? body.previousVersion : undefined,
    reason: typeof body.reason === "string" ? body.reason : "",
    changedMediaIds:
      Array.isArray(changed) && changed.every((id): id is string => typeof id === "string") ? changed : null,
    // The runtime's `opened` frame embeds a LibrarySnapshot.
    snapshot: typeof body.snapshot === "object" && body.snapshot !== null ? (body.snapshot as LibrarySnapshot) : null,
  };
};

/**
 * Merge a delta snapshot into the cached one. Every list in `delta` is
 * complete and replaces the cached list; `mediaDetails` takes the fresh entry
 * for a changed media and keeps the cached one for the rest, in `media` order.
 * Details of media that no longer exist drop out.
 *
 * Returns null when a media has no details anywhere (an unattributed new
 * media): the caller must fall back to a full fetch instead of caching a
 * snapshot with a hole.
 */
export const mergeSnapshotDelta = (base: LibrarySnapshot, delta: LibrarySnapshotDelta): LibrarySnapshot | null => {
  const fresh = new Map<string, MediaDetails>((delta.mediaDetails ?? []).map((details) => [details.id, details]));
  const cached = new Map<string, MediaDetails>((base.mediaDetails ?? []).map((details) => [details.id, details]));
  const mediaDetails: MediaDetails[] = [];
  for (const row of delta.media) {
    const details = fresh.get(row.id) ?? cached.get(row.id);
    if (!details) return null;
    mediaDetails.push(details);
  }
  // `version` and `partial` describe the delta response, not the merged library: the caller stamps it.
  const { version: _version, partial: _partial, ...lists } = delta;
  return { ...base, ...lists, mediaDetails };
};
