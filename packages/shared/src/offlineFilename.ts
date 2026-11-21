// ---------------------------------------------------------------------------
// Offline-download filename helpers.
//
// When the runtime mux step produces the final on-disk file for an offline
// download, the filename is human-readable so the user can browse the folder
// outside SpaceBadger ("take my library before I delete my account"). This
// module produces that name and sanitizes it for cross-OS safety.
//
// Pure (no fs / no node-only deps) so it can run in both the runtime (the
// real writer) and the desktop renderer (the modal preview).
// ---------------------------------------------------------------------------

/** Supported output containers (mirrors @space/runtime-contracts/badger/offline). */
export type OfflineContainer = "mkv" | "mp4";

/** Inputs to buildOfflineFilename — kept minimal, just what we render. */
export type BuildOfflineFilenameInput =
  | {
      kind: "movie";
      title: string;
      /** Movie release year (e.g. 1999). Optional; omitted if unknown. */
      year?: number | null;
      container: OfflineContainer;
    }
  | {
      kind: "episode";
      showTitle: string;
      seasonNumber: number;
      episodeNumber: number;
      episodeTitle?: string | null;
      container: OfflineContainer;
    };

const padTwo = (n: number): string => String(Math.max(0, Math.trunc(n))).padStart(2, "0");

/**
 * Build the human-readable filename for an offline download. Does NOT
 * sanitize — call `sanitizeOfflineFilename` next.
 *
 * Movie:    `<title> (<year>).<ext>`     e.g. `Lattice (1999).mkv`
 * Episode:  `<showTitle> - S<NN>E<NN> - <episodeTitle>.<ext>`
 *           e.g. `Dust Park - S02E03 - Vento e Pietra.mkv`
 *
 * If episodeTitle is missing, the trailing ` - <title>` segment is omitted:
 *   `Dust Park - S02E03.mkv`
 */
export const buildOfflineFilename = (input: BuildOfflineFilenameInput): string => {
  const ext = input.container; // "mkv" | "mp4" — used as the literal extension

  if (input.kind === "movie") {
    const year = typeof input.year === "number" && Number.isFinite(input.year)
      ? ` (${Math.trunc(input.year)})`
      : "";
    return `${input.title.trim()}${year}.${ext}`;
  }

  const season = padTwo(input.seasonNumber);
  const episode = padTwo(input.episodeNumber);
  const head = `${input.showTitle.trim()} - S${season}E${episode}`;
  const tail = input.episodeTitle && input.episodeTitle.trim().length > 0
    ? ` - ${input.episodeTitle.trim()}`
    : "";
  return `${head}${tail}.${ext}`;
};

// ---------------------------------------------------------------------------
// Sanitization
//
// Windows-strict rules so the file survives a cross-OS copy (Windows is the
// strictest of the three desktop OSes — applying its rules everywhere is
// portable). Unicode codepoints outside the Windows-restricted ASCII set are
// preserved as-is.
// ---------------------------------------------------------------------------

const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

const MAX_BASENAME_LENGTH = 200;

// Strip Windows-illegal punctuation AND non-whitespace ASCII control chars
// (0x00–0x08, 0x0E–0x1F). Whitespace controls (\t \n \v \f \r — 0x09–0x0D)
// are intentionally preserved here so the subsequent whitespace-collapse
// pass folds them into single spaces, instead of silently deleting tab/
// newline characters from a title.
const ILLEGAL_CHAR_RE = /[<>:"/\\|?*\x00-\x08\x0E-\x1F]/g;
const WHITESPACE_RUN_RE = /\s+/g;

/**
 * Sanitize a filename for cross-OS safety. Pure; takes the raw name (with or
 * without extension) and returns a safe version.
 *
 * Rules:
 *   - Strip `<>:"/\\|?*` and ASCII control chars (0x00-0x1F)
 *   - Collapse whitespace runs to a single space
 *   - Trim trailing dots and spaces (Windows hates these)
 *   - Suffix Windows-reserved basenames (CON, PRN, AUX, NUL, COM1-9, LPT1-9)
 *   - Truncate the BASENAME (extension preserved) to MAX_BASENAME_LENGTH chars
 *   - Unicode codepoints outside the illegal set are preserved as-is
 *
 * Never returns an empty string; falls back to "untitled" if the input
 * sanitizes to nothing.
 */
export const sanitizeOfflineFilename = (raw: string): string => {
  if (typeof raw !== "string") return "untitled";

  // Split extension early so the truncation and reserved-name check operate
  // on the basename. We treat the LAST `.<ext>` as the extension if its
  // extension portion is short (≤ 5 chars) and alphanumeric — otherwise we
  // treat the whole input as basename. This avoids confusing inputs like
  // "Mr. & Mrs. Smith" where the dots are part of the title.
  const lastDotIdx = raw.lastIndexOf(".");
  const hasExt = lastDotIdx > 0
    && lastDotIdx < raw.length - 1
    && /^[A-Za-z0-9]{1,5}$/.test(raw.slice(lastDotIdx + 1));
  const rawBase = hasExt ? raw.slice(0, lastDotIdx) : raw;
  const rawExt = hasExt ? raw.slice(lastDotIdx + 1) : "";

  let base = rawBase
    .replace(ILLEGAL_CHAR_RE, "")
    .replace(WHITESPACE_RUN_RE, " ")
    .replace(/[. ]+$/g, "") // trailing dots/spaces
    .trim();

  // Suffix reserved Windows names ("CON" -> "CON_") — case-insensitive.
  if (WINDOWS_RESERVED_NAMES.has(base.toUpperCase())) {
    base = `${base}_`;
  }

  if (base.length === 0) {
    base = "untitled";
  }

  if (base.length > MAX_BASENAME_LENGTH) {
    base = base.slice(0, MAX_BASENAME_LENGTH).replace(/[. ]+$/g, "");
  }

  const ext = rawExt.toLowerCase();
  return ext ? `${base}.${ext}` : base;
};

/**
 * Resolve a collision-free filename in a target dir. Given the sanitized name
 * and the set of already-present names, returns the name unchanged if it does
 * not collide, or appends ` (2)`, ` (3)`, … before the extension until free.
 *
 * Names are compared without letter case (#618, OFFL-FILE-02): Windows and
 * macOS file systems treat `Lattice.mkv` and `lattice.MKV` as one file, so a
 * case-only match is a collision on every OS.
 *
 * Pure — does NOT touch the filesystem. The caller is expected to pass in the
 * dir listing (`fs.readdir` or equivalent) so this stays testable; the
 * race-safe move into place is `placeExportFile` (`./exportPlacement`).
 */
export const resolveOfflineFilenameCollision = (
  desired: string,
  existing: ReadonlySet<string>,
): string => {
  const taken = new Set<string>();
  for (const name of existing) taken.add(name.toLowerCase());
  if (!taken.has(desired.toLowerCase())) return desired;

  const lastDotIdx = desired.lastIndexOf(".");
  const hasExt = lastDotIdx > 0
    && lastDotIdx < desired.length - 1
    && /^[A-Za-z0-9]{1,5}$/.test(desired.slice(lastDotIdx + 1));
  const base = hasExt ? desired.slice(0, lastDotIdx) : desired;
  const ext = hasExt ? desired.slice(lastDotIdx + 1) : "";

  // Cap the search at a reasonable upper bound — if we somehow exceed it the
  // last attempt is returned (and the caller will get a fs.rename collision
  // they can surface to the user).
  for (let i = 2; i < 1000; i++) {
    const candidate = ext ? `${base} (${i}).${ext}` : `${base} (${i})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return ext ? `${base} (999).${ext}` : `${base} (999)`;
};
