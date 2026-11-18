/**
 * Editions of a film or an episode (INGS-EDIT-01, LIB-EDIT-01). An edition is one cut with its own timeline
 * (Theatrical, Extended); every film and every episode starts with one unnamed edition. A version is one quality of
 * an edition: a format of one of the edition's files.
 *
 * Shared by every Badger app (REL-FAM-02): what "Which edition?" lists and in which order (PLAY-OPEN-02), the
 * lengths a title's page shows (PLAY-OPEN-04) and the versions the player may use for the chosen edition (PLAY-OPEN-03,
 * PLAY-OPEN-05; the start pick itself is `pickPlayVersion` in `@space/playback-abr/versions`).
 */
import type { MediaDetails, MediaEditionRow, MediaFile, MediaFormat } from "./libraryTypes";
import { EDITION_RESUME_KEY_PREFIX } from "./profileViewing";
import { buildEpisodeResumeValue, isEpisodeCompleted, parseEpisodeResumeValue, resolveResumeCandidateSeconds } from "./playbackResume";

/**
 * Id of the unnamed edition a film (`season`/`episode` null) or an episode starts with. Deterministic, so the
 * LIB-EDIT-02 upgrade gives the same id on every device that upgrades its own copy of the library, and a file sent
 * by a client that predates editions lands in the same edition everywhere. Mirrored in SQL by
 * `DEFAULT_EDITION_ID_SQL` (`@space/library-db-definition/editionDdl`).
 */
export const defaultEditionId = (mediaId: string, season: number | null, episode: number | null): string =>
  `ed-${mediaId}-${season ?? "x"}-${episode ?? "x"}`;

/** Season/episode of an episode; null for a film. */
export type EditionSlot = { season: number; episode: number } | null;

export type MediaEdition = {
  id: string;
  /** The user-facing name (Theatrical, Extended); "" for an unnamed edition. */
  name: string;
  /** Length in seconds: the stored edition length, else the longest of its versions; null when unknown. */
  durationSeconds: number | null;
  files: MediaFile[];
  /** The edition's formats, all qualities (the player's quality menu offers exactly these, PLAY-OPEN-03). */
  versions: MediaFormat[];
};

type EditionSource = Pick<MediaDetails, "id" | "files" | "formats"> & { editions?: MediaEditionRow[] };

const inSlot = (item: { season: number | null; episode: number | null }, slot: EditionSlot): boolean =>
  slot === null ? item.season === null && item.episode === null : item.season === slot.season && item.episode === slot.episode;

/**
 * The editions of one film or episode that can play (at least one version), in the stored order (oldest first). A file
 * from a library or op without editions counts in its unit's unnamed edition, so such a title has one edition.
 */
export const listEditions = (details: EditionSource, slot: EditionSlot): MediaEdition[] => {
  const byId = new Map<string, MediaEdition>();
  for (const row of details.editions ?? []) {
    if (inSlot(row, slot)) {
      byId.set(row.id, { id: row.id, name: row.name, durationSeconds: row.durationSeconds, files: [], versions: [] });
    }
  }
  // A film's files are every file of the title: a film has no season/episode, whatever a file says.
  const files = slot === null ? details.files : details.files.filter((file) => inSlot(file, slot));
  for (const file of files) {
    const id = file.editionId ?? defaultEditionId(details.id, slot?.season ?? null, slot?.episode ?? null);
    let edition = byId.get(id);
    if (!edition) {
      edition = { id, name: "", durationSeconds: null, files: [], versions: [] };
      byId.set(id, edition);
    }
    edition.files.push(file);
  }
  const editions = [...byId.values()];
  for (const edition of editions) {
    const fileIds = new Set(edition.files.map((file) => file.id));
    edition.versions = details.formats.filter((format) => fileIds.has(format.fileId));
    if (edition.durationSeconds === null) {
      for (const version of edition.versions) {
        if (version.durationSeconds !== null && version.durationSeconds > (edition.durationSeconds ?? 0)) {
          edition.durationSeconds = version.durationSeconds;
        }
      }
    }
  }
  return editions.filter((edition) => edition.versions.length > 0);
};

