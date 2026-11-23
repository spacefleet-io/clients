/**
 * @test-id MOBILE-LIBRARY-PROFILE-SETTINGS-SYNC-001
 * @level unit
 * @bugfix
 * @regression-proof
 *
 * Why this exists (review of PR 836): a profile's settings value `[p:<pid>:]profile_settings_v1` travelled as one
 * whole `setting.set`, newest wins. Three ways that lost a profile's settings:
 *  - the phone seeds the fields its profile never had when the library opens, BEFORE the first sync; the seed was
 *    stamped "now", so the real, older value another device saved was refused here and the seed then replaced it
 *    on every other device;
 *  - two devices editing different fields: the later whole value carried the other field's old value and won;
 *  - deleting the main profile moved the new main's value into `profile_settings_v1`, and a field-by-field merge
 *    would have kept the deleted main's fields.
 * Settings now merge field by field (`mergeProfileSettingsOps`, Main 2026-10-30) and a seed is stamped with the
 * epoch (`PROFILE_SETTINGS_SEED_AT`).
 *
 * Drives the real LibraryDb over real in-memory SQLite (node:sqlite) and a fake library server.
 *
 * @req ACCT-SQUAD-03[badger-mobile,badger-tv]
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SharedApi from "@space/shared/api";
import type { LibraryOp } from "@space/shared/libraryOps";
import { decodeCompressedFrame } from "@space/library-db-definition/payloadCompression";
import {
  PROFILE_SETTINGS_SEED_AT,
  mergeProfileSettings,
  mergeProfileSettingsOps,
  parseProfileSettings,
  profileSettingsSeedAt,
  readProfileSettingsRow,
  serializeProfileSettings,
} from "@space/shared/profileSettings";
import { MAIN_VIEWING_SCOPE, viewingScopeFor } from "@space/shared/profileViewing";
import { LibraryDb } from "../src/lib/libraryDb";
import { fflateCodec } from "@space/mobile-shell/libraryOps";
import { setViewingScope } from "../src/lib/profiles/activeViewingScope";
import { fx, resetFixture, seedSplitCache, setServer, settle, sqliteFile } from "./library-db-fixture";

const TAG = "[library-profile-settings-sync]";
const log = (phase: string, data?: unknown) =>
  console.info(`${TAG} phase=${phase}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`);

vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
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

const CORE = "library.core.sqlite";
const PENDING_OPS = "/docs/library/pending_ops.json";
const KEY = "profile_settings_v1";
const KIDS = viewingScopeFor({ id: "kids", isMain: false });

const setOp = (id: string, key: string, value: string, updatedAt: string): Extract<LibraryOp, { type: "setting.set" }> => ({
  id,
  type: "setting.set",
  createdAt: updatedAt,
  payload: { key, value, updatedAt },
});

/** The last `setting.set` of `key` this phone uploaded or still queues: what the other devices receive. */
const queued = (key: string) => {
  const posted = fx.postedOps.map(
    (bytes) => JSON.parse(new TextDecoder().decode(decodeCompressedFrame(bytes, fflateCodec))) as LibraryOp
  );
  const pending = JSON.parse(fx.files.get(PENDING_OPS) ?? "[]") as LibraryOp[];
  const ops = [...posted, ...pending].filter((op) => op.type === "setting.set" && op.payload.key === key);
  const last = ops.at(-1);
  if (last?.type !== "setting.set") throw new Error(`nothing queued for ${key}`);
  return last;
};

/** Another device holding `row` receives `op`: the value it ends up with. */
const elsewhere = (row: { value: string; updatedAt: string }, op: LibraryOp, key = KEY) => {
  const [folded] = mergeProfileSettingsOps([op], new Map([[key, row]]));
  return folded?.type === "setting.set" ? folded.payload.value : null;
};

