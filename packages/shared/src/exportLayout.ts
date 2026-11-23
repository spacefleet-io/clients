// ---------------------------------------------------------------------------
// Where an exported Badger title lands inside the folder the user picked
// (OFFL-FILE-01 "Download file", ACCT-EXPORT-01 "Download everything").
//
//   flat     "Download file": straight into the picked folder.
//   library  "Download everything": Movies/<Title (Year)>.<ext>,
//            Shows/<Show>/Season NN/<Show - SxxEyy - Title>.<ext>
//            (the layout Plex, Jellyfin and Kodi read without setup).
//
// Pure (no fs) so the runtime (the writer) and the renderer (previews) share it.
// ---------------------------------------------------------------------------

import {
  buildOfflineFilename,
  sanitizeOfflineFilename,
  type BuildOfflineFilenameInput,
} from "./offlineFilename";

export type ExportLayout = "flat" | "library";

export type ExportPath = {
  /** Folders under the picked folder, outermost first; each already safe. */
  dirs: string[];
  /** Safe file name (OFFL-FILE-02), before any collision suffix. */
  filename: string;
};

/** Folder names of the "library" layout. Fixed English words, like the media-server layouts they follow. */
export const EXPORT_MOVIES_FOLDER = "Movies";
export const EXPORT_SHOWS_FOLDER = "Shows";

/**
 * Same rules as `sanitizeOfflineFilename`, applied to the whole name: a folder has no extension, so a trailing
 * `.Who` in "Dr.Who" stays as written instead of being read (and lower-cased) as one.
 */
export const sanitizeExportFolderName = (raw: string): string => {
  const marked = sanitizeOfflineFilename(`${typeof raw === "string" ? raw : ""}.x`);
  const base = marked.endsWith(".x") ? marked.slice(0, -2) : marked;
  return base.length > 0 ? base : "untitled";
};

export const buildExportPath = (input: BuildOfflineFilenameInput, layout: ExportLayout): ExportPath => {
  const filename = sanitizeOfflineFilename(buildOfflineFilename(input));
  if (layout === "flat") return { dirs: [], filename };
  if (input.kind === "movie") return { dirs: [EXPORT_MOVIES_FOLDER], filename };
  return {
    dirs: [
      EXPORT_SHOWS_FOLDER,
      sanitizeExportFolderName(input.showTitle),
      `Season ${String(Math.max(0, Math.trunc(input.seasonNumber))).padStart(2, "0")}`,
    ],
    filename,
  };
};
