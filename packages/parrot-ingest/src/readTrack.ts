import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseFile, selectCover, type ICommonTagsResult, type ILyricsTag } from "music-metadata";
import { parseLrc, splitTitleTrackNumber, toLrc } from "@space/parrot-core";
import type { ParrotListedTrack } from "@space/parrot-library-db-definition";
import type { ParrotCoverCrop } from "@space/parrot-core";
import type { ParrotCoverImage } from "./covers";
import { parrotAudioFormatFor, type ParrotAudioFormat } from "./formats";

/** What the library needs to know about one audio file before it is uploaded. */
export type ParrotTrackInfo = {
  file: string;
  artist: string;
  albumArtist: string;
  /** The file is tagged as part of a compilation (iTunes' `compilation` flag): its album is matched as a whole first. */
  compilation?: boolean;
  album: string;
  title: string;
  disc: number;
  number: number;
  year: number | null;
  /** The file's first genre tag, when it has one. */
  genre?: string | null;
  durationMs: number | null;
  bitrateKbps: number | null;
  sampleRate: number | null;
  format: ParrotAudioFormat;
  /** The picture built into the file (its front cover, else its first picture); the album's cover when it has none yet. */
  cover?: ParrotCoverImage | null;
  /** PAR-META-22: the square of `cover` the user framed in the import review; absent, the centre square. */
  coverCrop?: ParrotCoverCrop | null;
  /**
   * The song's own lyrics (PAR-LYR-01): synced as LRC text, plain as text; null when the file and its `.lrc` hold none.
   * `user`: the lyrics file the user placed on the song in the review (PAR-LYR-09), stored as their own lyrics.
   */
  lyrics?: { synced: string | null; plain: string | null; user?: boolean } | null;
  /** The file's own ReplayGain tags for even volume (PAR-PLAY-03); null when it has none and the app measures the song. */
  loudness?: { gainDb: number; peak: number | null; albumGainDb: number | null; albumPeak: number | null } | null;
  /** The artist's and the album artist's ids in the metadata (PAR-META-15): from the file's tags, or the confirmed import's match; null when unknown or credited to several. */
  artistMusicId?: string | null;
  albumArtistMusicId?: string | null;
  /** The matched album's full tracklist from the confirmed import (PAR-LIB-05); never read from the file. */
  tracklist?: ParrotListedTrack[] | null;
  /** The matched album's id in the metadata from the confirmed import (PAR-COPY-01); never read from the file. */
  albumMusicId?: string | null;
  /** The matched song's id in our music copy from the confirmed import (PAR-LYR-01); never read from the file. */
  trackMusicId?: string | null;
  /** The user kept the song as is at import, matched to nothing (PAR-UP-05). */
  unidentified?: boolean;
};

export const UNKNOWN_ARTIST = "Unknown artist";
export const UNKNOWN_ALBUM = "Unknown album";

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : null;
};

const TAG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The one artist id a tag holds; a credit to several artists names none of them alone, so it gives none. */
const singleTagId = (ids: string[] | undefined): string | null => {
  const found = [...new Set((ids ?? []).flatMap((id) => id.split(/[;/]/)).map((id) => id.trim().toLowerCase()).filter(Boolean))];
  return found.length === 1 && TAG_ID.test(found[0]!) ? found[0]! : null;
};

/**
 * META-SRC-09 exception: the artist id tags taggers write into audio files. The tag reader names those fields after
 * the tagging standard, so this is the one place they are named; everything after it holds neutral `…MusicId` ids.
 * `ARTIST_ID_FILE_TAGS` are the raw tag keys a tagger writes, which the reader maps to the two fields below.
 */
export const ARTIST_ID_FILE_TAGS = { artist: "MUSICBRAINZ_ARTISTID", albumArtist: "MUSICBRAINZ_ALBUMARTISTID" } as const;