const openAndSync = async (ops: LibraryOp[], beforeSync?: (db: LibraryDb) => Promise<void>) => {
  setServer({ version: 12, snapshotVersion: 10, ops: ops.map((op, i) => ({ opId: op.id, version: 11 + i, op })) });
  const db = await LibraryDb.open("token", "key");
  if (beforeSync) await beforeSync(db);
  await db.syncFromRemoteIfNewer(fx.meta ?? undefined);
  await settle(db);
  return db;
};

beforeEach(() => {
  resetFixture();
  setViewingScope(MAIN_VIEWING_SCOPE);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  seedSplitCache({ version: 10 });
});

describe("profile settings sync between devices (ACCT-SQUAD-03)", () => {
  it("@req ACCT-SQUAD-03 @bugfix a seed made before the first sync never beats the real, older value of another device", async () => {
    const realAt = "2026-10-15T00:00:00.000Z";
    const real = JSON.stringify({ autoplayNextEpisode: false, quality: "720p", forceQuality: true, updatedAt: realAt });
    const db = await openAndSync([setOp("op-real", KEY, real, realAt)], async (opened) => {
      log("seed-before-sync");
      await opened.setProfileSettings(
        { autoplayNextEpisode: true, quality: "1080p", forceQuality: false, autoSkipIntro: false },
        MAIN_VIEWING_SCOPE,
        { updatedAt: PROFILE_SETTINGS_SEED_AT }
      );
    });
    try {
      const here = await db.getProfileSettings(MAIN_VIEWING_SCOPE);
      const row = sqliteFile(CORE).prepare("SELECT value, updated_at FROM app_settings WHERE key = ?;").get(KEY);
      log("after-sync", { here, row });
      expect(here, "the real value wins here").toMatchObject({ autoplayNextEpisode: false, quality: "720p", forceQuality: true });
      expect(here?.autoSkipIntro, "a field only the seed had stays").toBe(false);

      const upload = queued(KEY);
      const there = parseProfileSettings(elsewhere({ value: real, updatedAt: realAt }, upload));
      log("other-device", { upload: upload.payload, there });
      expect(there, "the real value wins on the other devices too").toMatchObject({
        autoplayNextEpisode: false,
        quality: "720p",
        forceQuality: true,
      });
    } finally {
      await db.close();
    }
  });

  it("@req ACCT-SQUAD-03 @bugfix two devices editing different fields both keep their edit", async () => {
    const tvValue = serializeProfileSettings(
      mergeProfileSettings(
        mergeProfileSettings(null, { autoplayNextEpisode: true }, "2026-01-01T00:00:00.000Z"),
        { quality: "720p" },
        "2099-01-01T00:00:00.000Z"
      )
    );
    const db = await openAndSync([setOp("op-tv", KEY, tvValue, "2099-01-01T00:00:00.000Z")], async (opened) => {
      log("phone-edit");
      await opened.setProfileSettings({ autoplayNextEpisode: false }, MAIN_VIEWING_SCOPE);
    });
    try {
      const here = await db.getProfileSettings(MAIN_VIEWING_SCOPE);
      log("after-sync", here);
      expect(here).toMatchObject({ autoplayNextEpisode: false, quality: "720p" });
      const there = parseProfileSettings(elsewhere({ value: tvValue, updatedAt: "2099-01-01T00:00:00.000Z" }, queued(KEY)));
      log("tv-after-upload", there);
      expect(there).toMatchObject({ autoplayNextEpisode: false, quality: "720p" });
    } finally {
      await db.close();
    }
  });

  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 deleting the main profile replaces its settings on the other devices, field merge or not", async () => {
    const db = await openAndSync([]);
    try {
      await db.setProfileSettings({ quality: "2160p", skipMode: "manual" }, MAIN_VIEWING_SCOPE);
      const oldMain = sqliteFile(CORE).prepare("SELECT value, updated_at FROM app_settings WHERE key = ?;").get(KEY) as {
        value: string;
        updated_at: string;
      };
      await db.setProfileSettings({ quality: "480p" }, KIDS);
      await db.promoteProfileToMain("kids");
      const upload = queued(KEY);
      const there = elsewhere({ value: oldMain.value, updatedAt: oldMain.updated_at }, upload);
      log("promotion", { upload: upload.payload, there });
      expect(parseProfileSettings(there)?.quality).toBe("480p");
      expect(parseProfileSettings(there)?.skipMode, "the deleted main's own field is gone everywhere").toBeUndefined();
    } finally {
      await db.close();
    }
  });

  it("@req ACCT-SQUAD-03 @req ACCT-PROF-02 @bugfix promoting a profile with no settings: two devices seeding different values end identical", async () => {
    const db = await openAndSync([]);
    try {
      // The old main's settings were saved well before the move (a field set in the very millisecond of the move survives it).
      await db.setProfileSettings({ quality: "2160p", skipMode: "manual" }, MAIN_VIEWING_SCOPE, { updatedAt: "2026-10-01T00:00:00.000Z" });
      const oldMain = sqliteFile(CORE).prepare("SELECT value, updated_at FROM app_settings WHERE key = ?;").get(KEY) as {
        value: string;
        updated_at: string;
      };
      await db.promoteProfileToMain("kids");
      const promotion = queued(KEY);
      if (promotion.type !== "setting.set") throw new Error("unreachable");
      log("promotion-of-empty", promotion.payload);
      expect(promotion.payload.value, "fixture sanity: the kids profile had no settings, so the move blanks the key").toBe("");

      // This phone seeds 720p through the real LibraryDb.
      const stored = await db.getProfileSettings(MAIN_VIEWING_SCOPE);
      log("phone-reads-blank", stored);
      expect(stored?.resetAt, "a blank row reads as a set reset at the row's time").toBe(promotion.payload.updatedAt);
      await db.setProfileSettings({ quality: "720p" }, MAIN_VIEWING_SCOPE, { updatedAt: profileSettingsSeedAt(stored) });
      const phoneSeed = queued(KEY);

      // The TV held the old main, receives the move, then seeds 2160p the same way.
      const tvRow = { value: oldMain.value, updatedAt: oldMain.updated_at };
      const [moved] = mergeProfileSettingsOps([promotion], new Map([[KEY, tvRow]]));
      if (moved?.type !== "setting.set") throw new Error("unreachable");
      const tvStored = readProfileSettingsRow(moved.payload.value, moved.payload.updatedAt);
      const tvSeeded = mergeProfileSettings(tvStored, { quality: "2160p" }, profileSettingsSeedAt(tvStored));
      const tvSeed = setOp("tv-seed", KEY, serializeProfileSettings(tvSeeded), tvSeeded.updatedAt);

      log("exchange");
      await (db as unknown as { applyLibraryOps(ops: LibraryOp[]): Promise<void> }).applyLibraryOps([tvSeed]);
      const onPhone = sqliteFile(CORE).prepare("SELECT value FROM app_settings WHERE key = ?;").get(KEY) as { value: string };
      const [onTv] = mergeProfileSettingsOps([phoneSeed], new Map([[KEY, { value: tvSeed.payload.value, updatedAt: tvSeeded.updatedAt }]]));
      const [onThird] = mergeProfileSettingsOps([promotion, phoneSeed, tvSeed], new Map([[KEY, tvRow]]));
      const [onFourth] = mergeProfileSettingsOps([promotion, tvSeed, phoneSeed], new Map([[KEY, tvRow]]));
      const valueOf = (op: LibraryOp | undefined) => (op?.type === "setting.set" ? op.payload.value : null);
      log("after-exchange", { phone: onPhone.value, tv: valueOf(onTv), third: valueOf(onThird), fourth: valueOf(onFourth) });
      expect(parseProfileSettings(onPhone.value)?.quality, "the seeds survive the reset").toBeDefined();
      expect(parseProfileSettings(onPhone.value)?.skipMode, "the deleted main's field stays gone").toBeUndefined();
      for (const value of [valueOf(onTv), valueOf(onThird), valueOf(onFourth)]) expect(value).toBe(onPhone.value);
    } finally {
      await db.close();
    }
  });
});
