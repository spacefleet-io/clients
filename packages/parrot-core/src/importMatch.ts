/**
 * Matching an import before anything is uploaded (PAR-UP-05, Chris 2026-11-11): each song file is asked about on its
 * own (its title, artist and length; its album tag is only a hint) through our music lookup's `recordings`, which
 * answers recordings with the album each is on. Every album in reach (the albums answered for any file, their other
 * editions the album lookup answers alongside, and the user's own albums) is asked once through `albums` for its full
 * tracklist. A file that matches nothing is left unidentified for the user to identify, keep as is or drop; it is
 * never attached to an album as an extra.
 *
 * Weighing (PAR-META-03, Chris 2026-11-15): a song never matches every piece of our data perfectly, so each place a
 * file could go (an album and one track of it) is scored on all its signals at once, each with a weight
 * (ParrotImportMatchWeights): the title, the length (a soft penalty scaled to the song's length), the track number,
 * the album tag, the original release against a special edition and the folder's evidence for that edition (its bonus
 * tracks, its track count), the lookup's own order (popularity), live / instrumental / remix agreeing, the rest of the
 * folder agreeing, and the user's library (an album with this very slot empty, the edition already owned). The scores
 * turn into a probability-like confidence; only above `threshold` is the match confirmed, else the review shows
 * "Check", and below `noMatchBelow` the file is unidentified. The only hard veto: a file that says live never goes on
 * a studio album.
 *
 * Compilations come first (PAR-META-03 step 1, PAR-LIB-01 item 1): files tagged as one compilation (the compilation
 * flag, or a "Various Artists" album artist, with a shared album name) are matched to that album as a whole, so a
 * soundtrack stays one album instead of scattering its songs over each artist's own records; only the files its
 * tracklist lacks are then matched on their own.
 */
import type { MusicAlbum, MusicAlbumTrack, MusicAlbumsQuery, MusicArtistRef, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import type { ParrotListedTrack } from "@space/parrot-library-db-definition";

/** How many lookups run at once: polite to the shared lookup service, quick enough for a few albums. */
export const IMPORT_LOOKUP_LANES = 3;
/**
 * PAR-UP-11: a lookup the service could not answer (5xx, e.g. a 503 `ticket_store_unavailable` blip) or that never
 * reached it (a network error) is asked again after these waits, so a blip of a few seconds leaves no song unmatched.
 * A lookup refused as too many (429) is asked again as many times, each after the service's Retry-After (these waits
 * when it names none), at most PARROT_LOOKUP_RETRY_AFTER_CAP_MS. Any other refusal (4xx, no ticket) and a stopped
 * lookup are not asked again.
 */
export const PARROT_LOOKUP_RETRY_DELAYS_MS: readonly number[] = [1000, 2500, 5000];
/** The longest a 429's Retry-After makes the import wait before asking again (PAR-UP-11, Chris 2026-11-27). */
export const PARROT_LOOKUP_RETRY_AFTER_CAP_MS = 60_000;
/** A compilation's file longer or shorter than its track by more than this is a match to check (PAR-UP-05). */
export const IMPORT_SURE_DURATION_MS = 5_000;
/** How many recordings one file asks for: enough to see a close competing album. */
const RECORDINGS_PER_FILE = 5;
/** A file with no album to go by asks for more, so the song's original studio album is among them. */
const RECORDINGS_PER_FILE_NO_ALBUM = 10;
/** Our copy's album ids are UUIDs; any other id (an outside source's) the server cannot look up (PAR-META-26). */
const COPY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Whether an id is one of our music copy's (a UUID), never an outside source's (PAR-META-26). */
export const isParrotCopyId = (id: string): boolean => COPY_ID.test(id);

/**
 * The weights of the import's matching (PAR-META-03, Chris 2026-11-15). Every place a file could go starts at `bias`
 * and adds each signal times its weight (a signal is 0 or 1, or a share in between); "this is not the song" scores 0.
 * The confidence of a place is its share of all the file's places and of "not the song" (a softmax). Tuned on a
 * labelled library (the MatchCorpus harness: train split tuned, holdout reported).
 */
export type ParrotImportMatchWeights = {
  bias: number;
  /** The title is the same once case, accents and punctuation are set aside. */
  titleExact: number;
  /** The title is the same only without its bracketed parts ("Nook (Live)" for "Nook"). */
  titleLoose: number;
  /** Per unit of length gap (negative); the unit is max(lengthScaleMs, lengthShare × the song's length), capped at lengthCap units. */
  lengthPenalty: number;
  lengthScaleMs: number;
  lengthShare: number;
  lengthCap: number;
  /** The file or the track has no length. */
  lengthMissing: number;
  /** The file's disc and track number are the slot's. */
  trackNumber: number;
  /** The album tag names this album (without bracketed parts); `albumTagExact` adds when it names it exactly. */
  albumTag: number;
  albumTagExact: number;
  /**
   * The release is the artist's own studio album (a plain official Album), half when the lookup gives no type and its
   * name says nothing else. A special edition of a studio album counts as one: `specialEdition` weighs it apart.
   */
  original: number;
  /** Per decade later than the earliest album the file could go on, capped at one decade (negative). */
  later: number;
  /** A special edition (deluxe, anniversary…) of an original also in reach, with no evidence for it (negative). */
  specialEdition: number;
  /** Evidence for a special edition: the folder holds one of its bonus tracks, a tag names it exactly, or the library owns it. */
  editionEvidence: number;
  /** How well the folder's size fits the album's tracklist (folders of 3 files or more). */
  trackCount: number;
  /** The lookup's answer order, popularity-sorted on the server among otherwise equal answers: 1 / (1 + rank). */
  popularity: number;
  /** A file that does not say live on a live or bootleg release (negative). */
  liveMismatch: number;
  /** The instrumental / remix / acoustic / demo / a cappella / karaoke marks differ (negative). */
  flagMismatch: number;
  /** The share of the folder's other files on this album, counted over at least `folderFull` files. */
  folder: number;
  folderFull: number;
  /** An album the library has, with this slot empty: times the share of the album the library has. */
  libraryGap: number;
  /** The edition of this album the library already has. */
  libraryEdition: number;
  /** The library already has a song on this slot (negative); such a place is never confirmed. */
  libraryFilled: number;
  /** The share of the folder's other files the album has a track for, counted over at least `folderFull` files. */
  folderCover: number;
  /** The share of the folder's other files the album has a track for at their own disc and track number. */
  folderNumbers: number;
  /** The confidence a match is confirmed at; below it the review shows "Check". */
  threshold: number;
  /** Below this confidence that the file is the song at all (its places' shares together), it is unidentified ("No match"). */
  noMatchBelow: number;
};

export const PARROT_IMPORT_MATCH_WEIGHTS: ParrotImportMatchWeights = {
  bias: -5.5,
  titleExact: 5,
  titleLoose: -3.5,
  lengthPenalty: -1,
  lengthScaleMs: 10_000,
  lengthShare: 0.08,
  lengthCap: 12,
  lengthMissing: -2.5,
  trackNumber: 1,
  albumTag: 2.5,
  albumTagExact: 2.5,
  original: 4.5,
  later: -0.5,
  specialEdition: -2.5,
  editionEvidence: 3,
  trackCount: 1,
  popularity: 0.3,
  liveMismatch: -3,
  flagMismatch: -5,
  folder: 4.5,
  folderFull: 4,
  libraryGap: 6.5,
  libraryEdition: 1.5,
  libraryFilled: -3,
  folderCover: 0.5,
  folderNumbers: 0.5,
  threshold: 0.9,
  noMatchBelow: 0.000001,
};

/** One scanned file, as far as matching goes. `albumArtist` and `compilation` mark a compilation's files. */
export type ParrotImportFileQuestion = {
  file: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  disc: number;
  number: number;
  albumArtist?: string;
  compilation?: boolean;
};

/**
 * A file placed on one track (disc, number) of its matched album; `sure` false shows "Check" on the album.
 * `confidence` (0 to 1) is the matcher's; a place the user picked has none. `alsoOn` (PAR-UP-10): the song is also on
 * another album of the same artist, where it was placed before (sure or in doubt) set coherence kept it with its
 * folder's album; the review offers "Keep here / Move there" with that album's track (disc, number). `sure` is false
 * only when the library already has a song on that slot, so Move there asks for a Check; the earlier placement's own
 * doubt does not count, since the user picks Move there as they pick an album in the search (PAR-UP-10).
 */
export type ParrotImportPlacedFile = {
  file: string;
  disc: number;
  number: number;
  sure: boolean;
  confidence?: number;
  alsoOn?: { album: MusicAlbum; tracklistKnown: boolean; disc: number; number: number; sure: boolean };
};

/** An album some files really match, with its full tracklist (`tracklistKnown` false: the album lookup failed). */
export type ParrotImportMatchedAlbum = { album: MusicAlbum; tracklistKnown: boolean; files: ParrotImportPlacedFile[] };

/**
 * Why a file is unidentified: the lookup knows no such song or nothing it knows is likely enough (`no-match`), the
 * file has no title or artist to ask with (`no-names`), its place is taken by a likelier file of the same import
 * (`no-track`, e.g. a second copy of the same song), or the lookup failed (`lookup-failed`: kept as is by default, it
 * never blocks the import).
 */
export type ParrotImportUnidentifiedReason = "no-match" | "no-names" | "no-track" | "lookup-failed";
export type ParrotImportUnidentifiedFile = { file: string; reason: ParrotImportUnidentifiedReason };

export type ParrotImportMatch = { albums: ParrotImportMatchedAlbum[]; unidentified: ParrotImportUnidentifiedFile[] };

/**
 * An album the user's library already has (PAR-META-03, Chris 2026-11-15): its id in the metadata, names, full tracklist
 * and the slots (disc, number) a song of the library fills.
 */
export type ParrotImportLibraryAlbum = {
  /** Null for an album the library stores without one (an import keeps none): it is then the answered album of the same artist and title. */
  musicId: string | null;
  title: string;
  artist: string;
  tracklist: ParrotListedTrack[];
  owned: Array<{ disc: number; number: number }>;
};

export type ParrotImportLookups = {
  recordings: (question: MusicRecordingsQuery) => Promise<{ results: MusicRecording[] }>;
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
  lanes?: number;
  log?: (line: string) => void;
  /** Weights over PARROT_IMPORT_MATCH_WEIGHTS (the tuning harness). */
  weights?: Partial<ParrotImportMatchWeights>;
  /** The albums the user's library has, for filling their empty slots and keeping their edition. */
  library?: ParrotImportLibraryAlbum[];
  /** Waits before asking a failed lookup again (PARROT_LOOKUP_RETRY_DELAYS_MS); tests shorten them. */
  retryDelaysMs?: readonly number[];
  /** The longest wait a 429's Retry-After asks for (PARROT_LOOKUP_RETRY_AFTER_CAP_MS); tests shorten it. */
  retryAfterCapMs?: number;
  /** A stopped match ("Import as is") ends its waits at once. */
  signal?: AbortSignal;
};

/** A 5xx answer, a 429 refusal, or a fetch that never got one (fetch's TypeError): worth asking again. */
const lookupWorthRetrying = (error: unknown) => {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status >= 500 || status === 429 : error instanceof TypeError;
};

/** The wait before asking again: a 429's Retry-After (capped), else this try's own wait. */
const retryWaitMs = (error: unknown, fallbackMs: number, capMs: number) => {
  const refusal = error as { status?: unknown; retryAfterSeconds?: unknown } | null;
  if (refusal?.status !== 429 || typeof refusal.retryAfterSeconds !== "number") return fallbackMs;
  return Math.min(Math.max(0, refusal.retryAfterSeconds * 1000), capMs);
};

const pause = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

/** The lookups with each question asked again on a 5xx, a 429 (after its Retry-After) or a network error (PAR-UP-11). */
const retryingLookups = (lookups: ParrotImportLookups, log: (line: string) => void): ParrotImportLookups => {
  const delays = lookups.retryDelaysMs ?? PARROT_LOOKUP_RETRY_DELAYS_MS;
  const capMs = lookups.retryAfterCapMs ?? PARROT_LOOKUP_RETRY_AFTER_CAP_MS;
  const retrying =
    <Q, A>(what: string, ask: (question: Q) => Promise<A>) =>
    async (question: Q): Promise<A> => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await ask(question);
        } catch (error) {
          if (attempt >= delays.length || !lookupWorthRetrying(error) || lookups.signal?.aborted) throw error;
          const waitMs = retryWaitMs(error, delays[attempt]!, capMs);
          log(`[import-match] ${what} lookup retry ${attempt + 1}/${delays.length} in ${waitMs}ms: ${errorText(error)}`);
          await pause(waitMs, lookups.signal);
        }
      }
    };
  return { ...lookups, recordings: retrying("recordings", lookups.recordings), albums: retrying("albums", lookups.albums) };
};

