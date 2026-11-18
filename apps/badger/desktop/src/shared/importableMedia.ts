/** The files Badger imports, by extension: the folder scan and file picker (main) and the window drop (renderer). */
export const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mkv",
  ".avi",
  ".mov",
  ".wmv",
  ".m4v",
  ".webm",
  ".mpg",
  ".mpeg",
  ".ts",
  ".mts",
  ".m2ts",
]);

export const SUBTITLE_EXTENSIONS = new Set([
  ".srt",
  ".vtt",
  ".ass",
  ".ssa",
  ".sub",
  ".sup",
]);

/** A video or subtitle file, by its extension (the window drop's filter, UX-ADD-02). */
export const isImportableMediaFile = (path: string): boolean => {
  const base = path.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  const extension = base.slice(dot).toLowerCase();
  return VIDEO_EXTENSIONS.has(extension) || SUBTITLE_EXTENSIONS.has(extension);
};
