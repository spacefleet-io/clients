import type { SeekPreviewFrame, SeekPreviewSource } from "@space/mobile-mpv-playback/seekPreview";
import type { MediaFormat } from "@space/shared/libraryTypes";
import { locatePreviewPicture, parsePreviewSheets, type MediaPreviewSheet, type MediaPreviewSheets } from "@space/shared/previewSheets";

/**
 * Seek-bar preview pictures on the phone and the TV (MPV-PREV-01). The desktop made them at import and recorded them on
 * the played file's source format; each sheet is an encrypted object the playback proxy fetches and decrypts like a
 * subtitle (`/playback/object/<key>`). The mobile mpv has no encoder and no screenshot, so the app draws the picture
 * itself: the sheet is decoded by React Native `Image` from an in-memory `data:` URI, never written to disk (whether
 * decrypted pictures may be cached on disk is not decided).
 */

/** Pictures from a sheet's edge at which the neighbouring sheet is fetched too (20 pictures = 100 s of video). */
export const PREFETCH_EDGE_PICTURES = 20;

/** The record of the played file: the source format carries it, the other copies of the file do not. */
export const previewSheetsForFile = (
  formats: ReadonlyArray<Pick<MediaFormat, "fileId" | "previewSheets">>,
  fileId: string
): MediaPreviewSheets | null => {
  for (const format of formats) {
    if (format.fileId !== fileId) continue;
    const previews = parsePreviewSheets(format.previewSheets);
    if (previews) return previews;
  }
  return null;
};

/** How often an open player without previews checks whether another device's changes landed (MPV-PREV-04). */
export const LATE_PREVIEWS_POLL_MS = 2_000;

export type LatePreviewsWatchOptions = {
  /** Moves only when another device's changes land (`syncedLibraryRevision`): this device's own writes never re-read. */
  readRevision: () => number;
  /** The revision the session's own read of the title was made at: anything newer is read again. */
  sinceRevision: number;
  /** Reads the played file's record from the library again (null: still none, or malformed). */
  readPreviews: () => Promise<MediaPreviewSheets | null>;
  /** The record arrived: called once, after which the watch has stopped. */
  onFound: (previews: MediaPreviewSheets) => void;
  intervalMs?: number;
};

/**
 * MPV-PREV-04: a video opened before its import's preview run finished has no pictures at first. While it has none,
 * the player watches the library: each time another device's changes landed it re-reads the played file's record,
 * and hands it over the moment it is there, so the open playback starts showing pictures without a reopen. Returns
 * the stop (playback closed). One read at a time; a failed read waits for the next change.
 */
export const watchLatePreviewSheets = ({
  readRevision,
  sinceRevision,
  readPreviews,
  onFound,
  intervalMs = LATE_PREVIEWS_POLL_MS,
}: LatePreviewsWatchOptions): (() => void) => {
  let seen = sinceRevision;
  let reading = false;
  let stopped = false;
  console.info("[mpv-previews] late.watch.start", JSON.stringify({ sinceRevision, intervalMs }));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (stopped || reading) return;
    const revision = readRevision();
    if (revision === seen) return;
    seen = revision;
    reading = true;
    readPreviews().then(
      (previews) => {
        reading = false;
        if (stopped) return;
        if (!previews) {
          console.info("[mpv-previews] late.read.none", JSON.stringify({ revision }));
          return;
        }
        console.info(
          "[mpv-previews] late.found",
          JSON.stringify({ revision, sheets: previews.sheets.length, pictureCount: previews.pictureCount })
        );
        stop();
        onFound(previews);
      },
      (error: unknown) => {
        reading = false;
        console.warn("[mpv-previews] late.read.failed", JSON.stringify({ revision, error: String(error) }));
      }
    );
  }, intervalMs);
  return () => {
    if (!stopped) console.info("[mpv-previews] late.watch.stop", JSON.stringify({ seen }));
    stop();
  };
};

