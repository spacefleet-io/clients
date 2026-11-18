/**
 * "Get subtitles" (PLAY-SUBGET): turns the metadata service's full subtitle list for one film or episode into the
 * entries the user picks from. Pure and shared by the Badger desktop app and the web player, so both show the same
 * list, pick the same file and name the added track the same way.
 *
 * - One entry per language, kind and cut (PLAY-SUBGET-06, -15, -16); the raw files are never shown.
 * - Inside an entry the files are ranked against the user's own file name (PLAY-SUBGET-14): version tag, then
 *   disc or download format and resolution, then download count. The frame-rate step is skipped: the library stores
 *   no frame rate.
 * - The entry name is the language in the UI language plus "(Hearing impaired)" / "(Foreign parts only)", and a
 *   cut ("French — Director's cut"); the stored track gets that name, numbered when taken (PLAY-SUBGET-17, -18).
 * - An entry whose language and kind the copy already has is marked (PLAY-SUBGET-18).
 */
import { mediaLanguageNameWithoutIntl, normalizeMediaLanguageCode } from "./mediaLanguageDisplay";
import de from "./subtitleFetchCopy/de.json";
import en from "./subtitleFetchCopy/en.json";
import es from "./subtitleFetchCopy/es.json";
import fr from "./subtitleFetchCopy/fr.json";
import nl from "./subtitleFetchCopy/nl.json";

/**
 * The words of the "Get subtitles" flow, one copy for every client (UX-I18N-02): the translation files next to this
 * module (`subtitleFetchCopy/{en,fr,nl,de,es}.json`, key `subtitleFetch`), so the web UI package and a future phone/TV
 * screen read the same strings.
 */
export type SubtitleFetchCopy = (typeof en)["subtitleFetch"];
type SubtitleFetchCopyLanguage = "en" | "fr" | "nl" | "de" | "es";

const SUBTITLE_FETCH_COPY: Record<SubtitleFetchCopyLanguage, SubtitleFetchCopy> = {
  en: en.subtitleFetch,
  fr: fr.subtitleFetch,
  nl: nl.subtitleFetch,
  de: de.subtitleFetch,
  es: es.subtitleFetch,
};

/** The copy for a UI language tag (`"de-DE"` reads German); English for anything else. */
export const subtitleFetchCopy = (uiLanguage?: string | null): SubtitleFetchCopy =>
  SUBTITLE_FETCH_COPY[(uiLanguage || "en").slice(0, 2).toLowerCase() as SubtitleFetchCopyLanguage] ??
  SUBTITLE_FETCH_COPY.en;

/** The fields of a metadata-service subtitle candidate (`SubtitleCandidate`, `@space/shared/api`) this logic reads. */
export type SubtitleFetchCandidate = {
  fileId: number;
  language: string;
  hearingImpaired: boolean;
  foreignPartsOnly: boolean;
  release: string;
  fileName: string;
  downloadCount: number;
  ready: boolean;
};

export type SubtitleFetchKind = "plain" | "hi" | "foreign";
export type SubtitleFetchCut = "directors-cut" | "extended" | "unrated";

/** A subtitle the movie or episode already has, as the library lists it. */
export type SubtitleFetchExistingTrack = {
  language: string | null | undefined;
  label: string | null | undefined;
  source?: string | null;
};

export type SubtitleFetchLabels = {
  /** "Hearing impaired" in the UI language. */
  hearingImpaired: string;
  /** "Foreign parts only" in the UI language. */
  foreignPartsOnly: string;
  cuts: Record<SubtitleFetchCut, string>;
};

/** The entry-name words of a copy (`buildSubtitleEntries` labels). */
export const subtitleFetchLabels = (copy: SubtitleFetchCopy): SubtitleFetchLabels => ({
  hearingImpaired: copy.hearingImpaired,
  foreignPartsOnly: copy.foreignPartsOnly,
  cuts: { "directors-cut": copy.directorsCut, extended: copy.extended, unrated: copy.unrated },
});

/** Fills a copy template's `{name}` slots ("Getting {language} subtitles"); an unknown slot stays as written. */
export const fillSubtitleFetchCopy = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

