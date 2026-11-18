/**
 * @req INTG-DEL-01
 *
 * Deleting one episode (Kodi / Jellyfin integrations) must reclaim ONLY that episode's storage keys via
 * /storage/delete and drop only that episode's file, leaving the show and the other episodes playable.
 *
 * Runs under `bun test` like the other LibraryDb tests (bun:sqlite).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { LibraryDb } from "../src/libraryDb";

let root = "";
let deletedKeys: string[] = [];
let originalFetch: typeof globalThis.fetch | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sf-episode-delete-"));
  process.env.SF_USER_DATA_PATH = root;
  deletedKeys = [];
  originalFetch = globalThis.fetch;
  // The SDK calls fetch(Request) with one Request argument.
  globalThis.fetch = (async (input: Request): Promise<Response> => {
    if (input.method === "POST" && /\/storage\/delete(\?|$)/.test(input.url)) {
      const parsed = (await input.json()) as { keys?: string[] };
      deletedKeys.push(...(parsed.keys ?? []));
    }
    return new Response(JSON.stringify({ deleted: deletedKeys.length }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  rmSync(root, { recursive: true, force: true });
  delete process.env.SF_USER_DATA_PATH;
});

describe("deleteEpisode (INTG-DEL-01)", () => {
  it("@req INTG-DEL-01 forwards only the episode's keys to /storage/delete and removes only its file", async () => {
    const db = await LibraryDb.openLocal("test-token", "key");
    db.setSyncEnabled(false);
    const mediaId = await (db as any).addMediaFromTmdb({
      id: 9001,
      type: "tv",
      title: "Episode Delete Show",
      originalTitle: null,
      originalLanguage: "en",
      overview: null,
      year: "2026",
      rating: null,
      posterPath: null,
      backdropPath: null,
      genres: [],
      cast: [],
      trailers: [],
      seasons: [{ seasonNumber: 1, name: "Season 1", overview: null, posterPath: null, airDate: null }],
      episodes: [
        { seasonNumber: 1, episodeNumber: 1, name: "One", overview: null, stillPath: null, airDate: null },
        { seasonNumber: 1, episodeNumber: 2, name: "Two", overview: null, stillPath: null, airDate: null },
      ],
      totalEpisodes: 2,
    });

    const seedEpisode = async (episode: number) => {
      const fileId = await db.linkFileToMedia(mediaId, `s01e0${episode}.mkv`, 1, episode);
      await db.addMediaFormat(mediaId, fileId, "1080p", "h264", 1024, [{ key: `e${episode}/v/chunk-1`, sizeBytes: 1000 }], 8000, {
        initKey: `e${episode}/v/init`,
        initSize: 100,
        durationSeconds: 60,
        totalSize: 1100,
      });
      await (db as any).addAudioTrackWithChunks({
        mediaId,
        fileId,
        season: 1,
        episode,
        language: "en",
        label: "English",
        codec: "aac",
        initKey: `e${episode}/a/init`,
        initSize: 10,
        durationSeconds: 60,
        totalSize: 110,
        chunks: [{ key: `e${episode}/a/chunk-1`, sizeBytes: 100 }],
      });
      await (db as any).addSubtitleTrackWithObject({
        mediaId,
        fileId,
        season: 1,
        episode,
        language: "en",
        label: "English",
        objectKey: `e${episode}/s/sub-1`,
        format: "vtt",
      });
      return fileId;
    };
    await seedEpisode(1);
    await seedEpisode(2);

    const before = db.getMediaDetails(mediaId)!;
    const target = before.episodes.find((entry) => entry.episodeNumber === 2)!;

    const result = await db.deleteEpisode(mediaId, target.id);

    expect(result.deletedFile).toBe(true);
    expect(deletedKeys.sort()).toEqual(["e2/a/chunk-1", "e2/a/init", "e2/s/sub-1", "e2/v/chunk-1", "e2/v/init"]);
    const after = db.getMediaDetails(mediaId)!;
    expect(after.files.map((file) => file.episode)).toEqual([1]);
    expect(after.formats.every((format) => format.initKey?.startsWith("e1/"))).toBe(true);
    expect(after.audioTracks.every((track) => track.initKey?.startsWith("e1/"))).toBe(true);
    expect(after.subtitleTracks.every((track) => track.objectKey?.startsWith("e1/"))).toBe(true);
    expect(after.episodes).toHaveLength(2);

    const again = await db.deleteEpisode(mediaId, target.id);
    expect(again.deletedFile).toBe(false);
    db.close();
  });
});