/**
 * Titles and names compared without case, accents, punctuation or spacing ("Don't Stop" = "dont stop"). A name made
 * only of symbols (Eli Sharrow's "≈", "+-=≈×") keeps its symbols, so it never equals every other such name.
 */
export const parrotComparableName = (title: string): string => {
  const folded = title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  return folded.replace(/[^\p{L}\p{N}]/gu, "") || folded.replace(/\s/gu, "");
};

/** A title without its bracketed parts ("Nook (Live)" → "nook"), for a looser pairing; a title that is all brackets stays whole. */
const baseTitle = (title: string): string => parrotComparableName(title.replace(/\s*[([][^)\]]*[)\]]/gu, " ")) || parrotComparableName(title);

/**
 * A credit's names (PAR-META-29): the credit itself and, for a joined credit ("Ella Fitzgerald & Louis Armstrong",
 * "A feat. B"), each artist it names, so a duo's file finds the album our copy credits to both artists apart.
 */
const creditNames = (credit: string): string[] => [credit, ...credit.split(/\s*(?:&|,|\band\b|\bwith\b|\bfeat\.?|\bft\.|\bfeaturing\b)\s*/iu)];

const LIVE = /\blive\b/iu;
/** A concert bootleg's name, as the metadata lists them: "2007-06-24: The Lantern Room, Millbrook, NC, USA". */
const CONCERT = /^\d{4}-\d{2}-\d{2}\b|\b(?:bootleg|unplugged|in concert)\b/iu;
/** A live or bootleg album or recording: never preferred for a file that says studio. */
const isLive = (...names: string[]) => names.some((name) => LIVE.test(name) || CONCERT.test(name));

/** The album artist names taggers give a compilation (compared as parrotComparableName). */
const VARIOUS_ARTISTS: Record<string, true> = {
  variousartists: true,
  various: true,
  va: true,
  variousartist: true,
  artistesdivers: true,
  verschiedeneinterpreten: true,
  variosartistas: true,
  artistivari: true,
};
/** The metadata's name for the album artist of a compilation. */
const VARIOUS_ARTISTS_NAME = "Various Artists";
const UNKNOWN_ALBUM = "unknownalbum";

/** The file's album tag when it names an album: not empty, not the scan's "Unknown album" placeholder. */
const albumHint = (album: string): string => {
  const name = album.trim();
  return name && parrotComparableName(name) !== UNKNOWN_ALBUM ? name : "";
};

