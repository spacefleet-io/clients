// Connected autocomplete of the edit-details dialog (PAR-META-18): every field that names something (a song's title,
// artist and album; an album's title and album artist) suggests songs, albums and artists ranked by how well they fit
// ALL the fields together, typos included ("Pinkin Park" + "Numb" + "mete" puts Meteora by Linkin Park first). Results
// that fit only the typed text come in a second section. The library's own artists, albums and songs come first in
// each section; the metadata service's `music_suggest` answers follow. Picking one fills every field it knows; nothing
// is saved until the dialog is.
//
// Results always speak in music terms: `fits.album` is the album's title, also in the album dialog, whose "title" field
// is the album title (`query.field` "title" with `kind` "album" means the album title).
import type { MusicSuggestField, MusicSuggestion, MusicSuggestQuery } from "@space/shared/api";
import { createFuzzyIndex, foldSearchText, fuzzyScore, type FuzzyIndex } from "@space/shared/fuzzySearch";
import type { ParrotEditFields } from "./editForm";

export type ParrotEditSuggestQuery = { kind: "track" | "album"; field: MusicSuggestField; text: string; fields: { title: string; artist: string; album?: string } };

export type ParrotSuggestLibrary = {
  artists: Array<{ id: string; name: string }>;
  albums: Array<{ id: string; title: string; artist: string; year: number | null; kind: string | null; musicId: string | null }>;
  tracks: Array<{ id: string; title: string; artist: string; albumId: string | null; album: string | null; number: number | null; disc: number | null; year: number | null }>;
};

/**
 * One result of the dialog's autocomplete. For a library result (`inLibrary`) the ids are the library's own (artist,
 * album, track ids); for a lookup result they are the metadata service's.
 */
export type ParrotEditSuggestion = MusicSuggestion & {
  /** Stable dedupe key: kind + normalized artist + album + song. */
  key: string;
  inLibrary: boolean;
  /** "all": fits the other filled fields too (section "Fits this song/album"); "field": matches only the typed text (section "Only “…”"). */
  scope: "all" | "field";
  /** Album cover id to fetch for an album pick (the album's musicId ?? lookup id), null when none. */
  coverId: string | null;
  /** How well it fits, higher is better: the fuzzy scores of the fields it fits, summed. */
  score: number;
};

export type ParrotEditSuggestions = { all: ParrotEditSuggestion[]; field: ParrotEditSuggestion[] };

type MusicFields = Record<MusicSuggestField, string>;
type Context = MusicFields & { field: MusicSuggestField };
type FieldScores = Record<MusicSuggestField, number | null>;

const MUSIC_FIELDS: readonly MusicSuggestField[] = ["title", "artist", "album"];

/** The query in music terms: an album dialog's "title" is the album's title, and it has no song title. */
const musicContext = (query: ParrotEditSuggestQuery): Context => {
  const field: MusicSuggestField = query.kind === "album" && query.field === "title" ? "album" : query.field;
  const base: MusicFields =
    query.kind === "album"
      ? { title: "", artist: query.fields.artist, album: query.fields.title }
      : { title: query.fields.title, artist: query.fields.artist, album: query.fields.album ?? "" };
  const fields = { ...base, [field]: query.text };
  return { field, title: fields.title.trim(), artist: fields.artist.trim(), album: fields.album.trim() };
};

/** The `music_suggest` query the dialog sends for `query` (in music terms, so an album dialog asks for albums). */
export const parrotMusicSuggestQuery = (query: ParrotEditSuggestQuery, limit?: number): MusicSuggestQuery => {
  const ctx = musicContext(query);
  const context = Object.fromEntries(MUSIC_FIELDS.filter((f) => f !== ctx.field && ctx[f] !== "").map((f) => [f, ctx[f]]));
  return { field: ctx.field, text: ctx[ctx.field], ...context, ...(limit === undefined ? {} : { limit }) };
};