/** The artist ids the file's tags hold (see the exception above). */
const artistTagIds = (common: ICommonTagsResult) => ({
  artistMusicId: singleTagId(common.musicbrainz_artistid),
  albumArtistMusicId: singleTagId(common.musicbrainz_albumartistid),
});

/** The names a file name gives (PAR-META-02); null for each name it does not carry. */
export type ParrotFileNameInfo = { number: number | null; title: string; artist: string | null; album: string | null };

/** The ` - ` between the parts of a common music file name (any dash, spaced). */
const NAME_PARTS = /\s+[-\u2013\u2014]\s+/u;
const TRACK_NUMBER = /^\d{1,3}$/;

/**
 * Reads a file name the way music files are commonly named (PAR-META-02):
 * `03 - Paperboat`, `03. Paperboat`, `03 Paperboat` → number 3, title `Paperboat`;
 * `01 - Linnet Park - What I've Kept` → number 1, artist and title;
 * `Linnet Park - Fable` → artist and title;
 * `Dusk Pike - Lowlands - 03 - Velvet Static` → artist, album, number 3 and title (`Artist - 03 - Title` too).
 * A name that is only a number (`1979`) is a title; `50 Cent - In da Club` keeps 50 Cent as the artist.
 */
export const parseTrackFileName = (file: string): ParrotFileNameInfo => {
  const stem = path.basename(file, path.extname(file)).trim();
  const parts = stem.split(NAME_PARTS).filter(Boolean);
  const lead = /^(\d{1,3})(\s*[-._)]\s*|\s+)(\S.*)$/u.exec(stem);
  if (lead) {
    const rest = lead[3]!.split(NAME_PARTS).filter(Boolean);
    // A bare unpadded number before a space starts an artist's name ("50 Cent - In da Club") when a dash follows.
    const artistName = /^\s+$/u.test(lead[2]!) && !lead[1]!.startsWith("0") && rest.length >= 2;
    if (!artistName) {
      const number = Number(lead[1]);
      if (rest.length >= 2) return { number, artist: rest[0]!, album: null, title: rest.slice(1).join(" - ") };
      return { number, artist: null, album: null, title: lead[3]!.trim() };
    }
  }
  const numberAt = parts.findIndex((part, index) => (index === 1 || index === 2) && index < parts.length - 1 && TRACK_NUMBER.test(part));
  if (numberAt > 0) {
    return { number: Number(parts[numberAt]), artist: parts[0]!, album: numberAt === 2 ? parts[1]! : null, title: parts.slice(numberAt + 1).join(" - ") };
  }
  if (parts.length >= 2) return { number: null, artist: parts[0]!, album: null, title: parts.slice(1).join(" - ") };
  return { number: null, artist: null, album: null, title: stem };
};

/** What an album folder's name gives (PAR-META-02): null for each name it does not carry. */
export type ParrotFolderNameInfo = { artist: string | null; album: string | null; year: number | null };

const YEAR = /^(?:19|20)\d{2}$/;

/**
 * Reads an album folder's name the way album folders are commonly named (PAR-META-02): `Linnet Park - Hollow Signal
 * (2000) [FLAC]` → artist, album and year; `Hollow Signal (2000)` → album and year; `Linnet Park - 2003 - Meltway` →
 * the same. Trailing brackets (`[FLAC]`, `(320 kbps)`, `{Web}`) are dropped, a bracketed year is kept as the year.
 */
export const parseAlbumFolderName = (name: string): ParrotFolderNameInfo => {
  let rest = name.trim();
  let year: number | null = null;
  for (let bracket = /\s*[[({]([^\])}]*)[\])}]\s*$/u.exec(rest); bracket && bracket.index > 0; bracket = /\s*[[({]([^\])}]*)[\])}]\s*$/u.exec(rest)) {
    const inside = bracket[1]!.trim();
    if (year === null && YEAR.test(inside)) year = Number(inside);
    rest = rest.slice(0, bracket.index).trim();
  }
  const parts = rest.split(NAME_PARTS).filter(Boolean);
  const yearAt = parts.findIndex((part) => YEAR.test(part));
  if (parts.length >= 2 && yearAt >= 0) {
    if (year === null) year = Number(parts[yearAt]);
    parts.splice(yearAt, 1);
  }
  if (parts.length >= 2) return { artist: parts[0]!, album: parts.slice(1).join(" - "), year };
  return { artist: null, album: parts[0] ?? (rest || null), year };
};