/** An album name that says reissue, best-of, soundtrack or the like, for an answer whose release type is not known. */
const NOT_STUDIO = /\b(?:anniversary|deluxe|expanded|remaster(?:ed)?|edition|greatest hits|best of|collection|anthology|essentials|soundtrack|live)\b/iu;
/** An album name that says it is an edition of an album (deluxe, anniversary, expanded, remastered…). */
const EDITION = /\b(?:anniversary|deluxe|expanded|remaster(?:ed)?|edition)\b/iu;

/**
 * How surely an album is the artist's own studio album (PAR-META-03, PAR-META-13 item 2): 2 when the lookup says it
 * is a plain Album (no secondary type: compilation, soundtrack, live, remix, DJ-mix) from an official release, 0 when
 * it says otherwise; an answer without the release type (an older lookup, an album only some of the metadata knows)
 * gets 1 unless its name says live, bootleg, reissue, best-of or soundtrack.
 */
const studioRank = (album: { title: string; kind?: string | null; official?: boolean }): number => {
  if (album.kind != null) return album.kind.toLowerCase() === "album" && album.official !== false ? 2 : 0;
  return isLive(album.title) || NOT_STUDIO.test(album.title) ? 0 : 1;
};

/** The marks that make another take of a song (compared lowercase, "a cappella" as "acappella"). */
const FLAG = /\b(instrumental|a ?cappella|remix|acoustic|demo|karaoke)\b/giu;
const flagsOf = (...names: string[]): string =>
  [...new Set(names.flatMap((name) => [...name.matchAll(FLAG)].map((found) => found[1]!.toLowerCase().replace(" ", ""))))].sort().join(",");

/** Runs `work` on every item, `lanes` at a time. */
const inLanes = async <T>(items: T[], lanes: number, work: (item: T) => Promise<void>): Promise<void> => {
  const queue = [...items];
  const lane = async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  };
  await Promise.all(Array.from({ length: Math.min(lanes, queue.length) }, lane));
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A recording the lookup answered for a file, with its album, and its place in the lookup's answer (`rank`, 0 first). */
type Answer = { recording: MusicRecording & { album: NonNullable<MusicRecording["album"]> }; rank: number };

/**
 * The id an album answer is told apart by (PAR-META-19): its id in the metadata (opaque), else its name.
 */
export const parrotAlbumKey = (album: { id: string | null; title: string }): string => album.id ?? `title:${parrotComparableName(album.title)}`;

type FileAnswer =
  | { kind: "found"; answers: Answer[]; hinted: boolean }
  | { kind: "none" }
  | { kind: "no-names" }
  | { kind: "failed"; error: string };

/**
 * Asks the lookup about one file: its title and artist, with its album tag and length as hints. The answers kept are
 * the recordings of the same title (or the same without bracketed parts), in the lookup's order, which the weighing
 * reads as popularity.
 */
const answerFile = async (question: ParrotImportFileQuestion, lookups: ParrotImportLookups): Promise<FileAnswer> => {
  const title = question.title.trim();
  const artist = question.artist.trim();
  if (!title || !artist) return { kind: "no-names" };
  // Without an album, the file's length is no question to ask: it would pull the lookup towards whichever edition's
  // take happens to be closest (a short or cut file) instead of the song's own album; it still weighs below.
  const ask = (album: string) =>
    lookups.recordings({
      artist,
      title,
      ...(album ? { album } : {}),
      ...(album && question.durationMs != null ? { durationMs: question.durationMs } : {}),
      limit: album ? RECORDINGS_PER_FILE : RECORDINGS_PER_FILE_NO_ALBUM,
    });
  let album = albumHint(question.album);
  let results: MusicRecording[];
  try {
    ({ results } = await ask(album));
  } catch (error) {
    return { kind: "failed", error: errorText(error) };
  }
  // An album the lookup does not have the song on is no hint (a folder named "Loose" or "New music", a tag naming a
  // playlist): the song is asked again as a song with no album, so it lands on the artist's original studio album.
  if (album && !results.some((recording) => recording.album && baseTitle(recording.album.title) === baseTitle(album))) {
    try {
      ({ results } = await ask(""));
      album = "";
    } catch {
      // The first answer still stands.
    }
  }
  const answers = results.flatMap((recording, rank): Answer[] =>
    recording.album && baseTitle(recording.title) === baseTitle(question.title) ? [{ recording: { ...recording, album: recording.album }, rank }] : []
  );
  return answers.length > 0 ? { kind: "found", answers, hinted: album !== "" } : { kind: "none" };
};

/** An album known only through its recordings, when its own lookup failed: the tracks the files sit on. */
const albumFromRecordings = (answers: Answer[]): MusicAlbum => {
  const first = answers[0]!.recording;
  const tracks = new Map<string, MusicAlbumTrack>();
  for (const { recording } of answers) {
    const disc = recording.album.disc ?? 1;
    const number = recording.album.trackNumber ?? 0;
    tracks.set(`${disc}:${number}:${recording.id}`, {
      disc,
      number,
      title: recording.title,
      durationMs: recording.durationMs,
      id: recording.id,
    });
  }
  return {
    id: first.album.id,
    title: first.album.title,
    year: first.album.year,
    kind: first.album.kind ?? null,
    artist: first.artist,
    tracks: [...tracks.values()].sort((a, b) => a.disc - b.disc || a.number - b.number),
  };
};

/** The track of `album` a recording is: same recording id, else same place, else same title. */
const trackForRecording = (recording: Answer["recording"], tracks: MusicAlbumTrack[]): MusicAlbumTrack | undefined =>
  tracks.find((track) => track.id !== null && track.id === recording.id) ??
  tracks.find((track) => recording.album.trackNumber !== null && track.number === recording.album.trackNumber && track.disc === (recording.album.disc ?? 1) && baseTitle(track.title) === baseTitle(recording.title)) ??
  tracks.find((track) => parrotComparableName(track.title) === parrotComparableName(recording.title)) ??
  tracks.find((track) => baseTitle(track.title) === baseTitle(recording.title));

/** A compilation the files were matched to as a whole: its album, the files placed on it and its tracks still free. */
type WholeAlbum = { album: MusicAlbum; placed: ParrotImportPlacedFile[]; free: Set<MusicAlbumTrack> };

/**
 * PAR-META-03 step 1 for compilations (PAR-LIB-01 item 1): files tagged as one compilation (the compilation flag, or
 * a "Various Artists" album artist) that share an album name are looked up as that album, by its album artist, and
 * paired with its tracklist by title. The album is kept when at least half of its files sit on it; a live or bootleg
 * album is never taken for files that say studio. Each album is keyed like parrotAlbumKey.
 */
