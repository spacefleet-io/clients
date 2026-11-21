/**
 * @test-id MOBILE-LIBRARY-SHOW-EPISODE-REFRESH-IDS-001
 * @level unit
 *
 * LIB-SHOW-01: when the desktop refreshes a running show, it sends the show again as a `media.upsert`
 * op carrying the old episodes with their stored ids plus the new ones. The phone (and the TV, which
 * runs this same library code) rewrites its episode rows from that op; this proves the rewrite keeps
 * the ids it was sent, so the resume points and watched state keyed by episode id stay attached and the
 * new episode shows up.
 *
 * Drives the real LibraryDb over real in-memory SQLite dbs (node:sqlite).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { LibraryDb } from "../src/lib/libraryDb";
import { buildEpisodeResumeValue } from "@space/shared/playbackResume";
import { getViewingScope } from "../src/lib/profiles/activeViewingScope";
import { scopedEpisodeResumeKey } from "@space/shared/profileViewing";
import { fx, resetFixture, seedSplitCache, setServer, settingOp, settle, sqliteRows } from "./library-db-fixture";

const TAG = "[library-show-episode-refresh-ids]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => (await import("./library-db-fixture")).sqliteDbFilesMock());
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

const METADATA = "library.metadata.sqlite";
const SHOW = "show-1";

type Episode = { id: string; seasonNumber: number; episodeNumber: number; name: string; airDate: string | null };

const showUpsertOp = (id: string, episodes: Episode[]): LibraryOp =>
  ({
    id,
    type: "media.upsert",
    createdAt: "2026-10-29T00:00:00.000Z",
    payload: {
      details: {
        id: SHOW,
        type: "tv",
        title: "Running Show",
        originalTitle: null,
        originalLanguage: "en",
        overview: null,
        year: "2025",
        rating: null,
        posterPath: null,
        backdropPath: null,
        addedAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-29T00:00:00.000Z",
        hasFiles: true,
        progressPct: 0,
        lastWatchedAt: null,
        totalEpisodes: episodes.length,
        catalogId: 4242,
        genres: [],
        cast: [],
        trailers: [],
        seasons: [...new Set(episodes.map((episode) => episode.seasonNumber))].map((seasonNumber) => ({
          id: `season-${seasonNumber}`,
          seasonNumber,
          name: `Season ${seasonNumber}`,
          overview: null,
          posterPath: null,
          episodeCount: episodes.filter((episode) => episode.seasonNumber === seasonNumber).length,
          airDate: null,
        })),
        episodes: episodes.map((episode) => ({ ...episode, overview: null, stillPath: null })),
        files: [],
        formats: [],
        audioTracks: [],
        subtitles: [],
        chapters: [],
        skipMarkers: [],
      },
    },
  }) as unknown as LibraryOp;

const EP1: Episode = { id: "ep-s1e1", seasonNumber: 1, episodeNumber: 1, name: "Pilot", airDate: "2026-09-01" };
const EP2: Episode = { id: "ep-s1e2", seasonNumber: 1, episodeNumber: 2, name: "Second", airDate: "2026-09-08" };
const EP3: Episode = { id: "ep-s2e1", seasonNumber: 2, episodeNumber: 1, name: "New season", airDate: "2026-10-28" };

type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & { secondaryOpsInFlight: Promise<void> | null };

const episodeRows = () =>
  sqliteRows(METADATA, "SELECT id, season_number, episode_number, title FROM media_episodes WHERE media_id = ? ORDER BY season_number, episode_number;", SHOW);

beforeEach(() => {
  resetFixture();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("a refreshed show reaching the phone keeps its episode ids (LIB-SHOW-01)", () => {
  // @req LIB-SHOW-01[badger-mobile,badger-tv]
  it("adds the new episode and keeps the resume point of an episode already watched", async () => {
    seedSplitCache({ version: 3 });
    const resumeKey = scopedEpisodeResumeKey(getViewingScope(), EP1.id);
    setServer({
      version: 6,
      snapshotVersion: 3,
      ops: [
        { opId: "op-4", version: 4, op: showUpsertOp("op-4", [EP1, EP2]) },
        { opId: "op-5", version: 5, op: settingOp(
            "op-5",
            resumeKey,
            buildEpisodeResumeValue({ progressPct: 40, positionSeconds: 600, durationSeconds: 1500, updatedAt: "2026-10-20T00:00:00.000Z" })
          ) },
        // The desktop's background refresh: same ids for S1, one new episode in a new season.
        { opId: "op-6", version: 6, op: showUpsertOp("op-6", [EP1, EP2, EP3]) },
      ],
    });

    const db = (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
    await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
    await settle(db);

    const rows = episodeRows();
    const resume = await db.getEpisodeResumeMap(SHOW);
    log("after refresh op", { rows, resumeKey, resume });
    expect(rows.map((row) => row.id)).toEqual([EP1.id, EP2.id, EP3.id]);
    expect(rows[2]).toMatchObject({ season_number: 2, episode_number: 1, title: "New season" });
    expect(resume[EP1.id], "the watched episode's resume point still matches its row").toMatchObject({ progressPct: 40, positionSeconds: 600 });
  });
});
