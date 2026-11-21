/**
 * @test-id MOBILE-LIBRARY-SHOW-WATCHED-PCT-001
 * @level unit (real LibraryDb over the shared fixture)
 * @bugfix @regression-proof Chris 2026-10-29 (TV testing): "a tv show's \"watched\" percentage shouldn't be counted off
 * the episodes uploaded to the vault but rather out of all available episodes".
 *
 * The phone and the TV store a show's watched percentage in `media_items.progress_pct` (and the `media.progress` op)
 * on every episode save; the TV poster bar and the phone's details read it. It must be the regular episodes' watched
 * parts over every AIRED regular episode of the show (LIB-PROG-01): specials and announced episodes never count, even
 * though the catalog's `number_of_episodes` (`total_episodes`) includes the announced ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import { fx, resetFixture, seedSplitCache, setServer } from "./library-db-fixture";

const TAG = "[library-show-watched-pct]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// 3 specials, 10 aired regular episodes (s1e1..s1e10), 4 announced for 2099; the catalog's count says 14.
// The pre-fix formula gave 300/14 ≈ 21.4 (total_episodes) and 300/17 ≈ 17.6 (every listed row, specials included).
const store = vi.hoisted(() => {
  const episodes: Array<{ id: string; season_number: number; air_date: string }> = [];
  for (let e = 1; e <= 3; e += 1) episodes.push({ id: `s0e${e}`, season_number: 0, air_date: "2019-12-01" });
  for (let e = 1; e <= 10; e += 1) episodes.push({ id: `s1e${e}`, season_number: 1, air_date: `2020-01-${String(e).padStart(2, "0")}` });
  for (let e = 1; e <= 4; e += 1) episodes.push({ id: `s2e${e}`, season_number: 2, air_date: "2099-01-01" });
  return { settings: new Map<string, string>(), mediaUpdates: [] as unknown[][], episodes, totalEpisodes: 14 as number | null };
});

// vi.mock factories are hoisted above the static imports, so they load the fixture with `await import()`.
vi.mock("react-native", async () => ({ ...(await import("./setup/reactNativeMock")).reactNativeBase(), Platform: { OS: "ios" } }));
vi.mock("react-native-fs", async () => ({ default: (await import("./library-db-fixture")).fakeRnfs }));
vi.mock("react-native-sqlite-storage", () => ({ default: { enablePromise: () => undefined } }));
vi.mock("react-native-quick-crypto", async () => (await import("./library-db-fixture")).quickCryptoMock());
vi.mock("@space/shared/api", async (importOriginal) =>
  (await import("./library-db-fixture")).sharedApiMock(await importOriginal<typeof SharedApi>())
);
vi.mock("../src/lib/library/transport", async () => (await import("./library-db-fixture")).transportMock());
vi.mock("../src/lib/library/dbFiles", async () => {
  const fixture = await import("./library-db-fixture");
  const base = fixture.dbFilesMock();
  const rows = (list: Record<string, unknown>[]) => ({ length: list.length, item: (i: number) => list[i] });

  class ShowDb extends fixture.FakeDb {
    async executeSql(sql: string, params: unknown[] = []) {
      const result = await super.executeSql(sql, params);
      if (/^\s*INSERT INTO app_settings/i.test(sql)) {
        store.settings.set(String(params[0]), String(params[1]));
        return [{ rows: rows([]), rowsAffected: 1 }];
      }
      if (/SELECT key, value FROM app_settings WHERE key LIKE/i.test(sql)) {
        const prefix = String(params[0]).replace(/%$/, "");
        return [{ rows: rows([...store.settings].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))) }];
      }
      if (/UPDATE media_items SET progress_pct/i.test(sql)) store.mediaUpdates.push(params);
      // The pre-fix query, kept so the red run measures the old formula rather than an empty table.
      if (/SELECT COUNT\(\*\) AS n FROM media_episodes/i.test(sql)) return [{ rows: rows([{ n: store.episodes.length }]) }];
      if (/SELECT id FROM media_episodes WHERE media_id/i.test(sql)) return [{ rows: rows(store.episodes.map(({ id }) => ({ id }))) }];
      if (/SELECT id, season_number, air_date FROM media_episodes/i.test(sql)) return [{ rows: rows(store.episodes) }];
      if (/SELECT type FROM media_items/i.test(sql)) return [{ rows: rows([{ type: "tv" }]) }];
      if (/SELECT total_episodes FROM media_items/i.test(sql)) return [{ rows: rows([{ total_episodes: store.totalEpisodes }]) }];
      return result;
    }

    async sqlBatch(statements: Array<[string, unknown[]]>) {
      await super.sqlBatch(statements);
      for (const [sql, params] of statements) {
        if (/INSERT (OR REPLACE )?INTO app_settings/i.test(sql)) store.settings.set(String(params[0]), String(params[1]));
      }
    }
  }

  const open = async (name: string) => {
    fixture.fx.nativeOpen.set(name, true);
    const handle = new ShowDb(name);
    fixture.fx.handles.push(handle);
    return handle;
  };
  return { ...base, openCoreDb: () => open("library.core.sqlite"), openMetadataDb: () => open("library.metadata.sqlite") };
});
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

beforeEach(() => {
  resetFixture();
  store.settings.clear();
  store.mediaUpdates.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  setServer({ version: 10, snapshotVersion: 10 });
  seedSplitCache({ version: 10 });
});

describe("a show's watched % counts every aired episode (LIB-PROG-01)", () => {
  for (const totalEpisodes of [14, null]) {
    // @req LIB-PROG-01
    it(`@bugfix @regression-proof 10 aired, 2 watched → 20% (total_episodes=${totalEpisodes}; specials and announced episodes left out)`, async () => {
      store.totalEpisodes = totalEpisodes;
      const db = await LibraryDb.open("token", "key");
      try {
        await db.setPlaybackProgress("show-1", "s1e1", 100, { positionSeconds: 1300, durationSeconds: 1300 });
        await db.setPlaybackProgress("show-1", "s1e2", 100, { positionSeconds: 1300, durationSeconds: 1300 });
        await db.setPlaybackProgress("show-1", "s0e1", 100, { positionSeconds: 1300, durationSeconds: 1300 });
        const last = store.mediaUpdates.at(-1);
        log("progress_pct writes", { totalEpisodes, writes: store.mediaUpdates.map((params) => params[0]) });
        expect(fx.remoteSnapshotFetches, "the local cache is current, no snapshot download").toBe(0);
        expect(last?.[0]).toBeCloseTo(20, 9);
      } finally {
        await db.close();
      }
    });
  }
});