const normalize = (value: string | null | undefined): string => foldSearchText(value ?? "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Fuzzy score of a candidate value for what stands in a field; null when the field is empty or does not fit. */
const fit = (typed: string, value: string | null | undefined): number | null => (typed === "" || !value ? null : fuzzyScore(typed, value));

/** Best fit of a field among several values (an artist's songs, an album's songs). */
const bestFit = (typed: string, values: Iterable<string | null | undefined>): number | null => {
  if (typed === "") return null;
  let best: number | null = null;
  for (const value of values) {
    const s = fit(typed, value);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
};

const fitCount = (s: { fits: MusicSuggestion["fits"] }): number => Number(s.fits.title) + Number(s.fits.artist) + Number(s.fits.album);

const build = (
  ctx: Context,
  base: Omit<MusicSuggestion, "fits">,
  scores: FieldScores,
  extra: { inLibrary: boolean; coverId: string | null },
): ParrotEditSuggestion | null => {
  if (scores[ctx.field] === null) return null;
  const fits = { title: scores.title !== null, artist: scores.artist !== null, album: scores.album !== null };
  const score = (scores.title ?? 0) + (scores.artist ?? 0) + (scores.album ?? 0);
  // Dedupe key: kind + normalized artist (+ album (+ song)).
  const parts = base.kind === "artist" ? [base.artist.name] : base.kind === "album" ? [base.artist.name, base.album?.title] : [base.artist.name, base.album?.title, base.song?.title];
  const key = [base.kind, ...parts.map(normalize)].join("|");
  // "field" ("Only “…”") when it matches the typed text and none of the other filled fields; "all" when it fits at
  // least one of them, or none is filled. Within "all", more fitting fields rank first (compare).
  const others = MUSIC_FIELDS.filter((f) => f !== ctx.field && ctx[f] !== "");
  const scope = others.length === 0 || others.some((f) => fits[f]) ? "all" : "field";
  return { ...base, fits, key, scope, score, ...extra };
};

const compare = (a: ParrotEditSuggestion, b: ParrotEditSuggestion): number => fitCount(b) - fitCount(a) || b.score - a.score;

/** Drops repeated keys (the first copy wins) and an artist or album a more precise result already carries as well. */
const dedupe = (list: readonly ParrotEditSuggestion[]): ParrotEditSuggestion[] => {
  const seen = new Set<string>();
  const unique = list.filter((s) => !seen.has(s.key) && (seen.add(s.key), true));
  const covers = (general: ParrotEditSuggestion, specific: ParrotEditSuggestion): boolean => {
    if (specific === general || fitCount(specific) < fitCount(general) || (general.scope === "all" && specific.scope !== "all")) return false;
    if (normalize(specific.artist.name) !== normalize(general.artist.name)) return false;
    if (general.kind === "artist") return specific.kind !== "artist";
    return general.kind === "album" && specific.kind === "song" && normalize(specific.album?.title) === normalize(general.album?.title);
  };
  // A vault album or artist covered by a lookup song (Numb on Meteora) stands down for the song, which takes its place
  // and its "in your library" mark (with the vault album's id, for its cover): albums already in the vault rank first.
  const out: ParrotEditSuggestion[] = [];
  const placed = new Map<ParrotEditSuggestion, number>();
  for (const s of unique) {
    if (placed.has(s)) continue;
    const by = s.kind === "song" ? undefined : unique.find((other) => covers(s, other));
    if (!by) {
      placed.set(s, out.length);
      out.push(s);
      continue;
    }
    if (!s.inLibrary || by.inLibrary) continue;
    const album = s.kind === "album" && s.album && by.album ? { ...by.album, id: s.album.id } : by.album;
    const at = placed.get(by);
    if (at === undefined) {
      placed.set(by, out.length);
      out.push({ ...by, album, inLibrary: true });
    } else out[at] = { ...out[at]!, album, inLibrary: true };
  }
  return out;
};

type Track = ParrotSuggestLibrary["tracks"][number];
type Album = ParrotSuggestLibrary["albums"][number];

type PreparedLibrary = {
  tracks: FuzzyIndex<Track>;
  albums: FuzzyIndex<Album>;
  artists: FuzzyIndex<{ id: string | null; name: string }>;
  albumById: Map<string, Album>;
  tracksByAlbum: Map<string, Track[]>;
  tracksByArtist: Map<string, Track[]>;
  albumsByArtist: Map<string, Album[]>;
  artistId: Map<string, string>;
};

/** Indexes of a library, built once per library snapshot (each keystroke reuses them). */
const prepared = new WeakMap<ParrotSuggestLibrary, PreparedLibrary>();

const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

const prepare = (library: ParrotSuggestLibrary): PreparedLibrary => {
  const cached = prepared.get(library);
  if (cached) return cached;
  const albumById = new Map(library.albums.map((a) => [a.id, a]));
  const tracksByAlbum = new Map<string, Track[]>();
  const tracksByArtist = new Map<string, Track[]>();
  const albumsByArtist = new Map<string, Album[]>();
  for (const t of library.tracks) {
    if (t.albumId) push(tracksByAlbum, t.albumId, t);
    push(tracksByArtist, normalize(t.artist), t);
  }
  for (const a of library.albums) push(albumsByArtist, normalize(a.artist), a);
  const artistId = new Map(library.artists.map((a) => [normalize(a.name), a.id]));
  // Artists named only on an album or a song still autocomplete.
  const artists: Array<{ id: string | null; name: string }> = [...library.artists];
  const named = new Set(artistId.keys());
  for (const name of [...library.albums.map((a) => a.artist), ...library.tracks.map((t) => t.artist)]) {
    const key = normalize(name);
    if (key !== "" && !named.has(key)) {
      named.add(key);
      artists.push({ id: null, name });
    }
  }
  const result: PreparedLibrary = {
    tracks: createFuzzyIndex(library.tracks, (t) => [t.title]),
    albums: createFuzzyIndex(library.albums, (a) => [a.title]),
    artists: createFuzzyIndex(artists, (a) => [a.name]),
    albumById,
    tracksByAlbum,
    tracksByArtist,
    albumsByArtist,
    artistId,
  };
  prepared.set(library, result);
  return result;
};

/**
 * Suggestions from the user's library for what is typed, best first ("all" before "field"), at most `limit`. A song
 * typed suggests songs; an artist suggests artists, and the songs (or albums) of theirs that fit the other fields; an
 * album suggests albums, and the songs on them that fit the title. Results that do not match the typed text are dropped.
 */
export const parrotLibrarySuggestions = (library: ParrotSuggestLibrary, query: ParrotEditSuggestQuery, limit = 12): ParrotEditSuggestion[] => {
  const ctx = musicContext(query);
  const typed = ctx[ctx.field];
  if (typed === "") return [];
  const lib = prepare(library);
  const out: ParrotEditSuggestion[] = [];
  const add = (s: ParrotEditSuggestion | null) => {
    if (s) out.push(s);
  };
  const artistRef = (name: string) => ({ id: lib.artistId.get(normalize(name)) ?? null, name });

  const song = (t: Track) => {
    const album = t.albumId ? lib.albumById.get(t.albumId) : undefined;
    const albumTitle = album?.title ?? t.album;
    return build(
      ctx,
      {
        kind: "song",
        artist: artistRef(t.artist),
        album: albumTitle
          ? // The library keeps 0 for a file without a track or disc tag: unknown, never "track 0".
            { id: album?.id ?? null, title: albumTitle, year: t.year ?? album?.year ?? null, kind: album?.kind ?? null, trackNumber: t.number || null, disc: t.disc || null }
          : null,
        song: { id: t.id, title: t.title, durationMs: null },
      },
      { title: fit(ctx.title, t.title), artist: fit(ctx.artist, t.artist), album: fit(ctx.album, albumTitle) },
      { inLibrary: true, coverId: album?.musicId ?? null },
    );
  };

  const albumOf = (a: Album) =>
    build(
      ctx,
      { kind: "album", artist: artistRef(a.artist), album: { id: a.id, title: a.title, year: a.year, kind: a.kind, trackNumber: null, disc: null }, song: null },
      { title: bestFit(ctx.title, (lib.tracksByAlbum.get(a.id) ?? []).map((t) => t.title)), artist: fit(ctx.artist, a.artist), album: fit(ctx.album, a.title) },
      { inLibrary: true, coverId: a.musicId },
    );

  if (ctx.field === "title") {
    for (const hit of lib.tracks.search(typed)) add(song(hit.item));
  } else if (ctx.field === "artist") {
    for (const { item } of lib.artists.search(typed)) {
      const key = normalize(item.name);
      const tracks = lib.tracksByArtist.get(key) ?? [];
      const albums = lib.albumsByArtist.get(key) ?? [];
      add(
        build(
          ctx,
          { kind: "artist", artist: { id: item.id, name: item.name }, album: null, song: null },
          { title: bestFit(ctx.title, tracks.map((t) => t.title)), artist: fit(ctx.artist, item.name), album: bestFit(ctx.album, [...albums.map((a) => a.title), ...tracks.map((t) => t.album)]) },
          { inLibrary: true, coverId: null },
        ),
      );
      // The songs (or, with no title, the albums) of this artist that fit the other fields: picking one fills them all.
      if (ctx.title !== "") tracks.filter((t) => fit(ctx.title, t.title) !== null).forEach((t) => add(song(t)));
      else if (ctx.album !== "") albums.filter((a) => fit(ctx.album, a.title) !== null).forEach((a) => add(albumOf(a)));
    }
  } else {
    for (const { item } of lib.albums.search(typed)) {
      add(albumOf(item));
      if (ctx.title !== "") (lib.tracksByAlbum.get(item.id) ?? []).filter((t) => fit(ctx.title, t.title) !== null).forEach((t) => add(song(t)));
    }
  }
  return dedupe(out.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "all" ? -1 : 1) || compare(a, b))).slice(0, limit);
};