/** Length as PLAY-OPEN-04 writes it: `2h58`, or `58 min` under an hour, rounded down to the minute. */
export const formatEditionLength = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`;
};

/** The order a title's page lists editions in (PLAY-OPEN-04): shortest first, then by name; unknown lengths last. */
export const orderEditionsForPage = <E extends Pick<MediaEdition, "name" | "durationSeconds">>(editions: readonly E[]): E[] =>
  editions
    .map((edition, index) => ({ edition, index }))
    .sort((a, b) => {
      const ad = a.edition.durationSeconds ?? Number.POSITIVE_INFINITY;
      const bd = b.edition.durationSeconds ?? Number.POSITIVE_INFINITY;
      if (ad !== bd) return ad < bd ? -1 : 1;
      return a.edition.name.localeCompare(b.edition.name) || a.index - b.index;
    })
    .map(({ edition }) => edition);

/** Where the user stopped in one edition (PLAY-RESUME-05). */
export type EditionResume = { positionSeconds: number; updatedAt: string };

/**
 * "Which edition?" order (PLAY-OPEN-02): the editions the user is part-way through first, the one watched most
 * recently first; then the others in the page's order (PLAY-OPEN-04). Nothing is preselected: this is only the order.
 */
export const orderEditionsForChooser = <E extends Pick<MediaEdition, "id" | "name" | "durationSeconds">>(
  editions: readonly E[],
  resumeById: Readonly<Record<string, EditionResume | undefined>>,
): E[] => {
  const resumed = editions
    .filter((edition) => resumeById[edition.id])
    .sort((a, b) => resumeById[b.id]!.updatedAt.localeCompare(resumeById[a.id]!.updatedAt));
  return [...resumed, ...orderEditionsForPage(editions.filter((edition) => !resumeById[edition.id]))];
};

/** True when Play must ask "Which edition?" (PLAY-OPEN-02): two or more editions; versions never count. */
export const asksWhichEdition = (editions: readonly unknown[]): boolean => editions.length >= 2;

/** `app_settings` key of an edition's resume spot (PLAY-RESUME-05); a non-main profile's carries its `p:<pid>:` prefix. */
export const editionResumeKey = (editionId: string): string => `${EDITION_RESUME_KEY_PREFIX}${editionId}`;

/**
 * The resume spots "Which edition?" shows (PLAY-OPEN-02, PLAY-RESUME-05), keyed by edition id: only spots past the
 * PLAY-RESUME-01 thresholds and not finished. `getSetting` reads the active profile's settings at the plain key.
 */
export const readEditionResume = (
  editions: ReadonlyArray<Pick<MediaEdition, "id" | "durationSeconds">>,
  getSetting: (key: string) => string | null | undefined,
): Record<string, EditionResume> => {
  const result: Record<string, EditionResume> = {};
  for (const edition of editions) {
    const parsed = parseEpisodeResumeValue(getSetting(editionResumeKey(edition.id)));
    if (!parsed) continue;
    const seconds = resolveResumeCandidateSeconds(
      parsed.progressPct,
      parsed.durationSeconds ?? edition.durationSeconds,
      null,
      parsed.positionSeconds,
    );
    if (seconds === null) continue;
    result[edition.id] = { positionSeconds: seconds, updatedAt: parsed.updatedAt ?? "" };
  }
  return result;
};

/**
 * What a progress save stores at an edition's resume key: the spot, or "" once the edition is finished
 * (PLAY-RESUME-02), so it loses its resume label and goes back to its usual place in the chooser (PLAY-OPEN-02).
 */
export const editionResumeValue = (input: {
  progressPct: number;
  updatedAt: string;
  positionSeconds?: number | null;
  durationSeconds?: number | null;
  creditsStartSeconds?: number | null;
}): string => (isEpisodeCompleted(input) ? "" : buildEpisodeResumeValue(input));

type PlayerDetails = Pick<MediaDetails, "files" | "formats" | "audioTracks" | "subtitleTracks" | "subtitles">;

/**
 * The title as the player sees it once the edition is known: the other editions of the same film or episode
 * (`slotEditions`, from `listEditions`) lose their files, versions and tracks, so the start pick (PLAY-OPEN-05) and the
 * quality menu (PLAY-OPEN-03, PLAY-TRACK-08) never reach them. Other episodes' files stay (next / previous episode);
 * tracks with no file belong to every edition and stay.
 */
export const detailsForEdition = <D extends PlayerDetails>(
  details: D,
  slotEditions: ReadonlyArray<Pick<MediaEdition, "id" | "files">>,
  editionId: string,
): D => {
  const dropped = new Set(
    slotEditions.filter((edition) => edition.id !== editionId).flatMap((edition) => edition.files.map((file) => file.id)),
  );
  const kept = (item: { fileId: string | null }) => item.fileId === null || !dropped.has(item.fileId);
  return {
    ...details,
    files: details.files.filter((file) => !dropped.has(file.id)),
    formats: details.formats.filter(kept),
    audioTracks: details.audioTracks.filter(kept),
    subtitleTracks: details.subtitleTracks.filter(kept),
    subtitles: details.subtitles.filter(kept),
  };
};