export type SubtitleFetchEntry = {
  /** Stable within one result: language tag, kind and cut. */
  key: string;
  /** The library's language code for the stored track ("pt" for the provider's "pt-br"). */
  language: string;
  /** The candidate's own language tag, lower-case ("pt-br"). */
  languageTag: string;
  kind: SubtitleFetchKind;
  cut: SubtitleFetchCut | null;
  /** What the list shows: "Spanish (Hearing impaired)", "French — Director's cut". */
  name: string;
  /** The name the added track gets: `name`, or "Spanish 2" when the media already has a track of that name. */
  trackName: string;
  /** The file the app picked (PLAY-SUBGET-06). */
  best: SubtitleFetchCandidate;
  /** Every file of the entry, best first ("Try another version" walks this, PLAY-SUBGET-07). */
  files: SubtitleFetchCandidate[];
  /** The copy already has a subtitle of this language and kind: one it came with ("file") or one fetched before. */
  already: "file" | "fetched" | null;
};

export type BuildSubtitleEntriesInput = {
  candidates: readonly SubtitleFetchCandidate[];
  /** The library file's original name (`media_files.filename`), for the release ranking. */
  libraryFileName?: string | null;
  existingTracks?: readonly SubtitleFetchExistingTrack[];
  uiLanguage: string;
  labels: SubtitleFetchLabels;
};

/**
 * Stored on a fetched track (`source`) for the app's own use; never shown to the user (PLAY-SUBGET-17). A track fetched
 * since "Try another version" (PLAY-SUBGET-07) also names the file it holds: `opensubtitles:<fileId>`.
 */
export const OPENSUBTITLES_TRACK_SOURCE = "opensubtitles";

/** The `source` of a track holding the site's file `fileId`. */
export const fetchedSubtitleSource = (fileId: number) => `${OPENSUBTITLES_TRACK_SOURCE}:${fileId}`;

export const isFetchedSubtitleSource = (source: string | null | undefined) =>
  source === OPENSUBTITLES_TRACK_SOURCE || (source?.startsWith(`${OPENSUBTITLES_TRACK_SOURCE}:`) ?? false);

/** The site's file ID a fetched track holds; null for other tracks and for tracks fetched before it was recorded. */
export const fetchedSubtitleFileId = (source: string | null | undefined): number | null => {
  const match = /^opensubtitles:(\d+)$/.exec(source ?? "");
  return match ? Number(match[1]) : null;
};

const KIND_ORDER: Record<SubtitleFetchKind, number> = { plain: 0, hi: 1, foreign: 2 };

/** Foreign-parts wins over hearing impaired (PLAY-SUBGET-16 notes). */
export const subtitleCandidateKind = (candidate: Pick<SubtitleFetchCandidate, "hearingImpaired" | "foreignPartsOnly">): SubtitleFetchKind =>
  candidate.foreignPartsOnly ? "foreign" : candidate.hearingImpaired ? "hi" : "plain";

const CUT_PATTERNS: ReadonlyArray<[SubtitleFetchCut, RegExp]> = [
  ["directors-cut", /director'?s?[ ._-]*cut|\bdc\b/i],
  ["extended", /\bextended\b/i],
  ["unrated", /\bunrated\b/i],
];

/** A genuinely different cut named in a release ("Director's cut", "Extended"), else null (PLAY-SUBGET-06). */
export const subtitleReleaseCut = (release: string): SubtitleFetchCut | null => {
  const text = release.replace(/[._]/g, " ");
  for (const [cut, pattern] of CUT_PATTERNS) if (pattern.test(text)) return cut;
  return null;
};

/** "pt-br" → "pt", "spa" → "es", "en" → "en"; "und" when unknown. */
export const subtitleLibraryLanguage = (tag: string) => {
  const lower = tag.trim().toLowerCase();
  const base = lower.split(/[-_]/)[0] ?? "";
  const normalized = normalizeMediaLanguageCode(base);
  return normalized === "und" ? base || "und" : normalized;
};

const displayNamesCache = new Map<string, Intl.DisplayNames>();
const languageName = (tag: string, uiLanguage: string) => {
  const locale = uiLanguage.trim() || "en";
  const [base = tag, region] = tag.split(/[-_]/);
  if (typeof Intl.DisplayNames !== "function") return mediaLanguageNameWithoutIntl(base, region, locale) ?? tag.toUpperCase();
  let names = displayNamesCache.get(locale);
  if (!names) {
    names = new Intl.DisplayNames([locale], { type: "language" });
    displayNamesCache.set(locale, names);
  }
  const bcp47 = region ? `${base}-${region.toUpperCase()}` : base;
  try {
    const name = names.of(bcp47)?.trim();
    if (name && name.toLowerCase() !== bcp47.toLowerCase()) return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
  } catch {
    // An invalid tag falls through to the raw code.
  }
  return tag.toUpperCase();
};

/** Disc or download formats named in a file name, most specific first. */
const FORMAT_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["remux", /\bremux\b/i],
  ["blu-ray", /\b(blu[ -]?ray|bd)\b/i],
  ["web-dl", /\bweb[ -]?dl\b/i],
  ["web", /\bweb\b/i],
  ["hdtv", /\bhdtv\b/i],
  ["dvd", /\bdvd(rip|r)?\b/i],
];