/** The metadata service's `music_suggest` answers as dialog suggestions, the fit of each field checked here too. */
export const parrotLookupSuggestions = (results: MusicSuggestion[], query: ParrotEditSuggestQuery): ParrotEditSuggestion[] => {
  const ctx = musicContext(query);
  // A field the service says fits but the local check does not still counts, a little.
  const SERVICE_FIT = 0.5;
  return results.flatMap((r) => {
    const values: Record<MusicSuggestField, string | null> = { title: r.song?.title ?? null, artist: r.artist.name, album: r.album?.title ?? null };
    const scores = Object.fromEntries(
      MUSIC_FIELDS.map((f) => {
        if (ctx[f] === "") return [f, null];
        const local = fit(ctx[f], values[f]);
        return [f, local ?? (r.fits[f] || f === ctx.field ? SERVICE_FIT : null)];
      }),
    ) as FieldScores;
    const { fits: _fits, ...base } = r;
    const s = build(ctx, base, scores, { inLibrary: false, coverId: r.kind === "artist" ? null : (r.album?.id ?? null) });
    return s ? [s] : [];
  });
};

/**
 * A result found in both keeps the library's place, ids and "in your vault" mark, and takes what the lookup knows
 * better: its spelling ("meteora" picks as "Meteora"), the year and track number the vault lacks, and its cover, so
 * picking a badly tagged vault album still corrects it and brings its cover in.
 */