const matchCompilations = async (
  questions: ParrotImportFileQuestion[],
  lookups: ParrotImportLookups,
  lanes: number,
  log: (line: string) => void
): Promise<Map<string, WholeAlbum>> => {
  const groups = new Map<string, { artist: string; album: string; files: ParrotImportFileQuestion[] }>();
  for (const question of questions) {
    const album = question.album.trim();
    const albumArtist = question.albumArtist?.trim() ?? "";
    const various = VARIOUS_ARTISTS[parrotComparableName(albumArtist)] === true;
    if (!question.title.trim() || !albumHint(album) || !(question.compilation || various)) continue;
    const artist = various || !albumArtist ? VARIOUS_ARTISTS_NAME : albumArtist;
    const key = `${parrotComparableName(artist)}\u0000${parrotComparableName(album)}`;
    const group = groups.get(key) ?? { artist, album, files: [] };
    group.files.push(question);
    groups.set(key, group);
  }
  const found = new Map<string, WholeAlbum>();
  await inLanes([...groups.values()], lanes, async ({ artist, album, files }) => {
    let results: MusicAlbum[];
    try {
      ({ results } = await lookups.albums({ artist, album, limit: 5 }));
    } catch (error) {
      log(`[import-match] compilation lookup failed for ${artist} / ${album}: ${errorText(error)}; matching its ${files.length} file(s) one by one`);
      return;
    }
    const live = files.some((file) => isLive(file.title, file.album));
    let best: WholeAlbum | undefined;
    for (const candidate of results) {
      if (baseTitle(candidate.title) !== baseTitle(album) || (!live && isLive(candidate.title, candidate.kind ?? ""))) continue;
      const free = new Set(candidate.tracks);
      const placed: ParrotImportPlacedFile[] = [];
      for (const file of files) {
        const title = parrotComparableName(file.title);
        const open = [...free];
        const track =
          open.find((option) => parrotComparableName(option.title) === title && option.disc === file.disc && option.number === file.number) ??
          open.find((option) => parrotComparableName(option.title) === title) ??
          open.find((option) => baseTitle(option.title) === baseTitle(file.title));
        if (!track) continue;
        free.delete(track);
        const durationOff = file.durationMs != null && track.durationMs != null ? Math.abs(file.durationMs - track.durationMs) : null;
        const sure = parrotComparableName(track.title) === title && (durationOff === null || durationOff <= IMPORT_SURE_DURATION_MS);
        placed.push({ file: file.file, disc: track.disc, number: track.number, sure });
      }
      if (placed.length * 2 >= files.length && placed.length > (best?.placed.length ?? 0)) best = { album: candidate, placed, free };
    }
    if (!best) {
      log(`[import-match] compilation ${artist} / ${album} not found as a whole; matching its ${files.length} file(s) one by one`);
      return;
    }
    log(`[import-match] compilation ${artist} / ${album}: ${best.placed.length} of ${files.length} file(s) on ${parrotAlbumKey(best.album)}`);
    found.set(parrotAlbumKey(best.album), best);
  });
  return found;
};

/** A file the lookup answered: the answers of its title, and whether its album tag held as a hint (`hinted`). */
type AnsweredFile = { question: ParrotImportFileQuestion; answers: Answer[]; hinted: boolean };

/** The folder a file sits in ("" for a bare name): the batch whose album a file should fit (PAR-META-03). */
const folderOf = (file: string): string => file.slice(0, Math.max(0, file.lastIndexOf("/"), file.lastIndexOf("\\")));

/** The track of `title` among `tracks`: same title once case and punctuation are set aside, else without bracketed parts. */
export const parrotTrackByTitle = <Track extends { title: string }>(title: string, tracks: Iterable<Track>): Track | undefined => {
  const open = [...tracks];
  return open.find((track) => parrotComparableName(track.title) === parrotComparableName(title)) ?? open.find((track) => baseTitle(track.title) === baseTitle(title));
};

/** The weighed signals of a place (ParrotImportMatchWeights), all but the folder's, which is weighed last. */
const SIGNALS = [
  "titleExact",
  "titleLoose",
  "lengthPenalty",
  "lengthMissing",
  "trackNumber",
  "albumTag",
  "albumTagExact",
  "original",
  "later",
  "specialEdition",
  "editionEvidence",
  "trackCount",
  "popularity",
  "liveMismatch",
  "flagMismatch",
  "libraryGap",
  "libraryEdition",
  "libraryFilled",
  "folderCover",
  "folderNumbers",
] as const;
type Signal = (typeof SIGNALS)[number];

/** An album in reach of the import (`tracklistKnown` false: known only through recordings; `official` as the lookup said). */
type ReachAlbum = { album: MusicAlbum; tracklistKnown: boolean; official?: boolean };

/** One place a file could go: a track of an album, its signals, its score without the folder (`base`) and with it. */
type Place = { key: string; track: MusicAlbumTrack; signals: Record<Signal, number>; base: number; score: number; filled: boolean };

/** Each score's share of all of them and of "not the song" (score 0). */
const confidences = (scores: number[]): number[] => {
  const top = Math.max(0, ...scores);
  const weights = scores.map((score) => Math.exp(score - top));
  const total = Math.exp(-top) + weights.reduce((sum, weight) => sum + weight, 0);
  return weights.map((weight) => weight / total);
};

/** How many times the folder's agreement is weighed again with the confidences it led to. */
const FOLDER_ROUNDS = 2;

/**
 * Set coherence (PAR-UP-10, album first): a folder of at least COHERENT_FOLDER_MIN files, at least COHERENT_SHARE of
 * them placed sure on one album, is that album; its other files, unsure or sure elsewhere or unidentified, go on its
 * free tracks when their title and length fit one (parrotImportLooseTracks). A song placed elsewhere is usually also on
 * a single, a collection or another edition (Chris 2026-11-27: one album per folder); it keeps that album as `alsoOn`.
 * 0.6 asks for a clear majority: Hybrid Theory with three of twelve also elsewhere (0.75) holds, a folder split half
 * and half does not. The pairing (a free track, a title within a few letters, the track's length) is what keeps an
 * unrelated song off the album.
 */
const COHERENT_FOLDER_MIN = 4;
const COHERENT_SHARE = 0.6;

/**
 * Matches compilations as a whole first (matchCompilations), then asks about every other file on its own, a few
 * lookups at a time, then asks every album in reach once for its full tracklist. Each file's places are weighed
 * (ParrotImportMatchWeights, PAR-META-03), the folder's agreement weighed in a few rounds, and the files are placed
 * likeliest first, each track taken once: a file whose place a likelier file took is `no-track`. Never throws: a
 * failed lookup leaves that file `lookup-failed`, a failed album lookup keeps the album known through its recordings
 * (`tracklistKnown` false).
 */