export type SeekPreviewSourceOptions = {
  /** The library record (anything malformed reads as no previews). */
  previews: unknown;
  /** URL of a sheet's decrypted bytes. */
  sheetUrl: (objectKey: string) => string;
  /** Fetches one sheet and returns it as an in-memory image URI. */
  loadSheet: (url: string) => Promise<string>;
};

/** One playback's previews, or null when the title has none (the seek bar then behaves exactly as before). */
export const createSeekPreviewSource = ({ previews: raw, sheetUrl, loadSheet }: SeekPreviewSourceOptions): SeekPreviewSource | null => {
  const previews = parsePreviewSheets(raw);
  if (!previews || previews.pictureCount <= 0) return null;
  // Every sheet is asked for at most once per playback, a failed one included (no retry storm against the gateway).
  const asked = new Set<string>();
  const loaded = new Map<string, string>();
  const listeners = new Set<() => void>();

  const request = (sheet: MediaPreviewSheet, reason: "pointer" | "prefetch") => {
    if (asked.has(sheet.objectKey)) return;
    asked.add(sheet.objectKey);
    const startedAt = Date.now();
    console.info("[mpv-previews] sheet.load", JSON.stringify({ objectKey: sheet.objectKey, firstPicture: sheet.firstPicture, reason }));
    loadSheet(sheetUrl(sheet.objectKey)).then(
      (uri) => {
        loaded.set(sheet.objectKey, uri);
        console.info(
          "[mpv-previews] sheet.loaded",
          JSON.stringify({ objectKey: sheet.objectKey, uriChars: uri.length, ms: Date.now() - startedAt })
        );
        for (const listener of [...listeners]) listener();
      },
      (error: unknown) => {
        console.warn("[mpv-previews] sheet.failed", JSON.stringify({ objectKey: sheet.objectKey, error: String(error) }));
      }
    );
  };

  return {
    frameAt: (seconds): SeekPreviewFrame | null => {
      const location = locatePreviewPicture(previews, seconds);
      const uri = location ? loaded.get(location.sheet.objectKey) : undefined;
      if (!location || !uri) return null;
      return {
        uri,
        // Every sheet is `columns` pictures wide; the last one only as many rows as it needs.
        sheetWidth: previews.columns * previews.pictureWidth,
        sheetHeight: Math.ceil(location.sheet.pictureCount / previews.columns) * previews.pictureHeight,
        x: location.x,
        y: location.y,
        width: location.width,
        height: location.height,
      };
    },
    want: (seconds) => {
      const location = locatePreviewPicture(previews, seconds);
      if (!location) return;
      request(location.sheet, "pointer");
      const within = location.pictureIndex - location.sheet.firstPicture;
      const previous = previews.sheets[location.sheetIndex - 1];
      const next = previews.sheets[location.sheetIndex + 1];
      if (previous && within < PREFETCH_EDGE_PICTURES) request(previous, "prefetch");
      if (next && location.sheet.pictureCount - 1 - within < PREFETCH_EDGE_PICTURES) request(next, "prefetch");
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

/**
 * Fetches a decrypted sheet from the playback proxy and returns it as a `data:image/jpeg` URI held in JS memory. The
 * proxy answers `application/octet-stream`, so the reader's own data URL prefix is replaced.
 */
export const loadSheetDataUri = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`sheet_http_${response.status}`);
  const blob = await response.blob();
  try {
    // Executor form: the app's runtime code does not rely on `Promise.withResolvers` under Hermes.
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("sheet_read_failed"));
      reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(",");
    if (comma < 0 || comma === dataUrl.length - 1) throw new Error("sheet_empty");
    return `data:image/jpeg;base64,${dataUrl.slice(comma + 1)}`;
  } finally {
    // React Native keeps a fetched blob's bytes in its native blob store until closed.
    (blob as Blob & { close?: () => void }).close?.();
  }
};
