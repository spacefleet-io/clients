/**
 * @test-id MOBILE-LIBRARY-EPISODE-RESUME-SYNC-001
 * @level unit
 *
 * PLAY-RESUME-03: stopping on one device and opening the same title on another resumes at the same
 * spot, in both directions. Mobile shares desktop's `episode_resume_v1:<episodeId>` entry in the synced
 * `app_settings`, so the two halves are:
 *  - write: a progress save queues a `setting.set` op for that key (the op is what reaches desktop);
 *  - read: a `setting.set` op written by another device lands in `app_settings` through a remote sync
 *    and `getEpisodeResumeMap` + `resolveResumeCandidateSeconds` turn it into the "Resume at" offer.
 *
 * Drives the REAL `LibraryDb` over the shared fixture; the only addition is a tiny `app_settings`
 * table behind the fixture's core/metadata handles (the fixture's fake SQLite has no SQL engine).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import { LibraryDb } from "../src/lib/libraryDb";
import {
  buildEpisodeResumeValue,
  episodeResumeKey,
  parseEpisodeResumeValue,
  resolveResumeCandidateSeconds,
} from "@space/shared/playbackResume";
import { fx, resetFixture, seedSplitCache, setServer, settingOp, settle } from "./library-db-fixture";

const TAG = "[library-episode-resume-sync]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} ${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

// Rows the fake SQL answers with; shared across handles (one library per test).
const resumeStore = vi.hoisted(() => ({ settings: new Map<string, string>() }));

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
  const { settings } = resumeStore;
  const rows = (list: Record<string, unknown>[]) => ({ length: list.length, item: (i: number) => list[i] });

  class SettingsDb extends fixture.FakeDb {
    async executeSql(sql: string, params: unknown[] = []) {
      const base = await super.executeSql(sql, params);
      if (/^\s*INSERT INTO app_settings/i.test(sql)) {
        settings.set(String(params[0]), String(params[1]));
        return [{ rows: rows([]), rowsAffected: 1 }];
      }
      if (/SELECT key, value FROM app_settings WHERE key LIKE/i.test(sql)) {
        const prefix = String(params[0]).replace(/%$/, "");
        return [{ rows: rows([...settings].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value }))) }];
      }
      if (/SELECT id FROM media_episodes WHERE media_id/i.test(sql)) {
        return [{ rows: rows(["ep-1", "ep-2"].map((id) => ({ id }))) }];
      }
      if (/SELECT id, season_number, air_date FROM media_episodes/i.test(sql)) {
        return [{ rows: rows(["ep-1", "ep-2"].map((id) => ({ id, season_number: 1, air_date: null }))) }];
      }
      if (/SELECT type FROM media_items/i.test(sql)) return [{ rows: rows([{ type: "tv" }]) }];
      if (/SELECT total_episodes FROM media_items/i.test(sql)) return [{ rows: rows([{ total_episodes: null }]) }];
      return base;
    }

    async sqlBatch(statements: Array<[string, unknown[]]>) {
      await super.sqlBatch(statements);
      for (const [sql, params] of statements) {
        if (/INSERT (OR REPLACE )?INTO app_settings/i.test(sql)) settings.set(String(params[0]), String(params[1]));
      }
    }
  }

  const open = async (name: string) => {
    fx.nativeOpen.set(name, true);
    const handle = new SettingsDb(name);
    fx.handles.push(handle);
    return handle;
  };
  return {
    ...base,
    openCoreDb: () => open("library.core.sqlite"),
    openMetadataDb: () => open("library.metadata.sqlite"),
  };
});
vi.mock("../src/lib/library/snapshot", async () => (await import("./library-db-fixture")).snapshotMock());
vi.mock("../src/lib/crypto", async () => (await import("./library-db-fixture")).cryptoMock());
vi.mock("../src/lib/librarySchema", () => ({}));

const PENDING_OPS = "/docs/library/pending_ops.json";

// Pick<…, keyof …> drops the private members, which the seam below re-declares as public for the test.
type LibraryDbSeam = Pick<LibraryDb, keyof LibraryDb> & {
  secondaryOpsInFlight: Promise<void> | null;
  pendingOps: Array<{ id: string; type: string; payload: Record<string, unknown> }>;
  flushOps(): Promise<void>;
};

const openLocal = async () => (await LibraryDb.open("token", "key")) as unknown as LibraryDbSeam;
const queuedOnDisk = (): Array<{ id: string; type: string; payload: Record<string, unknown> }> =>
  JSON.parse(fx.files.get(PENDING_OPS) ?? "[]");

beforeEach(() => {
  resetFixture();
  resumeStore.settings.clear();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("episode resume sync (PLAY-RESUME-03)", () => {
  // @req PLAY-RESUME-03[badger-mobile,badger-tv]
  it("a progress save queues a setting.set op for the desktop-shared episode_resume_v1 key and uploads it", async () => {
    setServer({ version: 10, snapshotVersion: 10 });
    seedSplitCache({ version: 10 });
    fx.nextPutVersion = 11;
    const db = await openLocal();
    try {
      await db.setPlaybackProgress("show-1", "ep-1", 41, { positionSeconds: 900, durationSeconds: 2200 });
      await db.setPlaybackProgress("show-1", "ep-1", 42.5, { positionSeconds: 1020, durationSeconds: 2400 });
      const queued = queuedOnDisk().filter((op) => op.type === "setting.set");
      log("queued", queued.map((op) => ({ key: op.payload.key, value: op.payload.value })));
      expect(queued, "newest save for the episode supersedes the older queued one").toHaveLength(1);
      expect(queued[0]?.payload.key).toBe(episodeResumeKey("ep-1"));
      expect(queued[0]?.payload.key).toBe("episode_resume_v1:ep-1");
      const synced = parseEpisodeResumeValue(String(queued[0]?.payload.value));
      expect(synced).toMatchObject({ progressPct: 42.5, positionSeconds: 1020, durationSeconds: 2400 });

      await db.flushOps();
      expect(fx.putOpCalls, "the op is uploaded so the other device receives it").toBeGreaterThan(0);
      expect(queuedOnDisk().filter((op) => op.type === "setting.set")).toEqual([]);

      const map = await db.getEpisodeResumeMap("show-1");
      expect(map["ep-1"], "the phone reads back what it saved").toMatchObject({ progressPct: 42.5, positionSeconds: 1020 });
    } finally {
      await db.close();
    }
  });

  // @req PLAY-RESUME-03[badger-mobile,badger-tv]
  it("a resume written by another device arrives as a setting.set op and becomes the Resume offer", async () => {
    const desktopValue = buildEpisodeResumeValue({
      progressPct: 31.25,
      updatedAt: "2026-10-15T10:00:00.000Z",
      positionSeconds: 750,
      durationSeconds: 2400,
    });
    setServer({
      version: 12,
      snapshotVersion: 10,
      ops: [{ opId: "op-12", version: 12, op: settingOp("op-12", episodeResumeKey("ep-2"), desktopValue) }],
    });
    seedSplitCache({ version: 10 });
    const db = await openLocal();
    try {
      expect(await db.getEpisodeResumeMap("show-1"), "nothing known before the sync").toEqual({});
      const changed = await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
      await settle(db);
      expect(changed).toBe(true);
      const map = await db.getEpisodeResumeMap("show-1");
      log("map after sync", map);
      expect(map["ep-2"]).toMatchObject({ progressPct: 31.25, positionSeconds: 750, durationSeconds: 2400 });
      const entry = map["ep-2"]!;
      expect(resolveResumeCandidateSeconds(entry.progressPct, entry.durationSeconds, null, entry.positionSeconds)).toBe(750);
    } finally {
      await db.close();
    }
  });
});