export const matchParrotImport = async (questions: ParrotImportFileQuestion[], asked: ParrotImportLookups): Promise<ParrotImportMatch> => {
  const lanes = asked.lanes ?? IMPORT_LOOKUP_LANES;
  const log = asked.log ?? (() => undefined);
  const lookups = retryingLookups(asked, log);
  const weights: ParrotImportMatchWeights = { ...PARROT_IMPORT_MATCH_WEIGHTS, ...lookups.weights };
  const whole = await matchCompilations(questions, lookups, lanes, log);
  const placedWhole = new Set([...whole.values()].flatMap((found) => found.placed.map((placed) => placed.file)));
  const alone = questions.filter((question) => !placedWhole.has(question.file));
  const answered = new Map<string, FileAnswer>();
  await inLanes(alone, lanes, async (question) => {
    const answer = await answerFile(question, lookups);
    answered.set(question.file, answer);
    if (answer.kind === "failed") log(`[import-match] lookup failed for ${question.file}: ${answer.error}`);
  });
  const files: AnsweredFile[] = [];
  const unidentified: ParrotImportUnidentifiedFile[] = [];
  for (const question of alone) {
    const answer = answered.get(question.file)!;
    if (answer.kind === "found") files.push({ question, answers: answer.answers, hinted: answer.hinted });
    else unidentified.push({ file: question.file, reason: answer.kind === "failed" ? "lookup-failed" : answer.kind === "no-names" ? "no-names" : "no-match" });
  }

  // The albums in reach: those answered for any file, and the library's albums of the same artists with one of the
  // files' titles. An answered album with our copy's id is first asked by it (PAR-META-03): that answer is our copy's
  // alone, so a compilation or DJ set a song sits on never falls to the slow, paced name search of an outside source
  // (PAR-META-19). Only an album credited to the song's own artist is then also asked by name, which finds it in our
  // copy and answers its other editions alongside; an album without an id and the library's are asked by name alone.
  // An album only an outside source knows (its id is not our copy's) is not asked at all (PAR-META-26): the server
  // cannot look it up by that id, so the ask would be one paced outside album search per candidate; it is kept from
  // its recordings below.
  const reach = new Map<string, ReachAlbum>();
  for (const [key, found] of whole) reach.set(key, { album: found.album, tracklistKnown: true });
  const official = new Map<string, boolean>();
  const byId = new Map<string, MusicAlbumsQuery>();
  const byName = new Map<string, MusicAlbumsQuery>();
  const outside = new Set<string>();
  const askByName = (artist: string, album: string) => byName.set(`${parrotComparableName(artist)}\u0000${parrotComparableName(album)}`, { artist, album, limit: 5 });
  for (const file of files) {
    for (const { recording } of file.answers) {
      const key = parrotAlbumKey(recording.album);
      if (recording.album.official !== undefined) official.set(key, recording.album.official);
      if (whole.has(key)) continue;
      if (!recording.album.id) askByName(recording.artist.name, recording.album.title);
      else if (COPY_ID.test(recording.album.id)) byId.set(recording.album.id, { artist: recording.artist.name, album: recording.album.title, id: recording.album.id });
      else outside.add(recording.album.id);
    }
  }
  const ownArtists = (file: AnsweredFile) => [file.question.artist, file.question.albumArtist ?? "", ...file.answers.map((answer) => answer.recording.artist.name)].flatMap(creditNames);
  const importArtists = new Set(files.flatMap(ownArtists).map(parrotComparableName).filter(Boolean));
  const library = new Map<string, ParrotImportLibraryAlbum>();
  for (const owned of lookups.library ?? []) {
    if (!importArtists.has(parrotComparableName(owned.artist)) || !files.some((file) => parrotTrackByTitle(file.question.title, owned.tracklist))) continue;
    library.set(parrotAlbumKey({ id: owned.musicId, title: owned.title }), owned);
    askByName(owned.artist, owned.title);
  }
  const askAlbums = (queries: MusicAlbumsQuery[]) =>
    inLanes(queries, lanes, async (query) => {
      try {
        const { results } = await lookups.albums(query);
        for (const album of results) if (!reach.has(parrotAlbumKey(album))) reach.set(parrotAlbumKey(album), { album, tracklistKnown: true });
        if (!query.id) return;
        const artist = parrotComparableName(query.artist);
        const credited = results.some((album) => [album.artist, ...(album.artists ?? [])].some((one) => parrotComparableName(one.name) === artist));
        if (credited) askByName(query.artist, query.album);
      } catch (error) {
        log(`[import-match] album lookup failed for ${query.artist} / ${query.album}${query.id ? ` (${query.id})` : ""}: ${errorText(error)}`);
      }
    });
  const libraryAndNameless = byName.size;
  await askAlbums([...byId.values()]);
  log(
    `[import-match] album lookups: ${byId.size} by id, then ${byName.size - libraryAndNameless} by name (the song's own artist's), ${libraryAndNameless} by name only, ${outside.size} with an outside id not asked`
  );
  await askAlbums([...byName.values()]);
  const unknown = new Map<string, Answer[]>();
  for (const file of files) {
    for (const answer of file.answers) {
      const key = parrotAlbumKey(answer.recording.album);
      if (!reach.has(key)) unknown.set(key, [...(unknown.get(key) ?? []), answer]);
    }
  }
  // An album known only from its recordings that is one our copy answered (PAR-META-30: an outside "Ella and Louis"
  // and our copy's, same title, year and artists, every song of it on ours) is that album: its answers go to ours, so
  // one album never shows as two cards under two keys.
  const sameAs = new Map<string, string>();
  const artistsOf = (album: MusicAlbum) => new Set(parrotAlbumArtists(album).flatMap((artist) => creditNames(artist.name)).map(parrotComparableName).filter(Boolean));
  for (const [key, list] of unknown) {
    const album = albumFromRecordings(list);
    const artists = artistsOf(album);
    const copy = [...reach].find(
      ([, entry]) =>
        entry.tracklistKnown &&
        entry.album.id !== null &&
        COPY_ID.test(entry.album.id) &&
        parrotComparableName(entry.album.title) === parrotComparableName(album.title) &&
        (entry.album.year == null || album.year == null || entry.album.year === album.year) &&
        [...artistsOf(entry.album)].some((artist) => artists.has(artist)) &&
        list.every((answer) => trackForRecording(answer.recording, entry.album.tracks))
    );
    if (!copy) continue;
    sameAs.set(key, copy[0]);
    log(`[import-match] album ${key} (${album.title}) is ${copy[0]}`);
  }
  for (const [key, list] of unknown) {
    if (sameAs.has(key)) continue;
    log(`[import-match] album ${key} (${list[0]!.recording.album.title}) not in its own lookup; kept from its recordings`);
    reach.set(key, { album: albumFromRecordings(list), tracklistKnown: false });
  }
  // A library album stored without its id is the answered album of the same artist and title whose
  // tracklist it shares most; with none answered it stays an album of its own.
  for (const [key, owned] of [...library]) {
    if (owned.musicId) continue;
    const titles = new Set(owned.tracklist.map((track) => parrotComparableName(track.title)));
    const fit = (album: MusicAlbum) =>
      album.tracks.filter((track) => titles.has(parrotComparableName(track.title))).length - Math.abs(album.tracks.length - owned.tracklist.length);
    const named = (album: MusicAlbum) =>
      parrotComparableName(album.title) === parrotComparableName(owned.title) && parrotComparableName(album.artist.name) === parrotComparableName(owned.artist);
    const best = [...reach].filter(([, entry]) => named(entry.album)).sort(([, a], [, b]) => fit(b.album) - fit(a.album))[0];
    if (!best || library.has(best[0])) continue;
    library.delete(key);
    library.set(best[0], owned);
    log(`[import-match] library album ${owned.title} is ${best[0]}`);
  }
  for (const [key, owned] of library) {
    if (reach.has(key)) continue;
    const tracks = owned.tracklist.map((track) => ({ ...track, id: null }));
    reach.set(key, { album: { id: owned.musicId, title: owned.title, year: null, kind: null, artist: { id: null, name: owned.artist }, tracks }, tracklistKnown: true });
  }
  for (const [key, entry] of reach) entry.official = official.get(key);
  const rankOf = (key: string) => {
    const { album, official: isOfficial } = reach.get(key)!;
    return studioRank({ title: album.title, kind: album.kind, ...(isOfficial !== undefined ? { official: isOfficial } : {}) });
  };

  // Special editions (a deluxe, an anniversary, a later or non-studio release named like an original studio album of
  // the same artist in reach) and their bonus tracks: the titles none of those originals has.
  const families = new Map<string, string[]>();
  for (const [key, { album }] of reach) {
    const family = `${parrotComparableName(album.artist.name)}\u0000${baseTitle(album.title)}`;
    families.set(family, [...(families.get(family) ?? []), key]);
  }
  const bonusOf = new Map<string, { bonus: Set<string>; ownName: boolean; studio: boolean }>();
  for (const keys of families.values()) {
    const originals = keys.filter((key) => rankOf(key) === 2 && !NOT_STUDIO.test(reach.get(key)!.album.title));
    for (const key of keys) {
      const album = reach.get(key)!.album;
      const later = (other: string) => (album.year ?? Number.MAX_SAFE_INTEGER) > (reach.get(other)!.album.year ?? Number.MAX_SAFE_INTEGER);
      const of = originals.filter((other) => other !== key && (rankOf(key) < 2 || NOT_STUDIO.test(album.title) || later(other)));
      if (of.length === 0) continue;
      const plain = new Set(of.flatMap((other) => reach.get(other)!.album.tracks.map((track) => baseTitle(track.title))));
      // A tag names this edition only when its name is not also an original's (Hollerin' Fox's 1962 album and a later compilation of the same name).
      const ownName = of.every((other) => parrotComparableName(reach.get(other)!.album.title) !== parrotComparableName(album.title));
      bonusOf.set(key, {
        bonus: new Set(album.tracks.map((track) => baseTitle(track.title)).filter((title) => !plain.has(title))),
        ownName,
        // An edition counts as the studio album (the metadata types an anniversary edition Album + Compilation); a
        // compilation or live album merely bearing the same name does not.
        studio: album.kind == null || album.kind.toLowerCase() === "album" || (ownName && EDITION.test(album.title)),
      });
    }
  }

  // Each folder: its size, its titles and its album tags (the evidence for an edition), its files by folder.
  const folders = new Map<string, { size: number; titles: Set<string>; tags: Set<string> }>();
  for (const question of questions) {
    const folder = folders.get(folderOf(question.file)) ?? { size: 0, titles: new Set<string>(), tags: new Set<string>() };
    folder.size += 1;
    folder.titles.add(baseTitle(question.title));
    if (albumHint(question.album)) folder.tags.add(parrotComparableName(question.album));
    folders.set(folderOf(question.file), folder);
  }

  // Every place each file could go, weighed on everything but its folder.
  const liveFiles = new Set<string>();
  const places = new Map<AnsweredFile, Place[]>();
  for (const file of files) {
    const question = file.question;
    const tag = albumHint(question.album);
    const hint = file.hinted ? tag : "";
    // A file says live by its names, or by an album tag naming only live releases (Meltway Hamburg): it never goes on a
    // studio album. A tag a studio album also bears (Teddy Reeds' album and its live release of the same name) says nothing.
    const tagged = hint === "" ? [] : [...reach.values()].filter(({ album }) => baseTitle(album.title) === baseTitle(hint));
    const live = isLive(question.title, hint) || (tagged.length > 0 && tagged.every(({ album }) => isLive(album.title, album.kind ?? "")));
    if (live) liveFiles.add(question.file);
    const folder = folders.get(folderOf(question.file))!;
    const options = new Map<string, { key: string; track: MusicAlbumTrack; rank: number | null; title: string; durationMs: number | null }>();
    for (const answer of file.answers) {
      const key = sameAs.get(parrotAlbumKey(answer.recording.album)) ?? parrotAlbumKey(answer.recording.album);
      const track = trackForRecording(answer.recording, reach.get(key)!.album.tracks);
      const id = `${key}|${track?.disc}:${track?.number}`;
      if (track && !options.has(id)) options.set(id, { key, track, rank: answer.rank, title: answer.recording.title, durationMs: answer.recording.durationMs ?? track.durationMs });
    }
    const own = new Set(ownArtists(file).map(parrotComparableName).filter(Boolean));
    for (const [key, { album, tracklistKnown }] of reach) {
      const track = tracklistKnown ? parrotTrackByTitle(question.title, album.tracks) : undefined;
      if (!track || !parrotAlbumArtists(album).some((artist) => own.has(parrotComparableName(artist.name)))) continue;
      const id = `${key}|${track.disc}:${track.number}`;
      if (!options.has(id)) options.set(id, { key, track, rank: null, title: track.title, durationMs: track.durationMs });
    }
    const years = [...options.values()].flatMap(({ key }) => (reach.get(key)!.album.year != null ? [reach.get(key)!.album.year!] : []));
    const earliest = years.length > 0 ? Math.min(...years) : null;
    const list: Place[] = [];
    for (const { key, track, rank, title, durationMs } of options.values()) {
      const album = reach.get(key)!.album;
      const albumLive = isLive(title, album.title, album.kind ?? "");
      if (live && !albumLive) continue;
      const exact = parrotComparableName(title) === parrotComparableName(question.title) || parrotComparableName(track.title) === parrotComparableName(question.title);
      const gap = question.durationMs != null && durationMs != null ? Math.abs(question.durationMs - durationMs) : null;
      const bonus = bonusOf.get(key);
      const evidence = bonus !== undefined && ([...folder.titles].some((one) => bonus.bonus.has(one)) || (bonus.ownName && folder.tags.has(parrotComparableName(album.title))) || library.has(key));
      const owned = library.get(key);
      const filled = owned?.owned.some((slot) => slot.disc === track.disc && slot.number === track.number) ?? false;
      const signals: Record<Signal, number> = {
        titleExact: exact ? 1 : 0,
        titleLoose: exact ? 0 : 1,
        lengthPenalty: gap === null || durationMs === null ? 0 : Math.min(gap / Math.max(weights.lengthScaleMs, weights.lengthShare * durationMs), weights.lengthCap),
        lengthMissing: gap === null ? 1 : 0,
        trackNumber: question.number > 0 && track.number === question.number && track.disc === (question.disc || 1) ? 1 : 0,
        albumTag: tag && baseTitle(tag) === baseTitle(album.title) ? 1 : 0,
        albumTagExact: tag && parrotComparableName(tag) === parrotComparableName(album.title) ? 1 : 0,
        original: (bonus?.studio ? 2 : rankOf(key)) / 2,
        later: earliest !== null && album.year != null ? Math.min(1, (album.year - earliest) / 10) : 0,
        specialEdition: bonus !== undefined && !evidence ? 1 : 0,
        editionEvidence: evidence ? 1 : 0,
        trackCount: folder.size >= 3 && album.tracks.length > 0 ? 1 - Math.min(1, Math.abs(folder.size - album.tracks.length) / Math.max(folder.size, album.tracks.length)) : 0,
        popularity: rank === null ? 0 : 1 / (1 + rank),
        liveMismatch: !live && albumLive ? 1 : 0,
        flagMismatch: flagsOf(question.title) === flagsOf(title, track.title, album.title, album.kind ?? "") ? 0 : 1,
        libraryGap: owned && !filled && owned.tracklist.length > 0 ? owned.owned.length / owned.tracklist.length : 0,
        libraryEdition: owned ? 1 : 0,
        libraryFilled: filled ? 1 : 0,
        folderCover: 0,
        folderNumbers: 0,
      };
      const base = SIGNALS.reduce((sum, name) => sum + weights[name] * signals[name], weights.bias);
      list.push({ key, track, signals, base, score: base, filled });
    }
    places.set(file, list);
  }

  // The folder's agreement: the confidence the folder's other files put on each album, over at least folderFull files
  // (a compilation's files placed as a whole count fully for theirs), weighed again with the confidences it leads to.
  const wholeIn = new Map<string, Map<string, number>>();
  for (const [key, found] of whole) {
    for (const placed of found.placed) {
      const folder = wholeIn.get(folderOf(placed.file)) ?? new Map<string, number>();
      folder.set(key, (folder.get(key) ?? 0) + 1);
      wholeIn.set(folderOf(placed.file), folder);
    }
  }
  const others = new Map<string, number>();
  for (const file of files) others.set(folderOf(file.question.file), (others.get(folderOf(file.question.file)) ?? 0) + 1);
  for (const [folder, keys] of wholeIn) others.set(folder, (others.get(folder) ?? 0) + [...keys.values()].reduce((sum, count) => sum + count, 0));
  // The folder's coverage: how many of the folder's other files the album has a track for at all, and how many at their
  // own track number. Unlike the agreement below it does not feed on the files' own preferences, so a folder that is
  // one compilation (each song also on its own original album) still tells that compilation apart.
  const covering = new Map<string, Map<string, { any: Set<AnsweredFile>; numbered: Set<AnsweredFile> }>>();
  for (const [file, list] of places) {
    const folder = covering.get(folderOf(file.question.file)) ?? new Map<string, { any: Set<AnsweredFile>; numbered: Set<AnsweredFile> }>();
    for (const place of list) {
      const album = folder.get(place.key) ?? { any: new Set<AnsweredFile>(), numbered: new Set<AnsweredFile>() };
      album.any.add(file);
      if (place.signals.trackNumber > 0) album.numbered.add(file);
      folder.set(place.key, album);
    }
    covering.set(folderOf(file.question.file), folder);
  }
  for (const [file, list] of places) {
    const folder = folderOf(file.question.file);
    const count = Math.max(others.get(folder)! - 1, weights.folderFull);
    for (const place of list) {
      const album = covering.get(folder)!.get(place.key)!;
      const wholeHere = wholeIn.get(folder)?.get(place.key) ?? 0;
      place.signals.folderCover = Math.min(1, (album.any.size - 1 + wholeHere) / count);
      place.signals.folderNumbers = Math.min(1, (album.numbered.size - (album.numbered.has(file) ? 1 : 0) + wholeHere) / count);
      place.base += weights.folderCover * place.signals.folderCover + weights.folderNumbers * place.signals.folderNumbers;
      place.score = place.base;
    }
  }
  const albumShares = (file: AnsweredFile) => {
    const shares = new Map<string, number>();
    const list = places.get(file)!;
    confidences(list.map((place) => place.score)).forEach((share, index) => shares.set(list[index]!.key, (shares.get(list[index]!.key) ?? 0) + share));
    return shares;
  };
  for (let round = 0; round < FOLDER_ROUNDS; round += 1) {
    const own = new Map(files.map((file) => [file, albumShares(file)]));
    const total = new Map<string, Map<string, number>>();
    for (const [file, shares] of own) {
      const folder = total.get(folderOf(file.question.file)) ?? new Map(wholeIn.get(folderOf(file.question.file)) ?? []);
      for (const [key, share] of shares) folder.set(key, (folder.get(key) ?? 0) + share);
      total.set(folderOf(file.question.file), folder);
    }
    for (const file of files) {
      const folder = folderOf(file.question.file);
      const count = Math.max(others.get(folder)! - 1, weights.folderFull);
      for (const place of places.get(file)!) {
        const agreeing = (total.get(folder)!.get(place.key) ?? 0) - (own.get(file)!.get(place.key) ?? 0);
        place.score = place.base + weights.folder * Math.min(1, agreeing / count);
      }
    }
  }

  // Likeliest files first, each track taken once (a compilation's placed files hold theirs already).
  const taken = new Set<string>();
  const placedOn = new Map<string, ParrotImportPlacedFile[]>();
  for (const [key, found] of whole) {
    placedOn.set(key, [...found.placed]);
    for (const placed of found.placed) taken.add(`${key}|${placed.disc}:${placed.number}`);
  }
  const ranked = files.map((file) => {
    const list = places.get(file)!;
    const shares = confidences(list.map((place) => place.score));
    const order = shares.map((share, index) => ({ share, place: list[index]! })).sort((a, b) => b.share - a.share);
    return { file, best: order[0], rival: order.find((one) => one.place.key !== order[0]?.place.key), found: shares.reduce((sum, share) => sum + share, 0) };
  });
  ranked.sort((a, b) => (b.best?.share ?? 0) - (a.best?.share ?? 0));
  for (const { file, best, rival, found } of ranked) {
    const name = file.question.file;
    if (!best || found < weights.noMatchBelow) {
      log(`[import-match] ${name}: no match${best ? ` (the song at ${found.toFixed(3)}, likeliest ${reach.get(best.place.key)!.album.title})` : ""}`);
      unidentified.push({ file: name, reason: "no-match" });
      continue;
    }
    const { key, track, signals, filled } = best.place;
    const slot = `${key}|${track.disc}:${track.number}`;
    if (taken.has(slot)) {
      log(`[import-match] ${name}: ${reach.get(key)!.album.title} ${track.disc}-${track.number} already taken by a likelier file`);
      unidentified.push({ file: name, reason: "no-track" });
      continue;
    }
    taken.add(slot);
    const sure = best.share >= weights.threshold && !filled;
    const confidence = Math.round(best.share * 1000) / 1000;
    placedOn.set(key, [...(placedOn.get(key) ?? []), { file: name, disc: track.disc, number: track.number, sure, confidence }]);
    const shown = SIGNALS.filter((signal) => signals[signal] !== 0).map((signal) => `${signal}=${Math.round(signals[signal] * 100) / 100}`);
    log(
      `[import-match] ${name}: ${reach.get(key)!.album.title} (${key}) ${track.disc}-${track.number} at ${confidence}${sure ? "" : filled ? ", check: the library has this slot" : ", check"}; ` +
        `${rival ? `next ${reach.get(rival.place.key)!.album.title} at ${rival.share.toFixed(3)}` : "no other album"}; ${shown.join(" ")}`
    );
  }

  // Set coherence (PAR-UP-10): a folder that mostly fills one album keeps its other files on that album's free tracks.
  // Single-file scores cannot see that the album's missing tracks are exactly the folder's leftovers ("The Man I Love"
  // listed as "A Man I Love"), nor that a song found sure on a single or a collection belongs with its folder's album.
  // Such a song keeps the album it left as `alsoOn`, so the review can still move it there.
  const questionOf = new Map(questions.map((question) => [question.file, question]));
  const inFolder = new Map<string, Set<string>>();
  for (const question of questions) inFolder.set(folderOf(question.file), (inFolder.get(folderOf(question.file)) ?? new Set<string>()).add(question.file));
  for (const [folder, names] of inFolder) {
    if (names.size < COHERENT_FOLDER_MIN) continue;
    const [key, sureCount] = [...placedOn]
      .map(([one, placed]) => [one, placed.filter((file) => file.sure && names.has(file.file)).length] as const)
      .sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    if (!key || sureCount < names.size * COHERENT_SHARE) continue;
    const target = reach.get(key)!.album;
    const targetLive = isLive(target.title, target.kind ?? "");
    const leftovers = [
      ...[...placedOn].flatMap(([from, placed]) => (from === key ? [] : placed.filter((file) => names.has(file.file)).map((file) => ({ file: file.file, from })))),
      ...unidentified.filter((file) => names.has(file.file) && (file.reason === "no-match" || file.reason === "no-track")).map((file) => ({ file: file.file, from: null })),
    ].filter(({ file }) => {
      // The live veto holds here too: a file that says live never joins a studio album, however alike its title reads.
      const live = liveFiles.has(file) || isLive(questionOf.get(file)!.title);
      if (live && !targetLive) log(`[import-match] coherence: ${file} stays put: it says live and ${target.title} is not live`);
      return !live || targetLive;
    });
    if (leftovers.length === 0) continue;
    const owned = library.get(key);
    const free = reach
      .get(key)!
      .album.tracks.filter((track) => !taken.has(`${key}|${track.disc}:${track.number}`) && !owned?.owned.some((slot) => slot.disc === track.disc && slot.number === track.number));
    const paired = parrotImportLooseTracks(
      leftovers.map(({ file }) => ({ file, title: questionOf.get(file)!.title, durationMs: questionOf.get(file)!.durationMs })),
      free
    );
    log(`[import-match] coherence: ${folder} is ${reach.get(key)!.album.title} (${key}), ${sureCount} of ${names.size} sure; ${leftovers.length} leftover(s), ${free.length} free track(s), ${paired.size} paired`);
    for (const { file, from } of leftovers) {
      const track = paired.get(file);
      if (!track) {
        log(`[import-match] coherence: ${file} stays ${from ? `on ${reach.get(from)!.album.title}` : "unidentified"}: no free track of ${reach.get(key)!.album.title} fits its title and length`);
        continue;
      }
      let alsoOn: ParrotImportPlacedFile["alsoOn"];
      if (from) {
        const old = placedOn.get(from)!.find((placed) => placed.file === file)!;
        // The user picks Move there, so the place is sure unless the library already has a song on that slot.
        const filled = library.get(from)?.owned.some((slot) => slot.disc === old.disc && slot.number === old.number) ?? false;
        alsoOn = { album: reach.get(from)!.album, tracklistKnown: reach.get(from)!.tracklistKnown, disc: old.disc, number: old.number, sure: !filled };
        taken.delete(`${from}|${old.disc}:${old.number}`);
        const rest = placedOn.get(from)!.filter((placed) => placed.file !== file);
        if (rest.length > 0) placedOn.set(from, rest);
        else placedOn.delete(from);
      } else {
        unidentified.splice(unidentified.findIndex((one) => one.file === file), 1);
      }
      taken.add(`${key}|${track.disc}:${track.number}`);
      placedOn.get(key)!.push({ file, disc: track.disc, number: track.number, sure: true, ...(alsoOn ? { alsoOn } : {}) });
      log(`[import-match] coherence: ${file} moved ${from ? `from ${reach.get(from)!.album.title}, kept as also on` : "from unidentified"} to ${reach.get(key)!.album.title} ${track.disc}-${track.number} "${track.title}"`);
    }
  }

  const albums: ParrotImportMatchedAlbum[] = [];
  for (const [key, placed] of placedOn) {
    const { album, tracklistKnown } = reach.get(key)!;
    albums.push({ album, tracklistKnown, files: placed.sort((a, b) => a.disc - b.disc || a.number - b.number) });
  }
  albums.sort((a, b) => a.album.artist.name.localeCompare(b.album.artist.name) || a.album.title.localeCompare(b.album.title));
  const order = new Map(questions.map((question, index) => [question.file, index]));
  unidentified.sort((a, b) => order.get(a.file)! - order.get(b.file)!);
  log(`[import-match] ${questions.length} file(s): ${albums.length} album(s), ${unidentified.length} unidentified`);
  return { albums, unidentified };
};