const codecName = (raw: string | undefined, fallback: string) => {
  const lower = raw?.toLowerCase() ?? "";
  if (!lower) return fallback;
  if (lower.includes("mpeg") && lower.includes("layer 3")) return "mp3";
  if (lower.startsWith("aac") || lower.includes("mpeg-4/aac")) return "aac";
  if (lower.includes("flac")) return "flac";
  if (lower.includes("alac")) return "alac";
  if (lower.includes("opus")) return "opus";
  if (lower.includes("vorbis")) return "vorbis";
  if (lower.includes("pcm")) return fallback;
  return lower;
};

/**
 * The stored format: an Apple Lossless `.m4a` keeps the MP4 container but is lossless and says so in its MIME type
 * (`audio/mp4; codecs=alac`), so players pick it only when they can decode it (PAR-FMT-01).
 */
const parrotFormatOf = (format: ParrotAudioFormat, codec: string, lossless: boolean | undefined): ParrotAudioFormat =>
  codec === "alac"
    ? { ...format, codec, mime: `${format.mime}; codecs=alac`, lossless: true }
    : { ...format, codec, lossless: lossless ?? format.lossless };

/**
 * The file's own lyrics (PAR-LYR-01): a `.lrc` file with the same name next to it first (it is the user's synced
 * copy), then the lyrics in its tags (synced SYLT-style lines when timed, else plain USLT-style text).
 */