/** What a file name says about the copy: its trailing version tag (`-WORD`), disc or download format and resolution. */
type FileNameFacts = { versionTag: string | null; format: string | null; resolution: string | null };

const fileNameFacts = (name: string | null | undefined): FileNameFacts => {
  const stem = (name ?? "").trim().replace(/\.(mkv|mp4|avi|m4v|mov|webm|srt|ass|ssa|vtt|sub)$/i, "");
  const text = stem.replace(/[._]/g, " ");
  const versionTagMatch = /-([a-z0-9]+)(?:\[[^\]]*\])?$/i.exec(stem.replace(/\s+/g, "."));
  const format = FORMAT_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;
  const resolution = /\b(2160|1080|720|576|480)[pi]\b/i.exec(text)?.[1] ?? (/\b4k\b/i.test(text) ? "2160" : null);
  return { versionTag: versionTagMatch?.[1]?.toLowerCase() ?? null, format, resolution };
};

/** How well a subtitle file was made for the user's copy: version tag, then format, then resolution. */
const fileNameMatchScore = (library: FileNameFacts, candidate: SubtitleFetchCandidate) => {
  const own = [fileNameFacts(candidate.release), fileNameFacts(candidate.fileName)];
  let score = 0;
  if (library.versionTag && own.some((facts) => facts.versionTag === library.versionTag)) score += 100;
  if (library.format && own.some((facts) => facts.format === library.format)) score += 10;
  if (library.resolution && own.some((facts) => facts.resolution === library.resolution)) score += 1;
  return score;
};