/** The tracks of an album no file sits on (the review greys them; the album page shows them as missing). */
export const parrotImportMissingTracks = (album: MusicAlbum, placed: Array<{ disc: number; number: number }>): MusicAlbumTrack[] => {
  const taken = new Set(placed.map((file) => `${file.disc}:${file.number}`));
  return album.tracks.filter((track) => !taken.has(`${track.disc}:${track.number}`));
};

/** A song of the review, as far as pairing it with a track goes. */
export type ParrotImportSong = { file: string; title: string; disc: number; number: number; durationMs?: number | null };

/** A leading article, which listings swap freely ("The Man I Love" listed as "A Man I Love"). */
const LEADING_ARTICLE = /^\s*(?:the|an?|l[ae]s?|l['’]|une?|el|los|las|die|der|das|de|het|een)\s*(?<=\s|['’])/iu;

/**
 * How alike two titles read, 0 to 1: one minus their edit distance over the longer, bracketed parts and a leading
 * article left out.
 */
export const parrotTitleLikeness = (a: string, b: string): number => {
  const [left, right] = [baseTitle(a.replace(LEADING_ARTICLE, "")), baseTitle(b.replace(LEADING_ARTICLE, ""))];
  if (!left || !right) return 0;
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= right.length; j += 1) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1));
    row = next;
  }
  return 1 - row[right.length]! / Math.max(left.length, right.length);
};

