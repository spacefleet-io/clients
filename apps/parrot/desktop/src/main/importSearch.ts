// PAR-UP-05 "Identify" and "Wrong album? Search": what main asks our music library for, apart from Electron so it can
// be tested with a fake client. A search answers as soon as its songs or albums are known; covers are asked afterwards,
// one per album (`importCoverOf`), so a slow cover never holds the answer back. Every lookup
// refused as busy (429, 503) is asked again after the service's Retry-After (`withLookupRetry`).

import { parrotAlbumKey } from "@space/parrot-core";
import { withLookupRetry, type MetadataClient } from "@space/metadata-client";
import type { MusicAlbum, MusicAlbumTrack, MusicRecording } from "@space/shared/api";
import type { ParrotImportFoundAlbum } from "../shared/ipc";

/** How many albums or songs one search shows (PAR-UP-05): one screen of covers. */
export const IMPORT_SEARCH_LIMIT = 8;
/** Album lookups of one song search in flight at once: our own service, a handful, never a burst of eight. */
export const IMPORT_SEARCH_ALBUMS_AT_ONCE = 3;

type Log = (line: string) => void;
type SearchClient = Pick<MetadataClient, "musicRecordings" | "musicAlbums">;

/** A lookup asked again when the service says it is busy; each wait is logged (no title, no name). */
const retried = <T>(what: string, log: Log, task: () => Promise<T>) =>
  withLookupRetry(task, {
    onRetry: (seconds, attempt, error) => log(`[import] ${what}: service busy (${error.status}${error.code ? ` ${error.code}` : ""}), try ${attempt} in ${seconds}s`),
  });

/** `run` over `items`, at most `atOnce` at a time, answers in `items`' order. */
const inBatches = async <T, R>(items: readonly T[], atOnce: number, run: (item: T) => Promise<R>): Promise<R[]> => {
  const answers: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      answers[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(atOnce, items.length) }, worker));
  return answers;
};

/** The track of `album` a recording is: by its id in the metadata, else its place on the album. */
const trackOn = (album: MusicAlbum, recording: MusicRecording): MusicAlbumTrack | undefined =>
  album.tracks.find((candidate) => candidate.id !== null && candidate.id === recording.id) ??
  album.tracks.find((candidate) => candidate.number === recording.album?.trackNumber && candidate.disc === (recording.album?.disc ?? 1));

/**
 * "Identify": the recordings matching what the user typed, each on its album with the track it is. Each album is asked
 * once (for its full tracklist), a few at a time; an album the library cannot give whole drops its recordings. Covers
 * come later (`cover: null` here).
 */
export const searchParrotImportSongs = async (
  client: SearchClient,
  question: { artist: string; title: string; album: string },
  log: Log
): Promise<Array<ParrotImportFoundAlbum & { track: MusicAlbumTrack }>> => {
  const startedAt = Date.now();
  const { results } = await retried("song search", log, () =>
    client.musicRecordings({ artist: question.artist, title: question.title, ...(question.album ? { album: question.album } : {}), limit: IMPORT_SEARCH_LIMIT })
  );
  const askedAt = Date.now();
  const onAlbums = results.filter((recording) => recording.album);
  const firstOfAlbum = new Map<string, MusicRecording>();
  for (const recording of onAlbums) {
    const key = parrotAlbumKey(recording.album!);
    if (!firstOfAlbum.has(key)) firstOfAlbum.set(key, recording);
  }
  const keys = [...firstOfAlbum.keys()];
  const wholes = await inBatches(keys, IMPORT_SEARCH_ALBUMS_AT_ONCE, async (key) => {
    const recording = firstOfAlbum.get(key)!;
    const { results: matches } = await retried("song search album", log, () =>
      client.musicAlbums({ artist: recording.artist.name, album: recording.album!.title, limit: 5 })
    );
    return matches.find((candidate) => parrotAlbumKey(candidate) === key) ?? null;
  });
  const albums = new Map(keys.map((key, index) => [key, wholes[index]]));
  const found: Array<ParrotImportFoundAlbum & { track: MusicAlbumTrack }> = [];
  for (const recording of onAlbums) {
    const album = albums.get(parrotAlbumKey(recording.album!));
    const track = album ? trackOn(album, recording) : undefined;
    if (album && track) found.push({ album, cover: null, track });
  }
  log(
    `[import] song search: ${results.length} recording(s), ${keys.length} album(s) asked, ${found.length} on a known album; ` +
      `recordings ${askedAt - startedAt} ms, albums ${Date.now() - askedAt} ms`
  );
  return found;
};

/** "Wrong album? Search" and "Add to album…": the albums matching what the user typed, with their full tracklists; covers come later. */
export const searchParrotImportAlbums = async (client: SearchClient, question: { artist: string; album: string }, log: Log): Promise<ParrotImportFoundAlbum[]> => {
  const startedAt = Date.now();
  const { results } = await retried("album search", log, () => client.musicAlbums({ artist: question.artist, album: question.album, limit: IMPORT_SEARCH_LIMIT }));
  log(`[import] album search: ${results.length} result(s) in ${Date.now() - startedAt} ms`);
  return results.slice(0, IMPORT_SEARCH_LIMIT).map((album) => ({ album, cover: null }));
};

/** An id the metadata gives an album, artist or song: opaque, checked only for its shape before it is asked about or kept. */
export const PARROT_MUSIC_ID = /^[\w-]{1,64}$/u;

/**
 * One album's 500 px cover as a data: URL, null when no source has one or the lookup fails (the drawn disc shows). Each
 * id is asked once per `asked` map (main keeps one per waiting scan).
 */
export const importCoverOf = (
  client: () => Promise<Pick<MetadataClient, "musicCover">>,
  asked: Map<string, Promise<string | null>>,
  id: unknown,
  log: Log
): Promise<string | null> => {
  if (typeof id !== "string" || !PARROT_MUSIC_ID.test(id)) return Promise.resolve(null);
  let cover = asked.get(id);
  if (!cover) {
    cover = (async () => {
      const startedAt = Date.now();
      try {
        const lookup = await client();
        const { cover: found } = await retried("cover", log, () => lookup.musicCover(id, 500));
        log(`[import] cover ${id}: ${found ? "found" : "none in any source"} in ${Date.now() - startedAt} ms`);
        return found ? `data:${found.mime};base64,${found.base64}` : null;
      } catch (error) {
        log(`[import] cover ${id} lookup failed: ${error instanceof Error ? error.message : String(error)}`);
        // A failed lookup is asked again next time; a cover that does not exist is not.
        asked.delete(id);
        return null;
      }
    })();
    asked.set(id, cover);
  }
  return cover;
};