/** The files of one entry, best first (PLAY-SUBGET-14). */
export const rankSubtitleCandidates = (
  candidates: readonly SubtitleFetchCandidate[],
  libraryFileName?: string | null
): SubtitleFetchCandidate[] => {
  const library = fileNameFacts(libraryFileName);
  return candidates
    .map((candidate) => ({ candidate, score: fileNameMatchScore(library, candidate) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.candidate.downloadCount - a.candidate.downloadCount ||
        Number(b.candidate.ready) - Number(a.candidate.ready) ||
        a.candidate.fileId - b.candidate.fileId
    )
    .map(({ candidate }) => candidate);
};

const existingTrackKind = (label: string, labels: SubtitleFetchLabels): SubtitleFetchKind => {
  const lower = label.toLowerCase();
  if (lower.includes(labels.foreignPartsOnly.toLowerCase()) || /\b(forced|foreign)\b/.test(lower)) return "foreign";
  if (lower.includes(labels.hearingImpaired.toLowerCase()) || /\b(sdh|hi|cc|hearing)\b/.test(lower)) return "hi";
  return "plain";
};

/** `name`, or "name 2", "name 3"… when the media already has a subtitle of that name (PLAY-SUBGET-17, -18). */
export const uniqueSubtitleTrackName = (name: string, takenLabels: Iterable<string | null | undefined>) => {
  const taken = new Set<string>();
  for (const label of takenLabels) if (label) taken.add(label.trim().toLowerCase());
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};

export const buildSubtitleEntries = ({
  candidates,
  libraryFileName,
  existingTracks = [],
  uiLanguage,
  labels,
}: BuildSubtitleEntriesInput): SubtitleFetchEntry[] => {
  const groups = new Map<string, { tag: string; kind: SubtitleFetchKind; cut: SubtitleFetchCut | null; files: SubtitleFetchCandidate[] }>();
  for (const candidate of candidates) {
    const tag = candidate.language.trim().toLowerCase();
    if (!tag) continue;
    const kind = subtitleCandidateKind(candidate);
    const cut = subtitleReleaseCut(candidate.release) ?? subtitleReleaseCut(candidate.fileName);
    const key = `${tag}|${kind}|${cut ?? ""}`;
    const group = groups.get(key) ?? { tag, kind, cut, files: [] };
    group.files.push(candidate);
    groups.set(key, group);
  }

  const existing = existingTracks.map((track) => ({
    language: subtitleLibraryLanguage(track.language ?? ""),
    kind: existingTrackKind(track.label ?? "", labels),
    fetched: isFetchedSubtitleSource(track.source),
  }));
  const takenLabels = existingTracks.map((track) => track.label);

  const entries = [...groups.entries()].map(([key, group]): SubtitleFetchEntry => {
    const language = subtitleLibraryLanguage(group.tag);
    const base = languageName(group.tag, uiLanguage);
    const kindName = group.kind === "hi" ? labels.hearingImpaired : group.kind === "foreign" ? labels.foreignPartsOnly : null;
    const withKind = kindName ? `${base} (${kindName})` : base;
    const name = group.cut ? `${withKind} — ${labels.cuts[group.cut]}` : withKind;
    const files = rankSubtitleCandidates(group.files, libraryFileName);
    const matches = existing.filter((track) => track.language === language && track.kind === group.kind);
    const already = matches.some((track) => track.fetched) ? "fetched" : matches.length > 0 ? "file" : null;
    return {
      key,
      language,
      languageTag: group.tag,
      kind: group.kind,
      cut: group.cut,
      name,
      trackName: uniqueSubtitleTrackName(name, takenLabels),
      best: files[0]!,
      files,
      already,
    };
  });

  return entries.sort(
    (a, b) =>
      a.name.localeCompare(b.name, uiLanguage, { sensitivity: "base" }) ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
  );
};

/** The metadata service's subtitle search for one film or episode: its TMDB ID only, never the user's file (-14). */
export type SubtitleFetchRequest =
  | { type: "movie"; id: number }
  | { type: "tv"; id: number; season: number; episode: number };

type SubtitleFetchMedia = {
  type: string;
  tmdbId: number | null;
  episodes: ReadonlyArray<{ id: string; seasonNumber: number; episodeNumber: number }>;
  files: ReadonlyArray<{ filename: string; season: number | null; episode: number | null }>;
  subtitleTracks: ReadonlyArray<{
    episodeId: string | null;
    language: string;
    label: string;
    source: string;
    derivedFromSubtitleId?: string | null;
  }>;
};

export type SubtitleFetchTarget = {
  request: SubtitleFetchRequest;
  libraryFileName: string | null;
  existingTracks: SubtitleFetchExistingTrack[];
};

/**
 * What "Get subtitles" needs for a movie (`episodeId` null) or one episode: the search, the file name to rank
 * against, and the subtitles it already has (OCR twins are not tracks of their own). Null without a TMDB ID.
 */
export const subtitleFetchTarget = (media: SubtitleFetchMedia, episodeId: string | null): SubtitleFetchTarget | null => {
  if (media.tmdbId == null) return null;
  const existingTracks = media.subtitleTracks
    .filter((track) => (track.episodeId ?? null) === episodeId && !track.derivedFromSubtitleId)
    .map(({ language, label, source }) => ({ language, label, source }));
  if (!episodeId) {
    if (media.type === "tv") return null;
    return {
      request: { type: "movie", id: media.tmdbId },
      libraryFileName: media.files[0]?.filename ?? null,
      existingTracks,
    };
  }
  const episode = media.episodes.find((item) => item.id === episodeId);
  if (!episode) return null;
  const file = media.files.find((item) => item.season === episode.seasonNumber && item.episode === episode.episodeNumber);
  return {
    request: { type: "tv", id: media.tmdbId, season: episode.seasonNumber, episode: episode.episodeNumber },
    libraryFileName: file?.filename ?? null,
    existingTracks,
  };
};

export type StoreFetchedSubtitleDeps = {
  /** The subtitle file, through the metadata service (`MetadataClient.subtitleFile`). */
  download: (fileId: number) => Promise<{ format: string; content: string }>;
  /** Encrypts and uploads the text to the user's vault, next to the media's other objects; returns its key. */
  upload: (content: string, format: string) => Promise<string>;
  addTrack: (track: { language: string; label: string; objectKey: string; format: string; source: string }) => Promise<void>;
  /** Makes it the film's or show's remembered subtitle (PLAY-SUBGET-19, `subtitlePickPatch`). */
  rememberChoice: (choice: { language: string; format: string }) => Promise<void>;
};

/**
 * Download → encrypt and store → add the track under the entry's name → remember it (PLAY-SUBGET-01, -17, -19).
 * An aborted `signal` (Escape in the player, PLAY-SUBGET-02) stops before the next step: the downloaded file is
 * dropped and no track is added.
 */
export const storeFetchedSubtitle = async (
  entry: SubtitleFetchEntry,
  report: (stage: "downloading" | "saving") => void,
  deps: StoreFetchedSubtitleDeps,
  signal?: AbortSignal
): Promise<void> => {
  report("downloading");
  const file = await deps.download(entry.best.fileId);
  signal?.throwIfAborted();
  report("saving");
  const objectKey = await deps.upload(file.content, file.format);
  signal?.throwIfAborted();
  await deps.addTrack({
    language: entry.language,
    label: entry.trackName,
    objectKey,
    format: file.format,
    source: fetchedSubtitleSource(entry.best.fileId),
  });
  await deps.rememberChoice({ language: entry.language, format: file.format });
};

/** A fetched subtitle of the film or episode, as the library lists it ("Try another version", PLAY-SUBGET-07). */
export type FetchedSubtitleTrack = {
  id: string;
  language: string;
  label: string;
  source: string;
  /** Its stored file in the vault; null or absent when the library has none recorded. */
  objectKey?: string | null;
};

/**
 * "Try another version" (PLAY-SUBGET-07): the file that comes after the one `track` holds, in its entry's ranked list
 * (PLAY-SUBGET-06, -14), or null when none is left. The entry is the one listing the track's file, else the one with
 * the track's language, kind and name ("Spanish 2" reads "Spanish"). A track fetched before its file was recorded held
 * its entry's best file then.
 */
export const nextSubtitleVersion = (
  entries: readonly SubtitleFetchEntry[],
  track: FetchedSubtitleTrack,
  labels: SubtitleFetchLabels
): { entry: SubtitleFetchEntry; file: SubtitleFetchCandidate } | null => {
  const fileId = fetchedSubtitleFileId(track.source);
  const language = subtitleLibraryLanguage(track.language);
  const kind = existingTrackKind(track.label, labels);
  const name = track.label.trim().replace(/\s+\d+$/, "").toLowerCase();
  const entry =
    (fileId !== null ? entries.find((item) => item.files.some((file) => file.fileId === fileId)) : undefined) ??
    entries.find((item) => item.language === language && item.kind === kind && item.name.toLowerCase() === name) ??
    entries.find((item) => item.language === language && item.kind === kind);
  if (!entry) return null;
  const at = fileId === null ? 0 : entry.files.findIndex((file) => file.fileId === fileId);
  const file = at === -1 ? entry.files[0] : entry.files[at + 1];
  return file ? { entry, file } : null;
};

export type ReplaceFetchedSubtitleDeps = StoreFetchedSubtitleDeps & {
  /** Deletes the old track from the library. */
  removeTrack: (trackId: string) => Promise<void>;
  /** Whether a library row still names this stored file (asked once the old track is gone). */
  objectInUse: (objectKey: string) => Promise<boolean>;
  /** Deletes a stored file from the vault (`/storage/delete`). */
  deleteObject: (objectKey: string) => Promise<void>;
  /** A stored file that could not be deleted: logged by the client, never shown (it only costs space). */
  onDeleteFailed?: (objectKey: string, error: unknown) => void;
};

// A stored file nothing in the library names is deleted at once rather than left to the orphan sweep (#2449).
// Failing here never fails the replace: the subtitle is already swapped.
const releaseUnusedObject = async (objectKey: string, deps: ReplaceFetchedSubtitleDeps) => {
  try {
    if (await deps.objectInUse(objectKey)) return;
    await deps.deleteObject(objectKey);
  } catch (error) {
    deps.onDeleteFailed?.(objectKey, error);
  }
};

/**
 * Puts `file` in place of `track` (PLAY-SUBGET-07): download → encrypt and store → add it under the same name and
 * language → drop the old track → delete the old stored file when nothing else names it → remember it, so the film
 * keeps one track of that name and no file is left behind. An aborted `signal` or a failure leaves the old track and
 * its file as they were; a new file stored before that is deleted again.
 */
export const replaceFetchedSubtitle = async (
  track: FetchedSubtitleTrack,
  file: SubtitleFetchCandidate,
  report: (stage: "downloading" | "saving") => void,
  deps: ReplaceFetchedSubtitleDeps,
  signal?: AbortSignal
): Promise<void> => {
  report("downloading");
  const downloaded = await deps.download(file.fileId);
  signal?.throwIfAborted();
  report("saving");
  const objectKey = await deps.upload(downloaded.content, downloaded.format);
  try {
    signal?.throwIfAborted();
    await deps.addTrack({
      language: track.language,
      label: track.label,
      objectKey,
      format: downloaded.format,
      source: fetchedSubtitleSource(file.fileId),
    });
  } catch (error) {
    if (objectKey) await releaseUnusedObject(objectKey, deps);
    throw error;
  }
  await deps.removeTrack(track.id);
  if (track.objectKey && track.objectKey !== objectKey) await releaseUnusedObject(track.objectKey, deps);
  await deps.rememberChoice({ language: track.language, format: downloaded.format });
};