const withLookup = (lib: ParrotEditSuggestion, look: ParrotEditSuggestion): ParrotEditSuggestion => ({
  ...lib,
  artist: { ...lib.artist, name: look.artist.name },
  album:
    lib.album && look.album
      ? { ...lib.album, title: look.album.title, year: lib.album.year ?? look.album.year, trackNumber: lib.album.trackNumber ?? look.album.trackNumber, disc: lib.album.disc ?? look.album.disc }
      : lib.album,
  song: lib.song && look.song ? { ...lib.song, title: look.song.title } : lib.song,
  coverId: lib.coverId ?? look.coverId,
});

/** The song or album being edited, as the dialog opened on it. */
export type ParrotEditOriginal = { kind: "track" | "album"; values: ParrotEditFields };

/** Picking it would leave every field as the dialog opened: the edited item itself, as the library already has it. */
const changesNothing = (original: ParrotEditOriginal, s: ParrotEditSuggestion): boolean => {
  const next = applyParrotEditSuggestion(original.kind, original.values, s);
  return (Object.keys(original.values) as Array<keyof ParrotEditFields>).every((key) => next[key] === original.values[key]);
};

/**
 * Library first inside each section, deduped by key (library copy wins, corrected by the lookup's), "all" sorted by fit
 * count then score. Given the item being edited, a library result that would change nothing (the song itself, still
 * filed as "pinkin park") is left out, so the correction the lookup offers comes first.
 */
export const mergeParrotEditSuggestions = (library: ParrotEditSuggestion[], lookup: ParrotEditSuggestion[], original?: ParrotEditOriginal): ParrotEditSuggestions => {
  const looked = new Map(lookup.map((s) => [s.key, s]));
  const lib = library.map((s) => {
    const look = looked.get(s.key);
    return look ? withLookup(s, look) : s;
  });
  const merged = dedupe([...lib.sort(compare), ...[...lookup].sort(compare)]).filter((s) => !(original && s.inLibrary && changesNothing(original, s)));
  return { all: merged.filter((s) => s.scope === "all"), field: merged.filter((s) => s.scope === "field") };
};

/** Dialog values after picking: fills every field the suggestion knows; genre untouched. Track: title/artist/album/number/disc/year. Album: title/albumArtist/year. */
export const applyParrotEditSuggestion = (kind: "track" | "album", values: ParrotEditFields, pick: ParrotEditSuggestion): ParrotEditFields => {
  const album = pick.album;
  const artist = pick.artist.name.trim() === "" ? values.artist : pick.artist.name;
  if (kind === "album") return { ...values, title: album?.title ?? values.title, artist, year: album?.year ?? values.year };
  const song = pick.song;
  return {
    ...values,
    title: song?.title ?? values.title,
    artist,
    album: album?.title ?? values.album,
    number: song && album?.trackNumber != null ? album.trackNumber : values.number,
    disc: song && album?.disc != null ? album.disc : values.disc,
    year: album?.year ?? values.year,
  };
};
