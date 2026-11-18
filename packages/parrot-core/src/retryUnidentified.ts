/**
 * Songs kept as is (PAR-UP-05, issue #2531): a song imported unidentified, most often because the music lookup could
 * not be reached, is matched again on its own, without a button press. Each album's unidentified songs are asked
 * together, as one folder, with the library's albums as context (PAR-META-03): an owned album with that slot empty
 * pulls the song in, a slot the library already fills never confirms. Only a confident match moves a song; any other
 * outcome leaves it as it is, to be asked again in a later session.
 */
import type { MusicAlbum, MusicAlbumsQuery, MusicRecording, MusicRecordingsQuery } from "@space/shared/api";
import { parseParrotTracklist } from "@space/parrot-library-db-definition";
import { matchParrotImport, type ParrotImportFileQuestion, type ParrotImportLibraryAlbum, type ParrotImportMatchWeights } from "./importMatch";
import type { ParrotLibraryQuery, ParrotTrackPlacement } from "./manage";
import { IMPORT_LIBRARY_ALBUMS_SQL, IMPORT_LIBRARY_SLOTS_SQL } from "./queries";

/** One album's songs every 1.5 s, as the other lookup passes: well under the ticket and per-connection limits. */
export const PARROT_RETRY_UNIDENTIFIED_GAP_MS = 1500;

/** The unidentified songs with what matching asks with: their names, album, length and place. */
export const PARROT_UNIDENTIFIED_TRACKS_SQL = `SELECT t.id AS id, t.album_id AS albumId, t.disc AS disc, t.number AS number, t.title AS title,
       t.duration_ms AS durationMs, COALESCE(ar.name, '') AS artist, COALESCE(al.title, '') AS album, COALESCE(aa.name, '') AS albumArtist
  FROM tracks t LEFT JOIN artists ar ON ar.id = t.artist_id LEFT JOIN albums al ON al.id = t.album_id
  LEFT JOIN artists aa ON aa.id = al.album_artist_id
 WHERE t.unidentified = 1 ORDER BY t.album_id, t.disc, t.number, t.id`;

type UnidentifiedRow = {
  id: string;
  albumId: string;
  disc: number;
  number: number | null;
  title: string;
  durationMs: number | null;
  artist: string;
  album: string;
  albumArtist: string;
};

/** The library's albums with a known tracklist and the slots its placed songs fill, as matching takes them. */
export const parrotImportLibraryAlbums = async (query: ParrotLibraryQuery): Promise<ParrotImportLibraryAlbum[]> => {
  const slots = new Map<string, Array<{ disc: number; number: number }>>();
  for (const slot of await query<{ albumId: string; disc: number; number: number }>(IMPORT_LIBRARY_SLOTS_SQL)) {
    slots.set(slot.albumId, [...(slots.get(slot.albumId) ?? []), { disc: slot.disc, number: slot.number }]);
  }
  const albums: ParrotImportLibraryAlbum[] = [];
  for (const row of await query<{ id: string; musicId: string | null; title: string; artist: string; tracklist: string | null }>(IMPORT_LIBRARY_ALBUMS_SQL)) {
    const tracklist = parseParrotTracklist(row.tracklist);
    if (tracklist && row.artist) albums.push({ musicId: row.musicId, title: row.title, artist: row.artist, tracklist, owned: slots.get(row.id) ?? [] });
  }
  return albums;
};

export type ParrotRetryUnidentifiedReport = {
  /** Songs asked about this pass. */
  asked: number;
  /** Moved onto their matched track. */
  placed: number;
  /** Matched, but not confidently (or onto a filled slot): left as they are. */
  unsure: number;
  /** Nothing likely enough. */
  none: number;
  /** The lookup failed for them; the pass stopped there. */
  failed: number;
  stopped: boolean;
};

export type ParrotRetryUnidentifiedArgs = {
  /** Read fresh for each album, so a song the user edited or deleted meanwhile is not asked. */
  query: () => ParrotLibraryQuery;
  recordings: (question: MusicRecordingsQuery) => Promise<{ results: MusicRecording[] }>;
  albums: (question: MusicAlbumsQuery) => Promise<{ results: MusicAlbum[] }>;
  /** Keeps confident placements in the library (plans and publishes them); a refusal stops the pass. */
  publish: (placements: ParrotTrackPlacement[]) => Promise<boolean>;
  /** Songs already asked this session, filled by the pass: a song is asked once per session. */
  tried: Set<string>;
  sleep: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Stops the pass between albums (sign-out, app quit). */
  signal?: AbortSignal;
  gapMs?: number;
  weights?: Partial<ParrotImportMatchWeights>;
};