/** The least title likeness for a loose pairing ("Just Floatin' Along" / "Just Floating' Along" is about 0.93). */
const LOOSE_TITLE = 0.75;
/** The least title likeness when either length is unknown, so the title alone has to carry it. */
const LOOSE_TITLE_NO_LENGTH = 0.85;

/**
 * Pairs songs with free tracks whose titles read nearly the same and whose lengths agree, likeliest pairs first, each
 * track once (PAR-UP-10): a spelling the metadata lists otherwise ("Just Floatin' Along" / "Just Floating' Along").
 * The length may be off by the scoring's own unit (lengthScaleMs, or lengthShare of the track). Unpaired songs are absent.
 */
export const parrotImportLooseTracks = (songs: Array<{ file: string; title: string; durationMs?: number | null }>, free: Iterable<MusicAlbumTrack>): Map<string, MusicAlbumTrack> => {
  const { lengthScaleMs, lengthShare } = PARROT_IMPORT_MATCH_WEIGHTS;
  const candidates: Array<{ file: string; track: MusicAlbumTrack; likeness: number }> = [];
  const tracks = [...free];
  for (const song of songs) {
    for (const track of tracks) {
      const likeness = parrotTitleLikeness(song.title, track.title);
      const known = song.durationMs != null && track.durationMs != null;
      if (likeness < (known ? LOOSE_TITLE : LOOSE_TITLE_NO_LENGTH)) continue;
      if (known && Math.abs(song.durationMs! - track.durationMs!) > Math.max(lengthScaleMs, lengthShare * track.durationMs!)) continue;
      candidates.push({ file: song.file, track, likeness });
    }
  }
  candidates.sort((a, b) => b.likeness - a.likeness);
  const paired = new Map<string, MusicAlbumTrack>();
  const used = new Set<MusicAlbumTrack>();
  for (const { file, track } of candidates) {
    if (paired.has(file) || used.has(track)) continue;
    paired.set(file, track);
    used.add(track);
  }
  return paired;
};