export const readOwnLyrics = async (file: string, tags: readonly ILyricsTag[] | undefined): Promise<ParrotTrackInfo["lyrics"]> => {
  const sidecar = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.lrc`);
  const lrc = await readFile(sidecar, "utf8").catch(() => null);
  const fromLrc = lrc ? parseLrc(lrc) : null;
  const timed = tags?.find((tag) => tag.syncText?.some((line) => typeof line.timestamp === "number"));
  const fromTags = timed ? timed.syncText.filter((line) => typeof line.timestamp === "number").map((line) => ({ ms: line.timestamp!, text: line.text.trim() })) : null;
  // Some taggers put LRC text in the plain lyrics field: read it as synced when it is.
  const plainTag = tags?.map((tag) => tag.text?.trim()).find((text) => !!text) ?? null;
  const plainAsLrc = plainTag ? parseLrc(plainTag) : null;
  const synced = fromLrc ?? (fromTags?.length ? fromTags : null) ?? plainAsLrc;
  const plain = plainAsLrc ? null : plainTag;
  if (!synced && !plain) return null;
  return { synced: synced ? toLrc(synced) : null, plain };
};

/**
 * The name of `folder` when it lies strictly inside `root` (the folder the user picked); null for the root itself
 * and anything above it. The picked folder is where the music is kept (often the system's Music folder), and the
 * folders above it are the user's own (their home folder), so neither names an album or an artist. With no root,
 * every folder counts.
 */
const folderNameInside = (folder: string, root: string | undefined): string | null => {
  if (root === undefined) return path.basename(folder);
  const relative = path.relative(path.resolve(root), path.resolve(folder));
  const inside = relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  return inside ? path.basename(folder) : null;
};

type GainTags = Partial<Record<"replaygain_track_gain" | "replaygain_track_peak" | "replaygain_album_gain" | "replaygain_album_peak", { dB?: number; ratio?: number }>>;
const finite = (value: number | undefined): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** The file's ReplayGain tags (PAR-PLAY-03): the song's gain is needed; peaks and the album's values when present. */
const replayGain = (tags: GainTags): ParrotTrackInfo["loudness"] => {
  const gainDb = finite(tags.replaygain_track_gain?.dB);
  if (gainDb === null) return null;
  return {
    gainDb,
    peak: finite(tags.replaygain_track_peak?.ratio),
    albumGainDb: finite(tags.replaygain_album_gain?.dB),
    albumPeak: finite(tags.replaygain_album_peak?.ratio),
  };
};

/**
 * Reads one audio file's embedded tags and stream facts. A missing tag falls back to the file and folder names
 * (PAR-META-02's order: tags, then file name, then folder name; each later source only fills what the earlier ones
 * lack): the artist, album, track number and title from the file name (parseTrackFileName), then the artist, album
 * and year from the parent folder (parseAlbumFolderName), then the artist from the folder above it, only for folders
 * inside `root` (the picked folder the file was found under). Throws for a file that is not a Parrot audio format
 * (PAR-UP-01).
 */
export const readParrotTrackInfo = async (file: string, root?: string): Promise<ParrotTrackInfo> => {
  const format = parrotAudioFormatFor(file);
  if (!format) throw new Error(`not an audio file Parrot imports: ${file}`);
  const { common, format: stream, native } = await parseFile(file, { duration: true });
  // music-metadata maps TCMP / cpil / COMPILATION; ffmpeg and some taggers write an ID3 `TXXX:compilation` instead.
  const compilation =
    common.compilation === true ||
    Object.values(native).some((tags) => tags.some((tag) => /^(?:TXXX:)?compilation$/iu.test(tag.id) && ["1", "true"].includes(String(tag.value).trim().toLowerCase())));
  const picture = selectCover(common.picture);
  const fromName = parseTrackFileName(file);
  const parentFolder = folderNameInside(path.dirname(file), root);
  const fromFolder = parentFolder ? parseAlbumFolderName(parentFolder) : null;
  const grandParentFolder = folderNameInside(path.dirname(path.dirname(file)), root);
  const fromGrandParent = grandParentFolder ? parseAlbumFolderName(grandParentFolder) : null;
  const artist =
    clean(common.artist) ??
    clean(common.albumartist) ??
    clean(fromName.artist) ??
    clean(fromFolder?.artist) ??
    clean(fromGrandParent?.artist ?? fromGrandParent?.album) ??
    UNKNOWN_ARTIST;
  const tagTitle = clean(common.title);
  // A title tag's leading track number fills a missing track-number tag; the file name's comes after (PAR-META-21).
  const titled = tagTitle ? splitTitleTrackNumber(tagTitle, common.track?.no) : { title: fromName.title, number: common.track?.no && common.track.no > 0 ? common.track.no : null };
  const seconds = stream.duration;
  return {
    file,
    artist,
    albumArtist: clean(common.albumartist) ?? artist,
    compilation,
    album: clean(common.album) ?? clean(fromName.album) ?? clean(fromFolder?.album) ?? UNKNOWN_ALBUM,
    title: titled.title,
    disc: common.disk?.no && common.disk.no > 0 ? common.disk.no : 1,
    number: titled.number ?? fromName.number ?? 0,
    year: common.year && common.year > 0 ? common.year : (fromFolder?.year ?? null),
    genre: clean(common.genre?.[0]),
    durationMs: typeof seconds === "number" && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    bitrateKbps: typeof stream.bitrate === "number" && Number.isFinite(stream.bitrate) ? Math.round(stream.bitrate / 1000) : null,
    sampleRate: typeof stream.sampleRate === "number" ? stream.sampleRate : null,
    format: parrotFormatOf(format, codecName(stream.codec, format.codec), stream.lossless),
    cover: picture ? { bytes: picture.data, mime: picture.format } : null,
    lyrics: await readOwnLyrics(file, common.lyrics),
    loudness: replayGain(common),
    ...artistTagIds(common),
  };
};