/** Runs one pass over the unidentified songs not asked this session; resolves with what it did. */
export const runParrotRetryUnidentified = async (args: ParrotRetryUnidentifiedArgs): Promise<ParrotRetryUnidentifiedReport> => {
  const log = args.log ?? (() => {});
  const report: ParrotRetryUnidentifiedReport = { asked: 0, placed: 0, unsure: 0, none: 0, failed: 0, stopped: false };
  const groups = new Map<string, UnidentifiedRow[]>();
  for (const row of await args.query()<UnidentifiedRow>(PARROT_UNIDENTIFIED_TRACKS_SQL)) {
    if (!args.tried.has(row.id)) groups.set(row.albumId, [...(groups.get(row.albumId) ?? []), row]);
  }
  let first = true;
  for (const [albumId, rows] of groups) {
    if (args.signal?.aborted) {
      report.stopped = true;
      break;
    }
    if (!first) await args.sleep(args.gapMs ?? PARROT_RETRY_UNIDENTIFIED_GAP_MS);
    first = false;
    const query = args.query();
    const still = new Set((await query<{ id: string }>(PARROT_UNIDENTIFIED_TRACKS_SQL)).map((row) => row.id));
    const songs = rows.filter((row) => still.has(row.id));
    if (songs.length === 0) continue;
    // The song's album is its folder: the songs kept as is together are asked together, as their import would.
    const fileOf = (row: UnidentifiedRow) => `${albumId}/${row.id}`;
    const questions: ParrotImportFileQuestion[] = songs.map((row) => ({
      file: fileOf(row),
      title: row.title,
      artist: row.artist,
      album: row.album,
      durationMs: row.durationMs,
      disc: row.disc,
      number: row.number ?? 0,
      ...(row.albumArtist && row.albumArtist !== row.artist ? { albumArtist: row.albumArtist } : {}),
    }));
    const trackOf = new Map(songs.map((row) => [fileOf(row), row.id]));
    const result = await matchParrotImport(questions, {
      recordings: args.recordings,
      albums: args.albums,
      lanes: 1,
      log,
      library: await parrotImportLibraryAlbums(query),
      ...(args.weights ? { weights: args.weights } : {}),
    });
    const failedFiles = new Set(result.unidentified.filter((file) => file.reason === "lookup-failed").map((file) => file.file));
    const failed = failedFiles.size;
    if (failed === songs.length) {
      // The lookup is still out of reach: these songs and the rest wait for a later session.
      report.failed += failed;
      report.stopped = true;
      log(`[retry-unidentified] album ${albumId}: the lookup failed, stopping until a later session`);
      break;
    }
    // A song the lookup failed for is asked again on the next pass.
    for (const row of songs) if (!failedFiles.has(fileOf(row))) args.tried.add(row.id);
    report.asked += songs.length;
    report.failed += failed;
    report.none += result.unidentified.length - failed;
    const placements: ParrotTrackPlacement[] = [];
    for (const matched of result.albums) {
      for (const placed of matched.files) {
        const trackId = trackOf.get(placed.file);
        if (!trackId) continue;
        if (!placed.sure || !matched.tracklistKnown) {
          report.unsure += 1;
          log(`[retry-unidentified] ${trackId}: ${matched.album.title} ${placed.disc}-${placed.number} not sure (${placed.confidence?.toFixed(3) ?? "?"}), left as is`);
          continue;
        }
        placements.push({ trackId, album: matched.album, disc: placed.disc, number: placed.number });
        log(`[retry-unidentified] ${trackId}: ${matched.album.title} ${placed.disc}-${placed.number} (${placed.confidence?.toFixed(3) ?? "?"})`);
      }
    }
    if (placements.length === 0) continue;
    if (!(await args.publish(placements))) {
      report.stopped = true;
      break;
    }
    report.placed += placements.length;
  }
  return report;
};