/**
 * Pairs songs the user moved to an album with its tracks: first by title, then by disc and track number, then by a
 * title that reads nearly the same with a fitting length (parrotImportLooseTracks); each track is used once. A song
 * left without a track maps to null.
 */
export const matchParrotImportTracks = (songs: ParrotImportSong[], album: MusicAlbum, taken: Array<{ disc: number; number: number }> = []): Map<string, MusicAlbumTrack | null> => {
  const busy = new Set(taken.map((track) => `${track.disc}:${track.number}`));
  const free = new Set(album.tracks.filter((track) => !busy.has(`${track.disc}:${track.number}`)));
  const matched = new Map<string, MusicAlbumTrack | null>();
  for (const song of songs) {
    const title = parrotComparableName(song.title);
    if (!title) continue;
    const sameTitle = [...free].filter((track) => parrotComparableName(track.title) === title);
    const track = sameTitle.find((candidate) => candidate.disc === song.disc && candidate.number === song.number) ?? sameTitle[0];
    if (!track) continue;
    free.delete(track);
    matched.set(song.file, track);
  }
  for (const song of songs) {
    if (matched.has(song.file) || !(song.number > 0)) continue;
    const track = [...free].find((candidate) => candidate.disc === (song.disc || 1) && candidate.number === song.number);
    if (!track) continue;
    free.delete(track);
    matched.set(song.file, track);
  }
  const loose = parrotImportLooseTracks(songs.filter((song) => !matched.has(song.file)), free);
  for (const song of songs) if (!matched.has(song.file)) matched.set(song.file, loose.get(song.file) ?? null);
  return matched;
};

/** The names a match gives one song: the album's artist, names and year, the track's title and place (PAR-META-04). */
export type ParrotImportMatchFill = { artist: string; album: string; year: number | null; title: string; number: number; disc: number };

export const parrotImportFromMatch = (album: MusicAlbum, track: MusicAlbumTrack): ParrotImportMatchFill => ({
  artist: album.artist.name,
  album: album.title,
  year: album.year,
  title: track.title,
  number: track.number,
  disc: track.disc,
});

/** Every artist an album credits, in credit order (PAR-UP-06): the lookup lists them only when there are several. */
export const parrotAlbumArtists = (album: MusicAlbum): MusicArtistRef[] => (album.artists && album.artists.length > 0 ? album.artists : [album.artist]);
