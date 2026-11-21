// PAR-UP-08 "Wrong album? Search": what main asks our music library for, apart from Electron so it can be tested with
// a fake client. A search answers as soon as its albums are known; covers are asked afterwards, one per album
// (`importCoverOf`), so a slow cover never holds the answer back. Every lookup refused as busy (429, 503) is asked
// again after the service's Retry-After (`withLookupRetry`).

import { withLookupRetry, type MetadataClient } from "@space/metadata-client";
import type { ParrotImportFoundAlbum } from "../shared/ipc";

/** How many albums one search shows (PAR-UP-08): one screen of covers. */
export const IMPORT_SEARCH_LIMIT = 8;

type Log = (line: string) => void;
type SearchClient = Pick<MetadataClient, "musicAlbums">;

/** A lookup asked again when the service says it is busy; each wait is logged (no title, no name). */
const retried = <T>(what: string, log: Log, task: () => Promise<T>) =>
  withLookupRetry(task, {
    onRetry: (seconds, attempt, error) => log(`[import] ${what}: service busy (${error.status}${error.code ? ` ${error.code}` : ""}), try ${attempt} in ${seconds}s`),
  });

/** "Wrong album? Search": the albums matching what the user typed, with their full tracklists; covers come later. */
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
